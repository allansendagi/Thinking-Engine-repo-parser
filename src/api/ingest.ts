import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CaptureProvenance, Role } from "../types";
import {
  dropRetractedProvisional,
  loadCanonicalStatuses,
  loadConversationFingerprints,
  loadIdeas,
} from "../db/queries";
import {
  runPipeline,
  persistPipelineResult,
  persistCanonicalEvents,
  type PipelineProviders,
} from "../state/pipeline";
import { replayDiscardedEvents } from "../state/replayDiscarded";
import { canonicalize, type IntegrityIssue, type RawObservation } from "../state/canonicalize";
import {
  resolveConversationIdentity,
  type ConversationIdentity,
  type IdentityConflict,
  type IdentityStatus,
} from "../state/resolveConversationIdentity";
import { recordEvidence } from "../db/evidence";

/**
 * How many COMMITTED events a conversation needs before identity resolution stops re-running on
 * every flush. Below this, each observation is still checked -- a fork feeds in turn by turn, and
 * its first turn ("let me continue our earlier chat about X") is too short to trip the strong
 * fingerprint match; only once it has echoed enough of the parent's verbatim content does the
 * contradiction show. Above this, the conversation has established its own identity (a fork could
 * no longer masquerade as it) and the per-flush fingerprint scan is pure cost.
 */
const IDENTITY_SETTLE_MIN_COMMITTED = 5;

export interface IncomingMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
}

export interface IngestConversationInput {
  conversationId: string;
  source: CanonicalEvent["source"];
  /** The full transcript known so far, not just what's new -- see module doc. */
  messages: IncomingMessage[];
  /**
   * Canonical URL of the conversation (origin + path). Optional -- the extension sends it, paste
   * has none. Applied to every canonical event of this conversation; a null here never clears a
   * URL a prior call already stored (COALESCE in persistPipelineResult).
   */
  sourceUrl?: string | null;
  /**
   * How this conversation was captured + how much to trust that capture. Optional -- an older
   * client omits it. Applied to every canonical event; a null here never clears a value a prior
   * call stored (COALESCE in persistPipelineResult). The handler validates the shape before this
   * point. See THREAD.md §7.
   */
  capture?: CaptureProvenance | null;
}

export interface IngestResult {
  newCanonicalEvents: number;
  /** Grounded events the signal gate PROMOTED to ideas this call. */
  newCognitiveEvents: number;
  /** Grounded events the signal gate declined to persist (stored for replay, not attached). */
  discardedEvents: number;
  /** Earlier discards this call promoted into ideas because the idea they belong to now exists. */
  promotedFromDiscard: number;
  rejectedExtractions: number;
  ideaCount: number;
  /**
   * The canonicalizer's structural verdict on THIS observation -- `true` when nothing was
   * dropped. Advisory issues (a timestamp regression, an all-one-role transcript) don't flip it.
   * Not surfaced to the user; the Mac app can use it as a sensor-health signal.
   */
  integrityOk: boolean;
  /** Structure-validation issues found in this observation, if any. */
  integrityIssues: IntegrityIssue[];
  /**
   * Canonical events this call PARKED as provisional -- stored and used as context, but held
   * back from the idea graph until a clean observation corroborates them. See CanonicalEventStatus.
   */
  provisionalEvents: number;
  /** Previously-provisional events this call PROMOTED to committed (a clean observation saw them). */
  promotedEvents: number;
  /** Provisional rows dropped because a newer clean full observation no longer listed them. */
  retractedProvisional: number;
  /**
   * Conversation-identity verdict for THIS observation. `unresolved` means a strong lower-tier
   * contradiction (content fingerprint points at a different conversation than the sensor's id)
   * -- the events are parked provisional and attached to nothing. See resolveConversationIdentity.
   */
  identityStatus: IdentityStatus;
  /** Identity contradictions found -- a `strong_content_mismatch` is what forces `unresolved`. */
  identityConflicts: IdentityConflict[];
}

