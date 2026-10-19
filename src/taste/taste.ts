import type { Database } from "bun:sqlite";
import { loadTasteLabels, type TasteLabels } from "../mining/corrections";
import { chooseMeaningModel } from "../mining/consolidate";
import { loadThoughtVectors, vectorModels } from "../db/thoughts";

/**
 * Personal taste: what THIS person keeps. "Is this an idea worth having?" is a judgment about
 * what matters to one person, not a property of the text -- measured on one person's own labels
 * the model alone got 54% of extracted thoughts right, and no universal rule helped without
 * losing real ideas. What does work is learning from the person's own clicks: a thought's
 * nearest labelled neighbours (by meaning vector, from OTHER conversations) predicted keep vs
 * not-an-idea at ~0.74-0.80 AUC, versus 0.5 for chance. So taste SORTS, it never deletes: at ~50
 * labels a hard cut-off lost real ideas (removing 7/23 junk lost 3/27 real), so low scores go to a
 * recoverable "Maybe" tray, and the person's explicit Keep always wins.
 */

/** Both classes need this many labelled ideas before taste is trusted at all. */
export const MIN_LABELS_PER_CLASS = 6;
/** Nearest labelled neighbours consulted per thought. */
export const NEIGHBOURS = 5;
/** Score (share of neighbours that were kept) at/above which an idea is "likely", at/below "unlikely". */
export const LIKELY_AT = 0.6;
export const UNLIKELY_AT = 0.2;

/**
 * - confirmed: the person said Keep.
 * - likely / unsure / unlikely: taste's guess (unlikely goes to the Maybe tray).
 * - suggested: no guess yet (not enough labels, or no vectors) -- shown, labelled as a suggestion.
 */
export type Tier = "confirmed" | "likely" | "unsure" | "unlikely" | "suggested";

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    s += p * q; x += p * p; y += q * q;
  }
  return x && y ? s / Math.sqrt(x * y) : 0;
}

/**
 * Share of the `k` nearest LABELLED thoughts (excluding the thought itself) that were kept.
 * null when the thought has no vector or there is nothing to compare with.
 */
export function thoughtTaste(
  thoughtId: string,
  vectors: Map<string, ArrayLike<number>>,
  positives: Set<string>,
  negatives: Set<string>,
  k = NEIGHBOURS,
): number | null {
  const v = vectors.get(thoughtId);
  if (!v) return null;
  const scored: { sim: number; kept: boolean }[] = [];
  for (const [id, vec] of vectors) {
    if (id === thoughtId) continue;
    const kept = positives.has(id);
    if (!kept && !negatives.has(id)) continue;
    scored.push({ sim: cosine(v, vec), kept });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, k);
  return top.filter((n) => n.kept).length / top.length;
}

export function tierFor(score: number | null): Tier {
  if (score === null) return "suggested";
  if (score >= LIKELY_AT) return "likely";
  if (score <= UNLIKELY_AT) return "unlikely";
  return "unsure";
}

export interface IdeaTaste {
  ideaId: string;
  tier: Tier;
  /** Mean taste of the idea's thoughts, 0..1; null when taste has no opinion. */
  score: number | null;
}

export interface TasteReport {
  /** Enough labels of both kinds that taste is trusted. */
  ready: boolean;
  keeps: number;
  notIdeas: number;
  /** Share of the person's last `window` verdicts that were Keep -- the live quality number. */
  acceptanceRate: number | null;
  window: number;
  ideas: IdeaTaste[];
}

export const ACCEPTANCE_WINDOW = 20;

/** Pure core: ideas (with their thought ids) + labels + vectors -> a tier per idea. */
export function buildTasteReport(
  ideas: { id: string; thoughtIds: string[] }[],
  labels: TasteLabels,
  vectors: Map<string, ArrayLike<number>>,
): TasteReport {
  const keeps = labels.history.filter((h) => h.verdict === "keep").length + labels.reviewed.keeps + labels.taught.keeps;
  const notIdeas = labels.history.filter((h) => h.verdict === "not_idea").length + labels.reviewed.notIdeas + labels.taught.notIdeas;
  const ready = keeps >= MIN_LABELS_PER_CLASS && notIdeas >= MIN_LABELS_PER_CLASS;
  const recent = labels.history.slice(-ACCEPTANCE_WINDOW);
  const acceptanceRate = recent.length ? recent.filter((h) => h.verdict === "keep").length / recent.length : null;

  const out: IdeaTaste[] = ideas.map((idea) => {
    // By id, or by thought: a regrouping pass can give a kept idea a new id, never new thoughts.
    if (labels.keptIdeaIds.has(idea.id) || idea.thoughtIds.some((t) => labels.keptThoughtIds.has(t))) {
      return { ideaId: idea.id, tier: "confirmed", score: 1 };
    }
    if (!ready) return { ideaId: idea.id, tier: "suggested", score: null };
    const scores = idea.thoughtIds
      .map((t) => thoughtTaste(t, vectors, labels.positives, labels.negatives))
      .filter((s): s is number => s !== null);
    const score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return { ideaId: idea.id, tier: tierFor(score), score };
  });
  return { ready, keeps, notIdeas, acceptanceRate, window: ACCEPTANCE_WINDOW, ideas: out };
}

/** Database wrapper: this person's ideas, labels and the account's meaning vectors. */
export function tasteReport(db: Database): TasteReport {
  const labels = loadTasteLabels(db);
  const model = chooseMeaningModel(vectorModels(db));
  const vectors: Map<string, ArrayLike<number>> = model ? loadThoughtVectors(db, model) : new Map();
  const steps = db.query("SELECT idea_id, cognitive_event_id FROM evolution_steps").all() as { idea_id: string; cognitive_event_id: string }[];
  const byIdea = new Map<string, string[]>();
  for (const s of steps) (byIdea.get(s.idea_id) ?? byIdea.set(s.idea_id, []).get(s.idea_id)!).push(s.cognitive_event_id);
  const ideas = (db.query("SELECT id FROM idea_nodes").all() as { id: string }[]).map((i) => ({ id: i.id, thoughtIds: byIdea.get(i.id) ?? [] }));
  return buildTasteReport(ideas, labels, vectors);
}
