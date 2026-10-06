import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CognitiveEvent, DiscardedEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD, SIGNAL_GATE_VERSION } from "../types";
import type { CompletionProvider, EmbeddingProvider } from "../providers/types";
import { extractCognitiveEvents, type ExtractionOutcome } from "../extraction/extract";
import { resolveIdentity } from "../identity/resolve";
import { rankCandidates, narrowCandidates } from "../identity/signals";
import { quickGate, strongMatchScore } from "./signalGate";
import { applyCognitiveEvent, isConfidentExistingMatch } from "./buildIdeaNode";
import { messageFingerprint } from "./resolveConversationIdentity";

export interface PipelineResult {
  ideas: Map<string, IdeaNode>;
  /** Grounded events the signal gate PROMOTED -- the ones now backing ideas. */
  cognitiveEvents: CognitiveEvent[];
  /** Grounded events the signal gate did not promote. Stored, replayable, not attached to ideas. */
  discardedEvents: DiscardedEvent[];
  resolutions: IdentityResolution[];
  rejectedExtractions: ExtractionOutcome["rejected"];
}

export interface PipelineProviders {
  extraction: CompletionProvider;
  reasoning: CompletionProvider;
  embeddings?: EmbeddingProvider;
}

const EXTRACTION_CONCURRENCY = 4;

/** `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function groupByConversation(events: CanonicalEvent[]): Map<string, CanonicalEvent[]> {
  const groups = new Map<string, CanonicalEvent[]>();
  for (const event of events) {
    const group = groups.get(event.conversationId) ?? [];
    group.push(event);
    groups.set(event.conversationId, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.index - b.index);
  return groups;
}

export interface RunPipelineOptions {
  /**
   * Ideas from prior runs to extend, rather than starting empty. Required for incremental/live
   * capture -- without this, every API call would re-derive ideas from scratch and identity
   * resolution would never see anything from before this call, guaranteeing duplicates.
   */
  existingIdeas?: Map<string, IdeaNode>;
  /**
   * Canonical event ids that are actually new and should be extracted from. Every other event in
   * `canonicalEvents` is included as context only (see extraction/prompt.ts's [ALREADY PROCESSED]
   * marking) -- re-sending prior messages for context can never produce a duplicate cognitive
   * event, enforced in extract.ts, not just requested in the prompt. If omitted, every event is
   * treated as new (bulk/import behavior -- unchanged from before this option existed).
   */
  newEventIds?: Set<string>;
  /** Statements of ideas this person deleted -- steers extraction away from similar ones. */
  dismissed?: string[];
}

/**
 * Runs the pipeline: extraction happens per-conversation on the fast/cheap provider (a bounded,
 * coherent context for the model), but identity resolution and state building run across ALL
 * conversations in chronological source-message order on the strong provider -- an idea raised in
 * one conversation must be resolvable against a refinement of it in a later, different
 * conversation (including one from a previous call, via existingIdeas). Before each
 * identity-resolution call, the candidate idea list is narrowed by deterministic signals
 * (identity/signals.ts) rather than sent in full.
 */