/**
 * Incremental ingestion for one conversation. Safe to call repeatedly with a growing message list
 * -- e.g. every time a browser extension observes a new turn, it resends the full transcript it
 * has so far, not a diff. Already-seen messages (by id, checked against this user's DB) are sent
 * to extraction as context only, never re-extracted -- so calling this 50 times as a conversation
 * grows produces the same result as calling it once at the end, not 50x duplicated ideas.
 */
export async function ingestConversation(
  db: Database,
  input: IngestConversationInput,
  providers: PipelineProviders,
): Promise<IngestResult> {
  const existingIdeaCount = () => loadIdeas(db).length;
  const zeros = {
    newCanonicalEvents: 0,
    newCognitiveEvents: 0,
    discardedEvents: 0,
    promotedFromDiscard: 0,
    rejectedExtractions: 0,
    provisionalEvents: 0,
    promotedEvents: 0,
    retractedProvisional: 0,
    identityConflicts: [] as IdentityConflict[],
  };

  if (input.messages.length === 0) {
    return {
      ...zeros,
      ideaCount: existingIdeaCount(),
      integrityOk: true,
      integrityIssues: [],
      identityStatus: "resolved",
    };
  }

  // Evidence -> canonical events. A clean observation canonicalizes to exactly the same events a
  // plain positional map would; a malformed one loses only the messages that genuinely can't be
  // canonical events (no id/text, unknown role, a dup id) and records why. Every event comes back
  // tagged committed | provisional (canonicalize.ts / provisionalReason).
  const obs: RawObservation = {
    conversationId: input.conversationId,
    source: input.source,
    // CaptureMethod doubles as the sensor identity. Null (a legacy client) => the extension,
    // which is what all early live capture was (THREAD.md §7).
    sensor: input.capture?.method ?? "browser_extension",
    messages: input.messages,
    sourceUrl: input.sourceUrl ?? null,
    capture: input.capture ?? null,
  };
  const { events: canonEvents, integrity } = canonicalize(obs);

  const priorStatus = loadCanonicalStatuses(db, input.conversationId);

  // Conversation identity. Higher-tier evidence (the sensor's id / the URL) is authoritative; a
  // STRONG lower-tier contradiction -- the content fingerprint strongly matches a DIFFERENT
  // conversation -- quarantines the observation as `unresolved` rather than overriding identity.
  //
  // Identity keeps being re-checked until the conversation has IDENTITY_SETTLE_MIN_COMMITTED
  // committed events (a fork reveals itself over its first few turns, not on turn one). Past that
  // the conversation owns its identity and the per-flush fingerprint scan is skipped -- the
  // fabricated verdict still carries the one honest claim (platform_id -> this id) so an evidence
  // row written afterwards stays auditable rather than recording `claims: []`.
  //
  // A conversation stuck UNRESOLVED never accrues committed events, so it never crosses the
  // threshold and is re-scanned on every flush indefinitely. That is deliberate: it is the
  // recovery path. If the fork later diverges -- its own new turns dilute the fingerprint below
  // the strong-match ceiling -- the next flush resolves it and promotes everything parked so far.
  // Freezing it as unresolved to save the scan would forfeit that. The cost is one user's
  // fingerprint scan per flush of one pathological conversation; every healthy conversation takes
  // the settled fast path.
  const committedCount = [...priorStatus.values()].filter((s) => s === "committed").length;
  const identitySettled = committedCount >= IDENTITY_SETTLE_MIN_COMMITTED;
  const identity: ConversationIdentity = identitySettled
    ? {
        status: "resolved",
        canonicalId: input.conversationId,
        authority: "platform_id",
        claims: [{ authority: "platform_id", conversationId: input.conversationId, strength: 1 }],
        conflicts: [],
      }
    : resolveConversationIdentity(obs, loadConversationFingerprints(db));
  const identityUnresolved = identity.status === "unresolved";
  // Force provisional on an unresolved observation -- but never downgrade an event that a prior
  // clean observation already committed (M2 invariant: a partial/late signal must not erase
  // confirmed history). A late-emerging conflict quarantines only the NEW events and records why.
  const allEvents = identityUnresolved
    ? canonEvents.map((e) =>
        priorStatus.get(e.id) === "committed" ? e : { ...e, status: "provisional" as const },
      )
    : canonEvents;

  // The observation only corroborates (promotes, GCs) when it is trustworthy on BOTH axes.
  const observationCommitted = integrity.status === "committed" && !identityUnresolved;

  const newToCanonical = new Set(allEvents.filter((e) => !priorStatus.has(e.id)).map((e) => e.id));

  // A clean observation corroborates: promote any of its events that are stored provisional (and
  // re-extract them -- they never entered the idea graph), and drop provisional rows this
  // full observation no longer lists (transient sensor noise). Committed rows are never GC'd --
  // a partial flush must not erase confirmed history.
  //
  // Promotion matches on id alone. That is safe for every current sensor: the extension uses
  // stable DOM ids, /v1/paste defaults to a random conversationId (so its positional
  // `paste::<i>` ids never collide across two different pastes). If a client is ever added that
  // POSTs /v1/paste with a stable conversationId AND reuses it for different content, promotion
  // would need to compare text too.
  const promoting = new Set<string>();
  let retracted = 0;
  if (observationCommitted) {
    for (const e of allEvents) if (priorStatus.get(e.id) === "provisional") promoting.add(e.id);
    // Only touch the DB for GC when there is actually a provisional row to consider.
    if ([...priorStatus.values()].includes("provisional")) {
      retracted = dropRetractedProvisional(
        db,
        input.conversationId,
        allEvents.map((e) => e.id),
      );
    }
  }

  // Record the observation when it advanced, promoted, failed structure validation, or came back
  // identity-unresolved. A clean no-op resend carries no signal.
  if (newToCanonical.size > 0 || promoting.size > 0 || !integrity.ok || identityUnresolved) {
    const newMessages = input.messages.filter((m) => newToCanonical.has(m.id));
    recordEvidence(db, obs, { events: allEvents, integrity }, newMessages, identity);
  }

  const provisionalParked = allEvents.filter(
    (e) => e.status === "provisional" && newToCanonical.has(e.id),
  ).length;

  // What extraction actually runs over: events that are committed now AND either new to the DB
  // or being promoted this call. Provisional events stay in `allEvents` as context but are never
  // the source of a cognitive event -- "probabilistic capture, deterministic state".
  const extractIds = new Set(
    allEvents
      .filter((e) => e.status === "committed" && (newToCanonical.has(e.id) || promoting.has(e.id)))
      .map((e) => e.id),
  );

  if (extractIds.size === 0) {
    // Nothing to run through the pipeline. Still store any new canonical rows (provisional ones
    // land here), and report the GC.
    if (newToCanonical.size > 0) persistCanonicalEvents(db, allEvents);
    return {
      ...zeros,
      newCanonicalEvents: newToCanonical.size,
      ideaCount: existingIdeaCount(),
      integrityOk: integrity.ok,
      integrityIssues: integrity.issues,
      provisionalEvents: provisionalParked,
      retractedProvisional: retracted,
      identityStatus: identity.status,
      identityConflicts: identity.conflicts,
    };
  }

  const existingIdeas = new Map(loadIdeas(db).map((i) => [i.id, i]));

  const result = await runPipeline(allEvents, providers, { existingIdeas, newEventIds: extractIds });
  persistPipelineResult(db, allEvents, result); // writes every row, incl. promoted status=committed

  // Reconsider earlier medium-value discards now that this call may have created the idea they
  // belong to. Incremental-only -- see replayDiscardedEvents.
  const replay = await replayDiscardedEvents(db, providers);

  return {
    newCanonicalEvents: newToCanonical.size,
    newCognitiveEvents: result.cognitiveEvents.length + replay.promoted,
    discardedEvents: result.discardedEvents.length,
    promotedFromDiscard: replay.promoted,
    rejectedExtractions: result.rejectedExtractions.length,
    ideaCount: loadIdeas(db).length,
    integrityOk: integrity.ok,
    integrityIssues: integrity.issues,
    provisionalEvents: provisionalParked,
    promotedEvents: promoting.size,
    retractedProvisional: retracted,
    identityStatus: identity.status,
    identityConflicts: identity.conflicts,
  };
}
