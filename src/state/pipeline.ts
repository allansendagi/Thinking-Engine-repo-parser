import type { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import type { CanonicalEvent, CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import { extractCognitiveEvents, type ExtractionOutcome } from "../extraction/extract";
import { resolveIdentity } from "../identity/resolve";
import { applyCognitiveEvent } from "./buildIdeaNode";

export interface PipelineResult {
  ideas: Map<string, IdeaNode>;
  cognitiveEvents: CognitiveEvent[];
  resolutions: IdentityResolution[];
  rejectedExtractions: ExtractionOutcome["rejected"];
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
 * Runs the full pipeline: extraction happens per-conversation (a bounded, coherent context for
 * the model), but identity resolution and state building run across ALL conversations in
 * chronological source-message order -- an idea raised in one conversation must be resolvable
 * against a refinement of it in a later, different conversation.
 */
export async function runPipeline(
  canonicalEvents: CanonicalEvent[],
  client: Anthropic = new Anthropic(),
): Promise<PipelineResult> {
  const eventsById = new Map(canonicalEvents.map((e) => [e.id, e]));
  const byConversation = groupByConversation(canonicalEvents);

  const allCognitiveEvents: CognitiveEvent[] = [];
  const allRejected: ExtractionOutcome["rejected"] = [];

  for (const conversationEvents of byConversation.values()) {
    const outcome = await extractCognitiveEvents(conversationEvents, client);
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
    const resolution = await resolveIdentity(event, [...ideas.values()], client);
    resolutions.push(resolution);
    applyCognitiveEvent(ideas, event, resolution);
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
    `INSERT OR REPLACE INTO cognitive_events (id, type, statement, confidence, source_event_id, evidence_quote)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const e of result.cognitiveEvents) {
    insertCognitive.run(e.id, e.type, e.statement, e.confidence, e.sourceEventId, e.evidenceQuote);
  }

  const insertResolution = db.prepare(
    `INSERT OR REPLACE INTO identity_resolutions (cognitive_event_id, matched_idea_id, confidence, reasoning)
     VALUES (?, ?, ?, ?)`,
  );
  for (const r of result.resolutions) {
    insertResolution.run(r.cognitiveEventId, r.matchedIdeaId, r.confidence, r.reasoning);
  }

  const insertIdea = db.prepare(
    `INSERT OR REPLACE INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEvolution = db.prepare(
    `INSERT OR REPLACE INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLoop = db.prepare(
    `INSERT OR REPLACE INTO open_loops (id, idea_id, statement, created_at, resolved)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const idea of result.ideas.values()) {
    insertIdea.run(idea.id, idea.title, idea.state, idea.currentFormulation, idea.createdAt, idea.updatedAt);
    for (const step of idea.evolution) {
      insertEvolution.run(idea.id, step.cognitiveEventId, step.formulation, step.createdAt, step.sourceEventId);
    }
    for (const loop of idea.openLoops) {
      insertLoop.run(loop.id, idea.id, loop.statement, loop.createdAt, loop.resolved ? 1 : 0);
    }
  }
}
