import { runPipeline } from "../state/pipeline";
import { lexicalOverlap } from "../identity/signals";
import type { CompletionProvider } from "../providers/types";
import type { CognitiveEvent, IdeaNode } from "../types";
import type { MinerOutput } from "./metrics";
import type { MinedIdea, Scenario } from "./types";

/**
 * Perfect extraction from the answer key: for each extraction call, return exactly the gold
 * thoughts of the [NEW] messages in the prompt. Lets the bench score GROUPING and STATE in
 * isolation, for free and deterministically -- extraction quality is measured separately in the
 * live run (real model, real cost).
 */
export class OracleExtractionProvider implements CompletionProvider {
  constructor(private readonly scenario: Scenario) {}
  async complete(_system: string, user: string): Promise<string> {
    const newIds = new Set([...user.matchAll(/\[NEW\] \[([^\]]+)\]/g)].map((m) => m[1]!));
    const events = this.scenario.thoughts
      .filter((t) => newIds.has(t.messageId))
      .map((t) => ({
        type: t.type,
        statement: t.statement,
        title: t.type === "new_idea" ? t.statement.split(/\s+/).slice(0, 5).join(" ") : null,
        confidence: 0.95,
        persistence: "high",
        persistence_reason: "bench oracle",
        source_event_id: t.messageId,
        evidence_quote: t.quote,
        why_it_matters: null,
        additional_source_event_ids: [],
      }));
    return JSON.stringify({ events });
  }
}

/**
 * A no-model stand-in for v1's identity-resolution call: match the best candidate by word
 * overlap, else "new idea". Cruder than the real model (which can match a paraphrase it is
 * shown), so v1-offline numbers are a lower bound on v1 -- the live run gives the real ones.
 */
export class WordOverlapIdentityProvider implements CompletionProvider {
  constructor(private readonly threshold = 0.12) {}
  async complete(_system: string, user: string): Promise<string> {
    const statement = user.match(/statement: (.*)/)?.[1] ?? "";
    const candidates = [...user.matchAll(/- id: (\S+)\n\s+title: (.*)\n\s+current_formulation: (.*)/g)].map((m) => ({
      id: m[1]!,
      text: `${m[2]} ${m[3]}`,
    }));
    let best: { id: string; score: number } | null = null;
    for (const c of candidates) {
      const score = lexicalOverlap(statement, c.text);
      if (!best || score > best.score) best = { id: c.id, score };
    }
    const match = best && best.score >= this.threshold ? best.id : null;
    return JSON.stringify({ matched_idea_id: match, confidence: match ? 0.9 : 0.95, reasoning: "word overlap", also_related_idea_id: null });
  }
}

/** `cog_<messageId>_<n>` -> messageId (message ids contain underscores, the suffix doesn't). */
function messageIdOfCognitive(cognitiveEventId: string): string {
  return cognitiveEventId.replace(/^(loop_|dec_)?cog_/, "").replace(/_\d+$/, "");
}

/** v1 IdeaNode -> the bench's neutral shape. */
export function fromIdeaNode(idea: IdeaNode): MinedIdea {
  const positional = [...idea.evolution].reverse().find((s) => s.formulation === idea.currentFormulation);
  return {
    id: idea.id,
    title: idea.title,
    messageIds: idea.evolution.map((s) => s.sourceEventId),
    currentFormulationMessageId: positional?.sourceEventId,
    currentFormulation: idea.currentFormulation,
    openLoops: idea.openLoops.map((l) => ({
      statement: l.statement,
      resolved: l.resolved,
      messageId: messageIdOfCognitive(l.id),
    })),
    decisionMessageIds: idea.decisions.map((d) => d.sourceEventId),
    state: idea.state,
  };
}

export interface Miner {
  name: string;
  mine(scenario: Scenario): Promise<MinerOutput>;
}

/** Today's pipeline, end to end, with injectable extraction + reasoning. */
export function v1Miner(name: string, providers: (s: Scenario) => { extraction: CompletionProvider; reasoning: CompletionProvider }): Miner {
  return {
    name,
    async mine(scenario) {
      const result = await runPipeline(scenario.events, providers(scenario));
      return { ideas: [...result.ideas.values()].map(fromIdeaNode), sparkMessageIds: [] };
    },
  };
}

export const v1Offline: Miner = v1Miner("v1 (offline: answer-key extraction, word-overlap matching)", (s) => ({
  extraction: new OracleExtractionProvider(s),
  reasoning: new WordOverlapIdentityProvider(),
}));

export type { CognitiveEvent };

// ------------------------------------------------------------------------------ v2 (consolidation)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consolidate, type MiningThought } from "../mining/consolidate";

/** Apple on-device vectors for the bench corpus, if they've been generated (bench-vectors
 *  workflow / BenchVectorsTests), keyed by statement text. */
export function loadBenchVectors(): { model: string; byText: Map<string, number[]> } | null {
  const path = join(import.meta.dir, "vectors.apple.json");
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { model: string; vectors: Record<string, number[]> };
  return { model: raw.model, byText: new Map(Object.entries(raw.vectors)) };
}

/** Answer-key thoughts in the shape the v2 miner consumes (same as what the server extracts). */
export function oracleMiningThoughts(s: Scenario): MiningThought[] {
  const events = new Map(s.events.map((e) => [e.id, e]));
  return s.thoughts.map((t, i) => {
    const e = events.get(t.messageId)!;
    return {
      id: `cog_${t.messageId}_${i}`,
      type: t.type,
      statement: t.statement,
      persistence: "high",
      sourceEventId: t.messageId,
      conversationId: e.conversationId,
      position: e.index,
      createdAt: e.createdAt,
    };
  });
}

export function v2Miner(name: string, vectors: Map<string, number[]> | null): Miner {
  return {
    name,
    async mine(s) {
      const thoughts = oracleMiningThoughts(s);
      const byThought = new Map<string, number[]>();
      if (vectors) for (const t of thoughts) {
        const v = vectors.get(t.statement);
        if (v) byThought.set(t.id, v);
      }
      const ideas = consolidate(thoughts, { vectors: vectors ? byThought : undefined });
      const msgOfThought = new Map(thoughts.map((t) => [t.id, t.sourceEventId]));
      const mined = ideas.filter((i) => !i.isSpark).map((i) => {
        const node = fromIdeaNode(i.node);
        return {
          ...node,
          openLoops: i.node.openLoops.map((l) => ({
            statement: l.statement,
            resolved: l.resolved,
            messageId: msgOfThought.get(l.id.slice("loop_".length)),
          })),
        };
      });
      const sparks = ideas.filter((i) => i.isSpark).flatMap((i) => i.thoughtIds.map((id) => msgOfThought.get(id)!));
      return { ideas: mined, sparkMessageIds: sparks };
    },
  };
}
