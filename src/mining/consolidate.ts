import { tokenize } from "../identity/signals";
import type { CognitiveEventType, IdeaNode, IdeaState } from "../types";

/**
 * v2 idea mining: "capture fast, think overnight". Ideas are not decided one message at a time
 * (v1 -- order-dependent, irreversible); they are RECOMPUTED from every grounded thought at once,
 * so a grouping mistake is fixed by the next pass instead of compounding, and user corrections
 * are constraints every pass respects.
 *
 * Shape of the algorithm (IBIS + Minto's bottom-up grouping):
 *  1. ANCHORS -- thoughts that state what an idea is (new_idea, claim, refinement, contradiction,
 *     decision) -- are grouped by meaning: on-device Apple vectors when the Mac has supplied them,
 *     word overlap otherwise, plus conversational proximity.
 *  2. SATELLITES -- thoughts ABOUT an idea (question, open_loop, rejection, resolution,
 *     connection) -- attach to the anchor group they're about, strongly helped by context: a
 *     question asked right after an idea in the same conversation is almost always about it.
 *  3. STATE is derived per group with history kept: the current position is the latest
 *     positional thought, each answer closes the one question it answers, a rejected OPTION
 *     never marks the whole idea rejected, a contradiction contests it until answered.
 *  4. SPARKS: a lone thought that nobody came back to stays a spark (kept, shown separately)
 *     until it recurs; an idea is something you return to, decide about, or state firmly.
 *
 * Pure and deterministic: same thoughts + vectors + constraints in, same ideas out.
 */

export interface MiningThought {
  id: string;
  type: CognitiveEventType;
  statement: string;
  title?: string;
  persistence: "high" | "medium" | "low";
  sourceEventId: string;
  conversationId: string;
  /** Message position within its conversation. */
  position: number;
  createdAt: string;
  /** For claims: an OPTION being weighed or a REASON is about the idea but isn't where it stands. */
  role?: "position" | "option" | "reason";
  /** Adopted from an AI suggestion (grounded at extraction) -- kept, even when said once. */
  adopted?: boolean;
}

export interface Constraints {
  /** Thought pairs a person said belong together (a merge). */
  mustLink?: [string, string][];
  /** Thought pairs a person said are different ideas (a split). */
  cannotLink?: [string, string][];
}

export interface ConsolidateOptions {
  /** On-device vectors by thought id (one model). Absent -> word overlap only. */
  vectors?: Map<string, Float32Array | number[]>;
  constraints?: Constraints;
  /** Existing idea ids by thought id, so recomputed ideas keep their ids (pins, renames, links). */
  previousIdeaOf?: Map<string, string>;
  /** Anchor grouping threshold on the combined similarity. */
  anchorThreshold?: number;
  /** Below this, a satellite becomes its own idea instead of attaching. */
  attachFloor?: number;
}

export interface ConsolidatedIdea {
  node: IdeaNode;
  /** All thought ids in the idea, oldest first. */
  thoughtIds: string[];
  isSpark: boolean;
}

const ANCHOR_TYPES: ReadonlySet<CognitiveEventType> = new Set(["new_idea", "claim", "refinement", "contradiction", "decision"]);
/** Does this thought state where the idea stands? Options and reasons are about it, not it. */
function isPositional(t: MiningThought): boolean {
  return ANCHOR_TYPES.has(t.type) && !(t.type === "claim" && (t.role === "option" || t.role === "reason"));
}

// ------------------------------------------------------------------------------- similarity

/** Loose word-form equality: exact, or a long shared beginning -- at least 4 letters and most of
 *  the shorter word ("pricing" ~ "price", "verify" ~ "verification", but not "seat" ~ "search"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k >= 4 && k >= 0.6 * Math.min(a.length, b.length);
}

/** Overlap coefficient with stemming: shared words / words in the SHORTER statement. Unlike
 *  Jaccard, a short question isn't penalised for being short. */
export function wordSimilarity(a: string, b: string): number {
  return wordSimilarityOf([...new Set(tokenize(a))], [...new Set(tokenize(b))]);
}