export async function runPipeline(
  canonicalEvents: CanonicalEvent[],
  providers: PipelineProviders,
  options: RunPipelineOptions = {},
): Promise<PipelineResult> {
  const eventsById = new Map(canonicalEvents.map((e) => [e.id, e]));
  const byConversation = groupByConversation(canonicalEvents);

  const allCognitiveEvents: CognitiveEvent[] = [];
  const allRejected: ExtractionOutcome["rejected"] = [];

  // Extraction is independent per conversation, so run a few at once -- a 15-conversation import
  // batch used to make 15 sequential model calls before identity resolution even began. Results
  // are re-sorted chronologically below, so completion order doesn't matter. Identity resolution
  // stays strictly sequential: each decision depends on the ideas the previous one produced.
  const outcomes = await mapWithConcurrency(
    [...byConversation.values()],
    EXTRACTION_CONCURRENCY,
    (conversationEvents) => extractCognitiveEvents(conversationEvents, providers.extraction, options.newEventIds, options.dismissed),
  );
  for (const outcome of outcomes) {
    allCognitiveEvents.push(...outcome.events);
    allRejected.push(...outcome.rejected);
  }

  allCognitiveEvents.sort((a, b) => {
    const aTime = eventsById.get(a.sourceEventId)?.createdAt ?? "";
    const bTime = eventsById.get(b.sourceEventId)?.createdAt ?? "";
    return aTime.localeCompare(bTime);
  });

  const ideas = options.existingIdeas ?? new Map<string, IdeaNode>();
  const resolutions: IdentityResolution[] = [];
  const persistedEvents: CognitiveEvent[] = [];
  const discardedEvents: DiscardedEvent[] = [];

  for (const event of allCognitiveEvents) {
    const sourceEvent = eventsById.get(event.sourceEventId);
    if (!sourceEvent) throw new Error(`Cognitive event ${event.id} references unknown source event`);

    // Signal gate, phase 1: needs only the event, so high/low never pay for ranking.
    const quick = quickGate(event);
    if (quick.decision === "discard") {
      discardedEvents.push({ event, gateReason: quick.reason, gateVersion: SIGNAL_GATE_VERSION });
      continue;
    }

    const ranked = await rankCandidates(event, sourceEvent, [...ideas.values()], {
      embeddingProvider: providers.embeddings,
    });
    const narrowed = narrowCandidates(ranked).map((c) => c.idea);

    // Signal gate, phase 2: a medium-value leaky-type event is kept only if it extends an idea
    // the user already developed (top candidate at/above the strong-match score).
    if (quick.decision === "needs-match") {
      const topScore = ranked[0]?.score ?? 0;
      if (topScore < strongMatchScore()) {
        discardedEvents.push({
          event,
          gateReason: `${quick.reason}; top candidate ${topScore.toFixed(3)} < ${strongMatchScore()}`,
          gateVersion: SIGNAL_GATE_VERSION,
        });
        continue;
      }
    }

    const resolution = await resolveIdentity(event, narrowed, providers.reasoning);

    // Signal gate, phase 3: a strong retrieval score got a medium leaky event this far, but the
    // idea model is the actual "is this the same idea" authority. If it won't confirm a confident
    // existing-idea match, the event does NOT become a new thin thread -- it waits in
    // discarded_events for a later pass, once the graph may have grown into it.
    if (quick.decision === "needs-match" && !isConfidentExistingMatch(resolution, ideas)) {
      discardedEvents.push({
        event,
        gateReason:
          `${quick.reason}; identity gave ${resolution.matchedIdeaId ?? "no match"} @ ` +
          `${resolution.confidence.toFixed(2)} (need >= ${IDENTITY_RESOLUTION_MERGE_THRESHOLD})`,
        gateVersion: SIGNAL_GATE_VERSION,
      });
      continue;
    }

    resolutions.push(resolution);
    applyCognitiveEvent(ideas, event, resolution, sourceEvent.createdAt);
    persistedEvents.push(event);
  }

  return {
    ideas,
    cognitiveEvents: persistedEvents,
    discardedEvents,
    resolutions,
    rejectedExtractions: allRejected,
  };
}

/**
 * Write canonical event rows -- the "just store the observation" path, used directly by
 * ingest.ts when an observation is held provisional (nothing to run through the pipeline) and by
 * persistPipelineResult below. INSERT OR REPLACE because the extension resends a conversation's
 * full transcript on every flush. COALESCE keeps a previously-stored value when this write's is
 * null (a mid-navigation source_url, an older client that omits capture_*). `status` is written
 * plainly, latest-wins -- a promotion (provisional -> committed) must be able to overwrite.
 */
