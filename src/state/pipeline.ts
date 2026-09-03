import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CognitiveEvent, DiscardedEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD, SIGNAL_GATE_VERSION } from "../types";
import type { CompletionProvider, EmbeddingProvider } from "../providers/types";
import { extractCognitiveEvents, type ExtractionOutcome } from "../extraction/extract";
import { resolveIdentity } from "../identity/resolve";
import { rankCandidates, narrowCandidates } from "../identity/signals";
import { quickGate, strongMatchScore } from "./signalGate";
import { applyCognitiveEvent, isConfidentExistingMatch } from "./buildIdeaNode";

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

  for (const conversationEvents of byConversation.values()) {
    const outcome = await extractCognitiveEvents(conversationEvents, providers.extraction, options.newEventIds);
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

export function persistPipelineResult(
  db: Database,
  canonicalEvents: CanonicalEvent[],
  result: PipelineResult,
): void {
  const insertCanonical = db.prepare(
    // The extension resends a conversation's full transcript on every flush, so each call
    // REPLACEs every row. COALESCE keeps a previously-stored source_url when this write's value
    // is null (a mid-navigation capture, a provisional URL) -- a good URL, once captured, sticks.
    `INSERT OR REPLACE INTO canonical_events (id, conversation_id, source, role, text, created_at, idx, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT source_url FROM canonical_events WHERE id = ?)))`,
  );
  for (const e of canonicalEvents) {
    insertCanonical.run(e.id, e.conversationId, e.source, e.role, e.text, e.createdAt, e.index, e.sourceUrl ?? null, e.id);
  }

  const insertCognitive = db.prepare(
    `INSERT OR REPLACE INTO cognitive_events (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, why_it_matters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    for (const additionalId of e.additionalSourceEventIds) {
      insertSource.run(e.id, additionalId);
    }
  }

  // The signal gate's audit trail: grounded events that were not promoted. Kept so a threshold
  // or rubric change (SIGNAL_GATE_VERSION) is replayable and "why isn't my idea here" is answerable.
  const insertDiscarded = db.prepare(
    `INSERT OR REPLACE INTO discarded_events
       (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, gate_reason, gate_version, discarded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    insertIdea.run(idea.id, idea.title, idea.state, idea.currentFormulation, idea.whyItMatters ?? null, idea.createdAt, idea.updatedAt);
    for (const step of idea.evolution) {
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