function wordSimilarityOf(A: string[], B: string[]): number {
  if (A.length === 0 || B.length === 0) return 0;
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  const shared = small.filter((w) => big.some((x) => sameWord(w, x))).length;
  return shared / small.length;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Mean-centre vectors against the user's own thoughts. Apple's contextual embeddings put every
 *  pair at ~0.85-0.93 raw cosine; removing the shared "generic English" direction spreads real
 *  matches away from unrelated pairs (the same correction Thread for Mac's search applies). */
function centered(vectors: Map<string, ArrayLike<number>>): Map<string, Float64Array> {
  const all = [...vectors.values()];
  const out = new Map<string, Float64Array>();
  if (all.length === 0) return out;
  const d = all[0]!.length;
  const mean = new Float64Array(d);
  for (const v of all) for (let i = 0; i < d; i++) mean[i]! += v[i]! / all.length;
  for (const [id, v] of vectors) {
    if (v.length !== d) continue;
    const c = new Float64Array(d);
    for (let i = 0; i < d; i++) c[i] = v[i]! - mean[i]!;
    out.set(id, c);
  }
  return out;
}

class Similarity {
  private readonly vec: Map<string, Float64Array>;
  private readonly cache = new Map<string, number>();
  private readonly words = new Map<string, string[]>();
  constructor(private readonly byId: Map<string, MiningThought>, vectors?: Map<string, ArrayLike<number>>) {
    this.vec = vectors && vectors.size > 1 ? centered(vectors) : new Map();
    for (const [id, t] of byId) this.words.set(id, [...new Set(tokenize(t.statement))]);
  }

  /** Meaning (when both thoughts have vectors) blended with words, plus conversational context. */
  between(a: string, b: string): number {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const ta = this.byId.get(a)!;
    const tb = this.byId.get(b)!;
    const words = wordSimilarityOf(this.words.get(a)!, this.words.get(b)!);
    const va = this.vec.get(a);
    const vb = this.vec.get(b);
    // Centred cosine: ~0.25+ is a real match, <= 0 unrelated. Map to 0..1 around that.
    const meaning = va && vb ? Math.max(0, Math.min(1, cosine(va, vb) / 0.45)) : null;
    const base = meaning === null ? words : 0.65 * meaning + 0.35 * words;
    const s = Math.min(1, base + this.context(ta, tb));
    this.cache.set(key, s);
    return s;
  }

  /** Same conversation, close together -> probably the same line of thought. */
  private context(a: MiningThought, b: MiningThought): number {
    if (a.conversationId !== b.conversationId) return 0;
    const gap = Math.abs(a.position - b.position);
    return gap <= 2 ? 0.3 : gap <= 6 ? 0.15 : 0.05;
  }
}

// ------------------------------------------------------------------------------- grouping

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * Average-linkage agglomerative grouping of anchors: repeatedly merge the two groups with the
 * highest average pairwise similarity, until none clears `threshold`. Cannot-link pairs veto a
 * merge; must-link pairs start out merged. Order-independent: the result doesn't depend on which
 * conversation arrived first.
 */
function groupAnchors(anchors: string[], sim: Similarity, threshold: number, constraints: Constraints): string[][] {
  const uf = new UnionFind();
  const anchorSet = new Set(anchors);
  for (const [a, b] of constraints.mustLink ?? []) if (anchorSet.has(a) && anchorSet.has(b)) uf.union(a, b);
  const cannot = new Set((constraints.cannotLink ?? []).map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));

  const seed = new Map<string, string[]>();
  for (const a of anchors) {
    const r = uf.find(a);
    seed.set(r, [...(seed.get(r) ?? []), a]);
  }
  const groups: (string[] | null)[] = [...seed.values()];
  const n = groups.length;
  // Pairwise similarity SUMS between groups, updated in place on each merge (Lance-Williams for
  // average linkage): the average is sum / (|g| * |h|). O(n^2) memory and per-merge work instead
  // of recomputing every pair of members on every iteration.
  const sum: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  const veto: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      let v = 0;
      for (const x of groups[i]!) for (const y of groups[j]!) {
        s += sim.between(x, y);
        if (cannot.has(x < y ? `${x}|${y}` : `${y}|${x}`)) v = 1;
      }
      sum[i]![j] = sum[j]![i] = s;
      veto[i]![j] = veto[j]![i] = v;
    }
  }

  for (;;) {
    let bi = -1, bj = -1, best = threshold;
    for (let i = 0; i < n; i++) {
      const gi = groups[i];
      if (!gi) continue;
      for (let j = i + 1; j < n; j++) {
        const gj = groups[j];
        if (!gj || veto[i]![j]) continue;
        const avg = sum[i]![j]! / (gi.length * gj.length);
        if (avg >= best) {
          best = avg;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;
    groups[bi] = [...groups[bi]!, ...groups[bj]!];
    groups[bj] = null;
    for (let k = 0; k < n; k++) {
      if (k === bi || !groups[k]) continue;
      sum[bi]![k] = sum[k]![bi] = sum[bi]![k]! + sum[bj]![k]!;
      veto[bi]![k] = veto[k]![bi] = veto[bi]![k]! | veto[bj]![k]!;
    }
  }
  return groups.filter((g): g is string[] => g !== null);
}

// ------------------------------------------------------------------------------- the pass

export function consolidate(thoughts: MiningThought[], options: ConsolidateOptions = {}): ConsolidatedIdea[] {
  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const sim = new Similarity(byId, options.vectors as Map<string, ArrayLike<number>> | undefined);
  const constraints = options.constraints ?? {};
  const hasVectors = !!options.vectors && options.vectors.size > 1;
  const anchorThreshold = options.anchorThreshold ?? (hasVectors ? 0.42 : 0.5);
  const attachFloor = options.attachFloor ?? 0.2;
  const time = (id: string) => byId.get(id)!.createdAt;

  const anchors = thoughts.filter((t) => ANCHOR_TYPES.has(t.type)).map((t) => t.id);
  const groups = groupAnchors(anchors, sim, anchorThreshold, constraints);

  // Satellites attach to the group they're most about. Answers prefer the group holding the
  // question they answer, so a resolution lands where its question is.
  const satellites = thoughts.filter((t) => !ANCHOR_TYPES.has(t.type)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const cannot = new Set((constraints.cannotLink ?? []).map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (const s of satellites) {
    let best = -1;
    let bestScore = 0;
    groups.forEach((g, i) => {
      if (g.some((x) => cannot.has(x < s.id ? `${x}|${s.id}` : `${s.id}|${x}`))) return;
      // Max, not average: a question is about one specific anchor, not the group's centroid.
      const score = Math.max(...g.map((x) => sim.between(s.id, x)));
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best >= 0 && bestScore >= attachFloor) {
      groups[best]!.push(s.id);
      groupOf.set(s.id, best);
    } else {
      groups.push([s.id]);
      groupOf.set(s.id, groups.length - 1);
    }
  }

  return groups.map((g) => g.sort((a, b) => time(a).localeCompare(time(b)) || a.localeCompare(b))).map((ids) => buildIdea(ids, byId, sim, options.previousIdeaOf));
}

/** One group of thoughts -> an idea, with its history kept (nothing is overwritten). */
function buildIdea(
  ids: string[],
  byId: Map<string, MiningThought>,
  sim: Similarity,
  previousIdeaOf?: Map<string, string>,
): ConsolidatedIdea {
  const ts = ids.map((id) => byId.get(id)!);
  const first = ts[0]!;
  const positional = ts.filter(isPositional);
  const current = positional.at(-1) ?? ts.at(-1)!;
  const founder = ts.find((t) => t.type === "new_idea") ?? positional[0] ?? first;

  // Questions stay open until an answer that's about THEM arrives.
  const loops: IdeaNode["openLoops"] = [];
  for (const t of ts) {
    if (t.type === "question" || t.type === "open_loop") {
      loops.push({ id: `loop_${t.id}`, statement: t.statement, createdAt: t.createdAt, resolved: false });
    } else if (t.type === "contradiction") {
      loops.push({ id: `loop_${t.id}`, statement: `Unresolved contradiction: ${t.statement}`, createdAt: t.createdAt, resolved: false });
    } else if (t.type === "resolution") {
      const open = loops.filter((l) => !l.resolved);
      if (open.length === 0) continue;
      let pick = open.at(-1)!;
      let bestScore = 0;
      for (const l of open) {
        const s = sim.between(t.id, l.id.slice("loop_".length));
        if (s > bestScore) {
          bestScore = s;
          pick = l;
        }
      }
      pick.resolved = true;
    }
  }

  const decisions = ts
    .filter((t) => t.type === "decision")
    .map((t) => ({ id: `dec_${t.id}`, statement: t.statement, decidedAt: t.createdAt, sourceEventId: t.sourceEventId }));

  let state: IdeaState = "developing";
  if (decisions.length > 0) state = "established";
  if (loops.some((l) => !l.resolved && l.statement.startsWith("Unresolved contradiction:"))) state = "contested";
  // A rejection inside an idea rejects an OPTION, never the idea itself (only the person can).

  // Keep the id the person already knows this idea by (pins, renames, links), else the v1 scheme.
  const votes = new Map<string, number>();
  for (const id of ids) {
    const prev = previousIdeaOf?.get(id);
    if (prev) votes.set(prev, (votes.get(prev) ?? 0) + 1);
  }
  const keptId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const distinctConversations = new Set(ts.map((t) => t.conversationId)).size;
  const isSpark =
    ts.length === 1 &&
    !(first.type === "decision") &&
    !first.adopted &&
    !(first.type === "new_idea" && first.persistence === "high") &&
    distinctConversations === 1;

  const node: IdeaNode = {
    id: keptId ?? `idea_${founder.id}`,
    title: founder.title ?? titleFrom(founder.statement),
    state,
    currentFormulation: current.statement,
    evolution: ts.map((t) => ({ cognitiveEventId: t.id, formulation: t.statement, createdAt: t.createdAt, sourceEventId: t.sourceEventId })),
    openLoops: loops,
    decisions,
    relatedIdeaIds: [],
    createdAt: first.createdAt,
    updatedAt: ts.at(-1)!.createdAt,
  };
  return { node, thoughtIds: ids, isSpark };
}

function titleFrom(statement: string): string {
  const words = statement.replace(/[.?!]+$/, "").split(/\s+/);
  return words.length <= 8 ? words.join(" ") : `${words.slice(0, 8).join(" ")}…`;
}