export function persistCanonicalEvents(db: Database, canonicalEvents: CanonicalEvent[]): void {
  const insertCanonical = db.prepare(
    `INSERT OR REPLACE INTO canonical_events
       (id, conversation_id, source, role, text, created_at, idx, source_url,
        capture_method, capture_fidelity, status, fingerprint)
     VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       COALESCE(?, (SELECT source_url FROM canonical_events WHERE id = ?)),
       COALESCE(?, (SELECT capture_method FROM canonical_events WHERE id = ?)),
       COALESCE(?, (SELECT capture_fidelity FROM canonical_events WHERE id = ?)),
       ?, ?
     )`,
  );
  // Clients re-send the whole transcript on every page change, so most of what arrives is already
  // stored exactly as it is: look at what's there for these conversations and write only what is
  // new or different. A message whose text the person's retention setting removed stays removed --
  // INSERT OR REPLACE would otherwise write the text straight back.
  type Stored = {
    id: string; source: string; role: string; text: string; created_at: string; idx: number;
    source_url: string | null; capture_method: string | null; capture_fidelity: string | null;
    status: string; fingerprint: string | null; text_removed_at: string | null;
  };
  const stored = new Map<string, Stored>();
  const loadStored = db.prepare(
    `SELECT id, source, role, text, created_at, idx, source_url, capture_method, capture_fidelity, status, fingerprint, text_removed_at
     FROM canonical_events WHERE conversation_id = ?`,
  );
  for (const cid of new Set(canonicalEvents.map((e) => e.conversationId))) {
    for (const r of loadStored.all(cid) as Stored[]) stored.set(r.id, r);
  }
  for (const e of canonicalEvents) {
    const old = stored.get(e.id);
    if (old?.text_removed_at) continue;
    if (
      old &&
      old.text === e.text && old.role === e.role && old.source === e.source && old.created_at === e.createdAt &&
      old.idx === e.index && old.status === (e.status ?? "committed") &&
      (e.sourceUrl == null || old.source_url === e.sourceUrl) &&
      (e.capture?.method == null || old.capture_method === e.capture.method) &&
      (e.capture?.fidelity == null || old.capture_fidelity === e.capture.fidelity) &&
      (old.fingerprint !== null || messageFingerprint(e.text) === null)
    ) {
      continue; // already stored exactly as it is
    }
    insertCanonical.run(
      e.id,
      e.conversationId,
      e.source,
      e.role,
      e.text,
      e.createdAt,
      e.index,
      e.sourceUrl ?? null,
      e.id,
      e.capture?.method ?? null,
      e.id,
      e.capture?.fidelity ?? null,
      e.id,
      e.status ?? "committed",
      messageFingerprint(e.text),
    );
  }
}

/**
 * An exact fingerprint of everything persisted about an idea. Taken before a pipeline run and
 * compared after, it tells `persistPipelineResult` which ideas actually changed -- so a capture
 * writes the one or two ideas it touched, not the whole graph.
 */
function stepSignature(e: IdeaNode["evolution"][number]): string {
  return `${e.cognitiveEventId}\u0001${e.formulation}\u0001${e.createdAt}\u0001${e.sourceEventId}`;
}

export function ideaSignature(i: IdeaNode): string {
  return [
    i.title,
    i.state,
    i.currentFormulation,
    i.whyItMatters ?? "",
    i.createdAt,
    i.updatedAt,
    i.evolution.map(stepSignature).join("\u0002"),
    i.openLoops.map((l) => `${l.id}\u0001${l.statement}\u0001${l.createdAt}\u0001${l.resolved ? 1 : 0}`).join("\u0002"),
    i.decisions.map((d) => `${d.id}\u0001${d.statement}\u0001${d.decidedAt}\u0001${d.sourceEventId}`).join("\u0002"),
    [...i.relatedIdeaIds].sort().join("\u0002"),
  ].join("\u0003");
}

/** What was stored for an idea before a run: its whole signature, and its steps one by one so a
 *  changed idea rewrites only the steps that are new or different, not its entire history. */
export interface IdeaBaseline {
  signature: string;
  steps: Set<string>;
}

export function snapshotIdeas(ideas: Map<string, IdeaNode>): Map<string, IdeaBaseline> {
  return new Map(
    [...ideas].map(([id, idea]) => [id, { signature: ideaSignature(idea), steps: new Set(idea.evolution.map(stepSignature)) }]),
  );
}

/**
 * Write a pipeline run to the database, all or nothing, in one transaction. With `baseline` (from
 * `snapshotIdeas`, taken before the run) only the ideas that changed or are new are written; without
 * it every idea is -- the old behaviour, still right for callers that build the whole graph afresh.
 */
export function persistPipelineResult(
  db: Database,
  canonicalEvents: CanonicalEvent[],
  result: PipelineResult,
  baseline?: Map<string, IdeaBaseline>,
): void {
  db.transaction(() => persistPipelineResultUnchecked(db, canonicalEvents, result, baseline))();
}

