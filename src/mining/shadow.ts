import type { Database } from "bun:sqlite";
import { listThoughts, loadThoughtVectors, storeThoughtVectors, thoughtsNeedingVectors, vectorModels } from "../db/thoughts";
import { VoyageEmbeddingProvider, voyageConfigured } from "../providers/voyage";
import type { CognitiveEventType, IdeaNode } from "../types";
import { chooseMeaningModel, consolidate, meaningWeightFor, nativeIsSufficient, type ConsolidatedIdea, type MiningThought } from "./consolidate";
import { loadCorrections, type LearnedCorrections } from "./corrections";

/**
 * v2 mining in SHADOW: recompute ideas from every stored thought with the v2 consolidation pass
 * and store the result in idea_view_v2, next to -- never instead of -- the serving idea_nodes.
 * It goes live only once the thinking bench (and real accounts) show it's better.
 *
 * Vectors are native-first: the best-covered `apple:` model the Mac uploaded. No cloud call is
 * ever made here; thoughts without a vector just fall back to word similarity.
 */

export interface MiningInput {
  thoughts: MiningThought[];
  vectors?: Map<string, Float32Array>;
  vectorModel: string | null;
  previousIdeaOf: Map<string, string>;
  /** The person's corrections, applied as constraints on every pass. */
  learned: LearnedCorrections;
}

export function loadMiningInput(db: Database): MiningInput {
  const positions = new Map(
    (db.query("SELECT id, idx FROM canonical_events").all() as { id: string; idx: number }[]).map((r) => [r.id, r.idx]),
  );
  const thoughts: MiningThought[] = listThoughts(db).map((t) => ({
    id: t.id,
    type: t.type as CognitiveEventType,
    statement: t.statement,
    persistence: (t.persistence === "low" || t.persistence === "medium" ? t.persistence : "high") as MiningThought["persistence"],
    sourceEventId: t.sourceEventId,
    conversationId: t.conversationId,
    position: positions.get(t.sourceEventId) ?? 0,
    createdAt: t.createdAt,
    role: t.role ?? undefined,
    adopted: t.adoptedSourceEventId !== null,
  }));
  // Low-persistence thoughts (requests for info, formatting asks) never seed or join ideas, and
  // thoughts from an idea the person deleted never come back as one.
  const learned = loadCorrections(db);
  const kept = thoughts.filter((t) => t.persistence !== "low" && !learned.dismissedThoughtIds.has(t.id));

  // Native first, but only as far as the bench showed it works (chooseMeaningModel); Voyage
  // fills in where on-device meaning isn't good enough (and only if configured).
  const model = chooseMeaningModel(vectorModels(db));
  const vectors = model ? loadThoughtVectors(db, model) : undefined;
  const previousIdeaOf = new Map(
    (db.query("SELECT idea_id, cognitive_event_id FROM evolution_steps").all() as { idea_id: string; cognitive_event_id: string }[]).map(
      (r) => [r.cognitive_event_id, r.idea_id],
    ),
  );
  return { thoughts: kept, vectors, vectorModel: model, previousIdeaOf, learned };
}

export interface ShadowRun {
  thoughts: number;
  vectors: number;
  vectorModel: string | null;
  ideas: number;
  sparks: number;
  ms: number;
}

