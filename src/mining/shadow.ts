import type { Database } from "bun:sqlite";
import { listThoughts, loadThoughtVectors, storeThoughtVectors, thoughtsNeedingVectors, vectorModels } from "../db/thoughts";
import { VoyageEmbeddingProvider, voyageConfigured } from "../providers/voyage";
import type { CognitiveEventType, IdeaNode } from "../types";
import { chooseMeaningModel, consolidate, meaningWeightFor, nativeIsSufficient, type ConsolidatedIdea, type MiningThought } from "./consolidate";
import { loadCorrections, type LearnedCorrections } from "./corrections";
import { hasV1Backup, materializeV2, restoreV1, servesV2 } from "./serve";
import { consolidateOffThread } from "./offThread";

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
    answersEventId: t.answersEventId ?? undefined,
    title: t.title ?? undefined,
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

/**
 * Themes: ideas whose thoughts average at least this similar are listed as related. Tuned on the
 * owner's own two-level labels (114 pairs: same idea / same theme / unrelated): theme-level MCC
 * 0.55 without themes -> 0.75 at 0.15 (0.10: 0.69, 0.20: 0.66; tuned on random halves and scored
 * on the other: 0.73, 10-90% 0.63-0.84), idea level unchanged at 0.47 (v1 today: 0.25 / 0.17).
 */
export const THEME_THRESHOLD = 0.15;

export interface ShadowRun {
  thoughts: number;
  vectors: number;
  vectorModel: string | null;
  ideas: number;
  sparks: number;
  ms: number;
}

function miningOptions(input: MiningInput) {
  return {
    vectors: input.vectors,
    previousIdeaOf: input.previousIdeaOf,
    constraints: input.learned.constraints,
    meaningWeight: meaningWeightFor(input.vectorModel),
    themeThreshold: THEME_THRESHOLD,
  };
}

/** Store a pass's result in the shadow view and the run log; the person's own title and state win. */
function finishMining(db: Database, input: MiningInput, ideas: ConsolidatedIdea[], ms: number): { run: ShadowRun; ideas: ConsolidatedIdea[] } {
  for (const i of ideas) {
    const title = input.learned.titles.get(i.node.id);
    if (title) i.node.title = title;
    const state = input.learned.states.get(i.node.id);
    if (state) i.node.state = state;
  }
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

/** One pass, inline (CLI, tests). */
export function runShadowMining(db: Database): { run: ShadowRun; ideas: ConsolidatedIdea[] } {
  const started = performance.now();
  const input = loadMiningInput(db);
  const ideas = consolidate(input.thoughts, miningOptions(input));
  return finishMining(db, input, ideas, Math.round(performance.now() - started));
}

/** One pass with the computation on the worker thread; reads and writes stay here. */
export async function runShadowMiningOffThread(db: Database): Promise<{ run: ShadowRun; ideas: ConsolidatedIdea[] }> {
  const started = performance.now();
  const input = loadMiningInput(db);
  const ideas = await consolidateOffThread(input.thoughts, miningOptions(input));
  return finishMining(db, input, ideas, Math.round(performance.now() - started));
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

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
/** A pass was asked for while one was running: run once more after it (true = with Voyage). */
const again = new Map<string, boolean>();

async function minePass(userId: string, open: (userId: string) => Database, withVoyage: boolean): Promise<void> {
  if (running.has(userId)) {
    // The running pass read the thoughts before this request's; one more pass after it, never two at once.
    again.set(userId, (again.get(userId) ?? false) || withVoyage);
    return;
  }
  running.add(userId);
  let db: Database | null = null;
  try {
    db = open(userId);
    if (withVoyage) {
      try {
        await voyageFallback(db);
      } catch (e) {
        console.error(`[Thread] voyage fallback failed for ${userId}:`, e); // mine on words instead
      }
    }
    const { run, ideas } = await runShadowMiningOffThread(db);
    console.log(`[Thread] shadow v2 mining ${userId}: ${run.ideas} ideas, ${run.sparks} sparks from ${run.thoughts} thoughts (${run.vectors} vectors) in ${run.ms}ms`);
    syncServing(userId, db, ideas);
  } catch (e) {
    console.error(`[Thread] shadow v2 mining failed for ${userId}:`, e);
  } finally {
    db?.close();
    running.delete(userId);
    if (again.has(userId)) {
      const v = again.get(userId)!;
      again.delete(userId);
      void minePass(userId, open, v);
    }
  }
}

/**
 * After captures and corrections: an account served by v2 is regrouped right away (vectors it
 * already has), so the person never sees v1's per-message guesses for long; a debounced pass
 * (at most one per user per `delayMs`) adds new thoughts' Voyage vectors and regroups again. The
 * computation runs off the request thread. Disabled with THREAD_SHADOW_MINER=off. Failures are
 * logged, never surfaced.
 */
export function scheduleShadowMining(userId: string, open: (userId: string) => Database, delayMs = 120_000): void {
  if (process.env.THREAD_SHADOW_MINER === "off") return;
  if (servesV2(userId)) void minePass(userId, open, false);
  if (timers.has(userId)) return;
  const timer = setTimeout(() => {
    timers.delete(userId);
    void minePass(userId, open, true);
  }, delayMs);
  (timer as { unref?: () => void }).unref?.();
  timers.set(userId, timer);
}

/** Serve v2 for switched-over accounts; put v1 back for accounts switched off again. */
export function syncServing(userId: string, db: Database, ideas: ConsolidatedIdea[]): void {
  if (servesV2(userId)) {
    const r = materializeV2(db, ideas);
    console.log(`[Thread] serving v2 for ${userId}: ${r.served} ideas (${r.sparks} of them sparks)`);
  } else if (hasV1Backup(db) && restoreV1(db)) {
    console.log(`[Thread] v2 switched off for ${userId}: v1 ideas restored`);
  }
}