function persistPipelineResultUnchecked(
  db: Database,
  canonicalEvents: CanonicalEvent[],
  result: PipelineResult,
  baseline?: Map<string, IdeaBaseline>,
): void {
  persistCanonicalEvents(db, canonicalEvents);

  const insertCognitive = db.prepare(
    `INSERT OR REPLACE INTO cognitive_events (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, why_it_matters, role, adopted_source_event_id, adopted_quote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT OR REPLACE INTO cognitive_event_sources (cognitive_event_id, canonical_event_id) VALUES (?, ?)`,
  );
  for (const e of result.cognitiveEvents) {
    insertCognitive.run(
      e.id,
      e.type,
      e.statement,
      e.confidence,
      e.persistence ?? "high",
      e.persistenceReason ?? null,
      e.sourceEventId,
      e.evidenceQuote,
      e.whyItMatters ?? null,
      e.role ?? null,
      e.adoptedFrom?.sourceEventId ?? null,
      e.adoptedFrom?.quote ?? null,
    );
    for (const additionalId of e.additionalSourceEventIds) {
      insertSource.run(e.id, additionalId);
    }
  }

  // The signal gate's audit trail: grounded events that were not promoted. Kept so a threshold
  // or rubric change (SIGNAL_GATE_VERSION) is replayable and "why isn't my idea here" is answerable.
  const insertDiscarded = db.prepare(
    `INSERT OR REPLACE INTO discarded_events
       (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, gate_reason, gate_version, discarded_at, role, adopted_source_event_id, adopted_quote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const discardedAt = new Date().toISOString();
  for (const d of result.discardedEvents) {
    const e = d.event;
    insertDiscarded.run(
      e.id,
      e.type,
      e.statement,
      e.confidence,
      e.persistence ?? "high",
      e.persistenceReason ?? null,
      e.sourceEventId,
      e.evidenceQuote,
      d.gateReason,
      d.gateVersion,
      discardedAt,
      e.role ?? null,
      e.adoptedFrom?.sourceEventId ?? null,
      e.adoptedFrom?.quote ?? null,
    );
  }

  const insertIdea = db.prepare(
    `INSERT OR REPLACE INTO idea_nodes (id, title, state, current_formulation, why_it_matters, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvolution = db.prepare(
    `INSERT OR REPLACE INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLoop = db.prepare(
    `INSERT OR REPLACE INTO open_loops (id, idea_id, statement, created_at, resolved)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertDecision = db.prepare(
    `INSERT OR REPLACE INTO decisions (id, idea_id, statement, decided_at, source_event_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRelated = db.prepare(
    `INSERT OR REPLACE INTO related_ideas (idea_id, related_idea_id) VALUES (?, ?)`,
  );

  for (const idea of result.ideas.values()) {
    const before = baseline?.get(idea.id);
    if (before && before.signature === ideaSignature(idea)) continue; // unchanged: already stored
    insertIdea.run(idea.id, idea.title, idea.state, idea.currentFormulation, idea.whyItMatters ?? null, idea.createdAt, idea.updatedAt);
    for (const step of idea.evolution) {
      if (before?.steps.has(stepSignature(step))) continue; // already stored exactly as it is
      insertEvolution.run(idea.id, step.cognitiveEventId, step.formulation, step.createdAt, step.sourceEventId);
    }
    for (const loop of idea.openLoops) {
      insertLoop.run(loop.id, idea.id, loop.statement, loop.createdAt, loop.resolved ? 1 : 0);
    }
    for (const decision of idea.decisions) {
      insertDecision.run(decision.id, idea.id, decision.statement, decision.decidedAt, decision.sourceEventId);
    }
    for (const relatedId of idea.relatedIdeaIds) {
      insertRelated.run(idea.id, relatedId);
    }
  }

  // Inserted last: matched_idea_id references idea_nodes(id), which must already exist.
  const insertResolution = db.prepare(
    `INSERT OR REPLACE INTO identity_resolutions (cognitive_event_id, matched_idea_id, confidence, reasoning)
     VALUES (?, ?, ?, ?)`,
  );
  for (const r of result.resolutions) {
    insertResolution.run(r.cognitiveEventId, r.matchedIdeaId, r.confidence, r.reasoning);
  }
}