export function runShadowMining(db: Database): { run: ShadowRun; ideas: ConsolidatedIdea[] } {
  const started = performance.now();
  const input = loadMiningInput(db);
  const ideas = consolidate(input.thoughts, {
    vectors: input.vectors,
    previousIdeaOf: input.previousIdeaOf,
    constraints: input.learned.constraints,
    meaningWeight: meaningWeightFor(input.vectorModel),
  });
  // The person's own title and state win over anything derived.
  for (const i of ideas) {
    const title = input.learned.titles.get(i.node.id);
    if (title) i.node.title = title;
    const state = input.learned.states.get(i.node.id);
    if (state) i.node.state = state;
  }
  const ms = Math.round(performance.now() - started);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.exec("DELETE FROM idea_view_v2");
    const put = db.prepare("INSERT OR REPLACE INTO idea_view_v2 (idea_id, is_spark, thought_ids, json, computed_at) VALUES (?, ?, ?, ?, ?)");
    for (const i of ideas) put.run(i.node.id, i.isSpark ? 1 : 0, JSON.stringify(i.thoughtIds), JSON.stringify(i.node), now);
    db.prepare(
      "INSERT INTO mining_runs (miner, vector_model, thoughts, vectors, ideas, sparks, ms, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("v2", input.vectorModel, input.thoughts.length, input.vectors?.size ?? 0, ideas.filter((i) => !i.isSpark).length, ideas.filter((i) => i.isSpark).length, ms, now);
  })();

  return {
    run: {
      thoughts: input.thoughts.length,
      vectors: input.vectors?.size ?? 0,
      vectorModel: input.vectorModel,
      ideas: ideas.filter((i) => !i.isSpark).length,
      sparks: ideas.filter((i) => i.isSpark).length,
      ms,
    },
    ideas,
  };
}

/** The shadow view as stored -- for comparison tooling and, later, serving. */
export function loadShadowIdeas(db: Database): { node: IdeaNode; isSpark: boolean; thoughtIds: string[] }[] {
  return (db.query("SELECT json, is_spark, thought_ids FROM idea_view_v2").all() as { json: string; is_spark: number; thought_ids: string }[]).map(
    (r) => ({ node: JSON.parse(r.json) as IdeaNode, isSpark: r.is_spark === 1, thoughtIds: JSON.parse(r.thought_ids) as string[] }),
  );
}

/**
 * Cloud fallback, only when no on-device model for this account is good enough on its own (no
 * Mac, no contextual asset, or -- today -- the contextual model's partial score) and
 * VOYAGE_API_KEY is set. Embeds up to `max` thoughts per run.
 */
export async function voyageFallback(db: Database, provider?: VoyageEmbeddingProvider, max = 500): Promise<number> {
  const nativeEnough = vectorModels(db).some(nativeIsSufficient);
  if (nativeEnough || (!provider && !voyageConfigured())) return 0;
  const voyage = provider ?? new VoyageEmbeddingProvider();
  let done = 0;
  while (done < max) {
    const batch = thoughtsNeedingVectors(db, voyage.modelId, Math.min(100, max - done));
    if (batch.length === 0) break;
    const vectors = await voyage.embedMany(batch.map((t) => t.text));
    storeThoughtVectors(db, voyage.modelId, batch.map((t, i) => ({ id: t.id, vector: vectors[i]! })));
    done += batch.length;
  }
  return done;
}

// ------------------------------------------------------------------------------ scheduling

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced shadow run after captures: at most one per user per `delayMs`, off the request path.
 * Disabled with THREAD_SHADOW_MINER=off. Failures are logged, never surfaced -- shadow mode must
 * not be able to affect serving.
 */
export function scheduleShadowMining(userId: string, open: (userId: string) => Database, delayMs = 120_000): void {
  if (process.env.THREAD_SHADOW_MINER === "off" || pending.has(userId)) return;
  const timer = setTimeout(async () => {
    pending.delete(userId);
    let db: Database | null = null;
    try {
      db = open(userId);
      try {
        await voyageFallback(db);
      } catch (e) {
        console.error(`[Thread] voyage fallback failed for ${userId}:`, e); // mine on words instead
      }
      const { run } = runShadowMining(db);
      console.log(`[Thread] shadow v2 mining ${userId}: ${run.ideas} ideas, ${run.sparks} sparks from ${run.thoughts} thoughts (${run.vectors} vectors) in ${run.ms}ms`);
    } catch (e) {
      console.error(`[Thread] shadow v2 mining failed for ${userId}:`, e);
    } finally {
      db?.close();
    }
  }, delayMs);
  (timer as { unref?: () => void }).unref?.();
  pending.set(userId, timer);
}
