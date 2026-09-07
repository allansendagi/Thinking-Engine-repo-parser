import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CaptureProvenance, Role } from "../types";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { runPipeline, persistPipelineResult, type PipelineProviders } from "../state/pipeline";
import { replayDiscardedEvents } from "../state/replayDiscarded";
import { canonicalize, type IntegrityIssue, type RawObservation } from "../state/canonicalize";
import { recordEvidence } from "../db/evidence";

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
  };

  if (input.messages.length === 0) {
    return { ...zeros, ideaCount: existingIdeaCount(), integrityOk: true, integrityIssues: [] };
  }

  // Evidence -> canonical events. A clean observation canonicalizes to exactly the same events a
  // plain positional map would; a malformed one loses only the messages that genuinely can't be
  // canonical events (no id/text, unknown role, a dup id) and records why.
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
  const { events: allEvents, integrity } = canonicalize(obs);

  const existingIds = new Set(
    loadCanonicalEvents(db)
      .filter((e) => e.conversationId === input.conversationId)
      .map((e) => e.id),
  );
  const newEventIds = new Set(allEvents.filter((e) => !existingIds.has(e.id)).map((e) => e.id));

  // Record the observation when it advanced the conversation OR failed structure validation --
  // a no-op resend that is now structurally broken is itself a sensor-health signal. A clean
  // no-op resend carries no signal and is not recorded.
  if (newEventIds.size > 0 || !integrity.ok) {
    recordEvidence(db, obs, { events: allEvents, integrity });
  }

  if (newEventIds.size === 0) {
    return {
      ...zeros,
      ideaCount: existingIdeaCount(),
      integrityOk: integrity.ok,
      integrityIssues: integrity.issues,
    };
  }

  const existingIdeas = new Map(loadIdeas(db).map((i) => [i.id, i]));

  const result = await runPipeline(allEvents, providers, { existingIdeas, newEventIds });
  persistPipelineResult(db, allEvents, result);

  // Reconsider earlier medium-value discards now that this call may have created the idea they
  // belong to. Incremental-only -- see replayDiscardedEvents.
  const replay = await replayDiscardedEvents(db, providers);

  return {
    newCanonicalEvents: newEventIds.size,
    newCognitiveEvents: result.cognitiveEvents.length + replay.promoted,
    discardedEvents: result.discardedEvents.length,
    promotedFromDiscard: replay.promoted,
    rejectedExtractions: result.rejectedExtractions.length,
    ideaCount: loadIdeas(db).length,
    integrityOk: integrity.ok,
    integrityIssues: integrity.issues,
  };
}
