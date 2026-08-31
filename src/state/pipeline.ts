import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import type { CompletionProvider, EmbeddingProvider } from "../providers/types";
import { extractCognitiveEvents, type ExtractionOutcome } from "../extraction/extract";
import { resolveIdentity } from "../identity/resolve";
import { rankCandidates, narrowCandidates } from "../identity/signals";
import { applyCognitiveEvent } from "./buildIdeaNode";

export interface PipelineResult {
  ideas: Map<string, IdeaNode>;
  cognitiveEvents: CognitiveEvent[];
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

/**
 * Runs the full pipeline: extraction happens per-conversation on the fast/cheap provider (a
 * bounded, coherent context for the model), but identity resolution and state building run
 * across ALL conversations in chronological source-message order on the strong provider -- an
 * idea raised in one conversation must be resolvable against a refinement of it in a later,
 * different conversation. Before each identity-resolution call, the candidate idea list is
 * narrowed by deterministic signals (identity/signals.ts) rather than sent in full.
 */
export async function runPipeline(
  canonicalEvents: CanonicalEvent[],
  providers: PipelineProviders,
): Promise<PipelineResult> {
  const eventsById = new Map(canonicalEvents.map((e) => [e.id, e]));
  const byConversation = groupByConversation(canonicalEvents);

  const allCognitiveEvents: CognitiveEvent[] = [];
  const allRejected: ExtractionOutcome["rejected"] = [];

  for (const conversationEvents of byConversation.values()) {
    const outcome = await extractCognitiveEvents(conversationEvents, providers.extraction);
    allCognitiveEvents.push(...outcome.events);
    allRejected.push(...outcome.rejected);
  }

  allCognitiveEvents.sort((a, b) => {
    const aTime = eventsById.get(a.sourceEventId)?.createdAt ?? "";
    const bTime = eventsById.get(b.sourceEventId)?.createdAt ?? "";
    return aTime.localeCompare(bTime);
  });

  const ideas = new Map<string, IdeaNode>();
  const resolutions: IdentityResolution[] = [];

  for (const event of allCognitiveEvents) {
    const sourceEvent = eventsById.get(event.sourceEventId);
    if (!sourceEvent) throw new Error(`Cognitive event ${event.id} references unknown source event`);

    const ranked = await rankCandidates(event, sourceEvent, [...ideas.values()], {
      embeddingProvider: providers.embeddings,
    });
    const narrowed = narrowCandidates(ranked).map((c) => c.idea);

    const resolution = await resolveIdentity(event, narrowed, providers.reasoning);
    resolutions.push(resolution);
    applyCognitiveEvent(ideas, event, resolution, sourceEvent.createdAt);
  }

  return { ideas, cognitiveEvents: allCognitiveEvents, resolutions, rejectedExtractions: allRejected };
}

export function persistPipelineResult(
  db: Database,
  canonicalEvents: CanonicalEvent[],
  result: PipelineResult,
): void {
  const insertCanonical = db.prepare(
    `INSERT OR REPLACE INTO canonical_events (id, conversation_id, source, role, text, created_at, idx)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of canonicalEvents) {
    insertCanonical.run(e.id, e.conversationId, e.source, e.role, e.text, e.createdAt, e.index);
  }

  const insertCognitive = db.prepare(
    `INSERT OR REPLACE INTO cognitive_events (id, type, statement, confidence, source_event_id, evidence_quote, why_it_matters)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT OR REPLACE INTO cognitive_event_sources (cognitive_event_id, canonical_event_id) VALUES (?, ?)`,
  );
  for (const e of result.cognitiveEvents) {
    insertCognitive.run(e.id, e.type, e.statement, e.confidence, e.sourceEventId, e.evidenceQuote, e.whyItMatters ?? null);
    for (const additionalId of e.additionalSourceEventIds) {
      insertSource.run(e.id, additionalId);
    }
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
