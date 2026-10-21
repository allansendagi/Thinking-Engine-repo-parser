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
  /** The message where the person asked the question this thought answers (validated at extraction). */
  answersEventId?: string;
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
  /** How much meaning counts against words (0..1). Set per vector model by how well it
   *  separates ideas on the bench -- see meaningWeightFor. */
  meaningWeight?: number;
  /** Ideas whose thoughts are, on average, at least this similar share a THEME (shown as related
   *  ideas). People judge "same idea" on two levels -- one idea, or the same broader subject --
   *  so one threshold can't serve both. Absent -> no themes. */
  themeThreshold?: number;
}

export interface ConsolidatedIdea {
  node: IdeaNode;
  /** All thought ids in the idea, oldest first. */
  thoughtIds: string[];
  isSpark: boolean;
  /** The thought that founded the idea (its first statement of what the idea is). */
  founderId: string;
  /** Index of the theme this idea belongs to (ideas sharing it are related); absent without themes. */
  theme?: number;
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

function wordSimilarityOf(A: string[], B: string[], weight: (w: string) => number = () => 1): number {
  if (A.length === 0 || B.length === 0) return 0;
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  let shared = 0;
  let total = 0;
  for (const w of small) {
    const k = weight(w);
    total += k;
    if (big.some((x) => sameWord(w, x))) shared += k;
  }
  return total === 0 ? 0 : shared / total;
}

/** Word-family key for document frequency: the shared-beginning rule of sameWord, approximated. */
const family = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

/** Above this many thoughts the pair cache (n^2 floats) would cost too much memory; pairs are
 *  then recomputed when asked again (correct, just slower). 3000 thoughts = 72 MB. */
const MAX_CACHED_THOUGHTS = 3000;

class Similarity {
  private readonly index = new Map<string, number>();
  private readonly ts: MiningThought[] = [];
  private readonly wordsOf: string[][] = [];
  private readonly vecOf: (Float64Array | null)[] = [];
  private readonly normOf: number[] = [];
  /** Pair similarities by index (i * n + j, i < j); NaN = not computed yet. */
  private readonly cache: Float64Array | null;
  constructor(
    byId: Map<string, MiningThought>,
    vectors?: Map<string, ArrayLike<number>>,
    private readonly meaningWeight = 0.65,
  ) {
    const vec = vectors && vectors.size > 1 && meaningWeight > 0 ? centered(vectors) : new Map<string, Float64Array>();
    for (const [id, t] of byId) {
      this.index.set(id, this.ts.length);
      this.ts.push(t);
      this.wordsOf.push([...new Set(tokenize(t.statement))]);
      const v = vec.get(id) ?? null;
      this.vecOf.push(v);
      let n = 0;
      if (v) for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
      this.normOf.push(n);
    }
    // Rare words carry the topic; words this person uses everywhere ("first", "team", "users")
    // don't. IDF over the person's own thoughts, so it adapts to their vocabulary.
    const df = new Map<string, number>();
    for (const ws of this.wordsOf) for (const f of new Set(ws.map(family))) df.set(f, (df.get(f) ?? 0) + 1);
    const n = Math.max(1, this.wordsOf.length);
    this.idf = (w) => Math.log(1 + n / (df.get(family(w)) ?? 1));
    const size = this.ts.length;
    this.cache = size <= MAX_CACHED_THOUGHTS ? new Float64Array(size * size).fill(Number.NaN) : null;
  }
  private readonly idf: (w: string) => number;

  /** Meaning (when both thoughts have vectors) blended with words, plus conversational context. */
  between(a: string, b: string): number {
    const i = this.index.get(a)!;
    const j = this.index.get(b)!;
    return i < j ? this.at(i, j) : this.at(j, i);
  }

  /** Similarity of thoughts i < j (by index). Computed once, in one fixed order, so it is symmetric. */
  private at(i: number, j: number): number {
    const n = this.ts.length;
    const hit = this.cache?.[i * n + j];
    if (hit !== undefined && !Number.isNaN(hit)) return hit;
    const words = wordSimilarityOf(this.wordsOf[i]!, this.wordsOf[j]!, this.idf);
    const va = this.vecOf[i], vb = this.vecOf[j];
    let meaning: number | null = null;
    if (va && vb) {
      let dot = 0;
      for (let k = 0; k < va.length; k++) dot += va[k]! * vb[k]!;
      const na = this.normOf[i]!, nb = this.normOf[j]!;
      const cos = na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
      // Centred cosine: ~0.25+ is a real match, <= 0 unrelated. Map to 0..1 around that.
      meaning = Math.max(0, Math.min(1, cos / 0.45));
    }
    const base = meaning === null ? words : this.meaningWeight * meaning + (1 - this.meaningWeight) * words;
    const s = Math.min(1, base + this.context(this.ts[i]!, this.ts[j]!));
    if (this.cache) this.cache[i * n + j] = s;
    return this.cache ? this.cache[i * n + j]! : s;
  }

  /** Same conversation, close together -> probably the same line of thought. Never between two
   *  NEW ideas: introducing one is, by definition, not continuing the other. */
  private context(a: MiningThought, b: MiningThought): number {
    if (a.conversationId !== b.conversationId) return 0;
    if (a.type === "new_idea" && b.type === "new_idea") return 0;
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
  return agglomerate([...seed.values()], sim, threshold, cannot);
}

/** Average-linkage merging of seed groups until no pair's average similarity clears `threshold`. */
function agglomerate(seeds: string[][], sim: Similarity, threshold: number, cannot: Set<string>): string[][] {
  const groups: (string[] | null)[] = seeds.map((g) => [...g]);
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

  // Each live row's best partner to its right (highest average; ties -> the later partner), so a
  // merge rescans only the rows it affected instead of every pair: O(n^2) overall, not O(n^3).
  // Picks exactly the pair the full scan would (the last maximal pair in row-major order).
  const bestAvg = new Float64Array(n).fill(-Infinity);
  const bestJ = new Int32Array(n).fill(-1);
  const rescan = (i: number) => {
    bestAvg[i] = -Infinity;
    bestJ[i] = -1;
    const gi = groups[i];
    if (!gi) return;
    for (let j = i + 1; j < n; j++) {
      const gj = groups[j];
      if (!gj || veto[i]![j]) continue;
      const avg = sum[i]![j]! / (gi.length * gj.length);
      if (avg >= bestAvg[i]!) {
        bestAvg[i] = avg;
        bestJ[i] = j;
      }
    }
  };
  for (let i = 0; i < n; i++) rescan(i);

  for (;;) {
    let bi = -1, best = threshold;
    for (let i = 0; i < n; i++) {
      if (bestJ[i]! >= 0 && bestAvg[i]! >= best) {
        best = bestAvg[i]!;
        bi = i;
      }
    }
    if (bi < 0) break;
    const bj = bestJ[bi]!;
    groups[bi] = [...groups[bi]!, ...groups[bj]!];
    groups[bj] = null;
    for (let k = 0; k < n; k++) {
      if (k === bi || !groups[k]) continue;
      sum[bi]![k] = sum[k]![bi] = sum[bi]![k]! + sum[bj]![k]!;
      veto[bi]![k] = veto[k]![bi] = veto[bi]![k]! | veto[bj]![k]!;
    }
    rescan(bi);
    bestJ[bj] = -1;
    bestAvg[bj] = -Infinity;
    const gbi = groups[bi]!;
    for (let k = 0; k < bj; k++) {
      if (k === bi || !groups[k]) continue;
      if (bestJ[k] === bi || bestJ[k] === bj) {
        rescan(k); // its best partner changed size or vanished
      } else if (k < bi && !veto[k]![bi]) {
        const avg = sum[k]![bi]! / (groups[k]!.length * gbi.length);
        if (avg > bestAvg[k]! || (avg === bestAvg[k]! && bi > bestJ[k]!)) {
          bestAvg[k] = avg;
          bestJ[k] = bi;
        }
      } else if (k < bi && veto[k]![bi] && bestJ[k] === bi) {
        rescan(k);
      }
    }
  }
  return groups.filter((g): g is string[] => g !== null);
}

/**
 * How much a vector model's "meaning" may count, from what the bench measured (held-out seeds,
 * realistic paraphrase) -- a model is trusted only as far as it separates ideas.
 *  - apple:nlembedding.sentence.* (macOS's older sentence model, the fallback when the contextual
 *    asset isn't downloaded): AUC 0.69 same-vs-different idea; every weight > 0 scored worse than
 *    words alone. Not used.
 *  - other apple:* (NLContextualEmbedding, mean-pooled -- what real Macs run): AUC 0.81. Best at
 *    0.35: grouping F1 62.8 -> 65.4, "where I stand" 22.6% -> 28.0%, decisions 28.7% -> 41.3%, at
 *    the cost of more wrong merges (18 -> 26). Helpful, not sufficient: "partial".
 *  - voyage:* -- the cloud fallback. Full weight; scored by `bun run bench` whenever a key is set.
 */
export function meaningWeightFor(model: string | null): number {
  if (!model) return 0;
  if (model.startsWith("apple:nlembedding.sentence")) return 0;
  if (model.startsWith("apple:")) return 0.35;
  return 0.65;
}

/** Native models that measured good enough to stand alone (none yet -- see meaningWeightFor). */
export function nativeIsSufficient(model: string): boolean {
  return model.startsWith("apple:") && meaningWeightFor(model) >= 0.65;
}

/**
 * Which stored vector model to group with: a sufficient native model first; otherwise the cloud
 * fallback if the account has it; otherwise the best partial native model; otherwise none.
 */
export function chooseMeaningModel(models: string[], preferredVoyage: string = `voyage:${process.env.VOYAGE_MODEL ?? "voyage-4-large"}`): string | null {
  const usable = models.filter((m) => meaningWeightFor(m) > 0);
  // An account can hold vectors from more than one Voyage model (e.g. lite from before the default
  // changed). Take the configured one, never "whichever was stored first".
  return (
    usable.find(nativeIsSufficient) ??
    usable.find((m) => m === preferredVoyage) ??
    usable.find((m) => m.startsWith("voyage:")) ??
    usable.find((m) => m.startsWith("apple:")) ??
    null
  );
}

// ------------------------------------------------------------------------------- the pass

export function consolidate(thoughts: MiningThought[], options: ConsolidateOptions = {}): ConsolidatedIdea[] {
  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const meaningWeight = options.meaningWeight ?? 0.65;
  const sim = new Similarity(byId, options.vectors as Map<string, ArrayLike<number>> | undefined, meaningWeight);
  const constraints = options.constraints ?? {};
  // 0.35, with or without vectors: the best held-out setting on realistic paraphrase. Lower and
  // wrong merges climb fast; higher and ideas split into duplicates.
  const anchorThreshold = options.anchorThreshold ?? 0.35;
  const attachFloor = options.attachFloor ?? 0.2;
  const time = (id: string) => byId.get(id)!.createdAt;

  // A thought that names a question we have (whatever it was labelled -- an answer often reads as a
  // decision) is placed with that question, not grouped by how it sounds: it is a satellite of it.
  const questionMessages = new Set(thoughts.filter((t) => t.type === "question" || t.type === "open_loop").map((t) => t.sourceEventId));
  const answersAKnownQuestion = (t: MiningThought) => !!t.answersEventId && questionMessages.has(t.answersEventId);
  const isAnchor = (t: MiningThought) => ANCHOR_TYPES.has(t.type) && !answersAKnownQuestion(t);
  const anchors = thoughts.filter(isAnchor).map((t) => t.id);
  const groups = groupAnchors(anchors, sim, anchorThreshold, constraints);

  // Satellites attach to the group they're most about. Answers prefer the group holding the
  // question they answer, so a resolution lands where its question is.
  const satellites = thoughts.filter((t) => !isAnchor(t)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const cannot = new Set((constraints.cannotLink ?? []).map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (const s of satellites) {
    // An answer that names its question belongs with that question -- no guessing from similarity.
    if (s.answersEventId) {
      const home = groups.findIndex((g) =>
        g.some((x) => {
          const q = byId.get(x)!;
          return (q.type === "question" || q.type === "open_loop") && q.sourceEventId === s.answersEventId;
        }),
      );
      if (home >= 0 && !groups[home]!.some((x) => cannot.has(x < s.id ? `${x}|${s.id}` : `${s.id}|${x}`))) {
        groups[home]!.push(s.id);
        groupOf.set(s.id, home);
        continue;
      }
    }
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

  // A person's "these belong together" holds whatever kind of thought it names. Anchors honour
  // must-links while grouping; a question or open loop is only placed afterwards, so a merge
  // recorded against one (an idea whose oldest thought is a question) is applied here.
  const merged = new UnionFind();
  for (const [a, b] of constraints.mustLink ?? []) {
    const ga = groupOf.get(a), gb = groupOf.get(b);
    if (ga !== undefined && gb !== undefined && ga !== gb) merged.union(String(ga), String(gb));
  }
  const joined = new Map<string, string[]>();
  groups.forEach((g, i) => {
    const root = merged.find(String(i));
    joined.set(root, [...(joined.get(root) ?? []), ...g]);
  });
  const finalGroups = [...joined.values()];

  const sorted = finalGroups.map((g) => g.sort((a, b) => time(a).localeCompare(time(b)) || a.localeCompare(b)));
  const keptIds = assignKeptIds(sorted, byId, options.previousIdeaOf);
  const ideas = sorted.map((ids, i) => buildIdea(ids, byId, sim, keptIds[i]!));
  if (options.themeThreshold !== undefined) assignThemes(ideas, sim, options.themeThreshold);
  return ideas;
}

/** Most related ideas listed per idea: the rest of a big theme is noise, not help. */
const MAX_RELATED = 6;

/**
 * Second level: group whole ideas into themes (average linkage over their thoughts), then list
 * each idea's theme-mates as related, closest first. Ideas themselves are untouched -- a theme
 * never merges two ideas, it only says they're about the same subject.
 */
function assignThemes(ideas: ConsolidatedIdea[], sim: Similarity, threshold: number): void {
  const indexOf = new Map<string, number>();
  ideas.forEach((idea, i) => indexOf.set(idea.thoughtIds[0]!, i));
  // No vetoes: a split says two thoughts are different IDEAS, not that they're unrelated.
  const themes = agglomerate(ideas.map((i) => i.thoughtIds), sim, threshold, new Set());
  const avg = (a: ConsolidatedIdea, b: ConsolidatedIdea) => {
    let s = 0;
    for (const x of a.thoughtIds) for (const y of b.thoughtIds) s += sim.between(x, y);
    return s / (a.thoughtIds.length * b.thoughtIds.length);
  };
  themes.forEach((members, t) => {
    // A theme is a union of whole ideas: find them by their first thought.
    const mates = members.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined).map((i) => ideas[i]!);
    for (const idea of mates) {
      idea.theme = t;
      idea.node.relatedIdeaIds = mates
        .filter((m) => m !== idea)
        .map((m) => ({ id: m.node.id, s: avg(idea, m) }))
        .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
        .slice(0, MAX_RELATED)
        .map((m) => m.id);
    }
  });
}

/** The founding thought of a group: the idea's first statement, else its first position. */
function founderOf(ts: MiningThought[]): MiningThought {
  return ts.find((t) => t.type === "new_idea") ?? ts.filter(isPositional)[0] ?? ts[0]!;
}

/**
 * Keep the id the person already knows each idea by (pins, renames, links, kept ideas): each
 * group claims the previous id most of its thoughts had. When regrouping splits one old idea in
 * two, both halves claim it -- the half with more of its thoughts keeps it, the other takes its
 * next-best claim or a fresh id. Ids are unique by construction.
 */
function assignKeptIds(groups: string[][], byId: Map<string, MiningThought>, previousIdeaOf?: Map<string, string>): string[] {
  const claims: { group: number; id: string; votes: number }[] = [];
  groups.forEach((g, group) => {
    const votes = new Map<string, number>();
    for (const t of g) {
      const prev = previousIdeaOf?.get(t);
      if (prev) votes.set(prev, (votes.get(prev) ?? 0) + 1);
    }
    for (const [id, n] of votes) claims.push({ group, id, votes: n });
  });
  claims.sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id) || a.group - b.group);
  const out: (string | undefined)[] = new Array(groups.length);
  const taken = new Set<string>();
  for (const c of claims) {
    if (out[c.group] !== undefined || taken.has(c.id)) continue;
    out[c.group] = c.id;
    taken.add(c.id);
  }
  return groups.map((g, i) => {
    if (out[i]) return out[i]!;
    let id = `idea_${founderOf(g.map((t) => byId.get(t)!)).id}`;
    while (taken.has(id)) id += "_";
    taken.add(id);
    return id;
  });
}

/** One group of thoughts -> an idea, with its history kept (nothing is overwritten). */
function buildIdea(ids: string[], byId: Map<string, MiningThought>, sim: Similarity, ideaId: string): ConsolidatedIdea {
  const ts = ids.map((id) => byId.get(id)!);
  const first = ts[0]!;
  const positional = ts.filter(isPositional);
  const current = positional.at(-1) ?? ts.at(-1)!;
  const founder = founderOf(ts);

  // Questions stay open until an answer that's about THEM arrives.
  const loops: IdeaNode["openLoops"] = [];
  for (const t of ts) {
    if (t.type === "question" || t.type === "open_loop") {
      loops.push({ id: `loop_${t.id}`, statement: t.statement, createdAt: t.createdAt, resolved: false });
    } else if (t.type === "contradiction") {
      loops.push({ id: `loop_${t.id}`, statement: `Unresolved contradiction: ${t.statement}`, createdAt: t.createdAt, resolved: false });
    } else if (t.answersEventId) {
      // It names the question it answers (validated at extraction): close exactly that one, whatever
      // type the answer was labelled -- and nothing else. If that question isn't open in this idea
      // (the AI asked it, or it was never captured), this answers nothing here: guessing would close
      // an unrelated question, and losing track of a real open question is the worse mistake.
      const asked = loops.filter((l) => !l.resolved && byId.get(l.id.slice("loop_".length))?.sourceEventId === t.answersEventId);
      let pick = asked.at(-1);
      let bestScore = -1;
      for (const l of asked) {
        const sc = sim.between(t.id, l.id.slice("loop_".length));
        if (sc > bestScore) {
          bestScore = sc;
          pick = l;
        }
      }
      if (pick) {
        pick.resolved = true;
        pick.resolvedBy = t.id;
      }
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
      pick.resolvedBy = t.id;
    }
  }

  const decisions = ts
    .filter((t) => t.type === "decision")
    .map((t) => ({ id: `dec_${t.id}`, statement: t.statement, decidedAt: t.createdAt, sourceEventId: t.sourceEventId }));

  let state: IdeaState = "developing";
  if (decisions.length > 0) state = "established";
  if (loops.some((l) => !l.resolved && l.statement.startsWith("Unresolved contradiction:"))) state = "contested";
  // A rejection inside an idea rejects an OPTION, never the idea itself (only the person can).

  const distinctConversations = new Set(ts.map((t) => t.conversationId)).size;
  const isSpark =
    ts.length === 1 &&
    !(first.type === "decision") &&
    !first.adopted &&
    !(first.type === "new_idea" && first.persistence === "high") &&
    distinctConversations === 1;

  const node: IdeaNode = {
    id: ideaId,
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
  return { node, thoughtIds: ids, isSpark, founderId: founder.id };
}

function titleFrom(statement: string): string {
  const words = statement.replace(/[.?!]+$/, "").split(/\s+/);
  return words.length <= 8 ? words.join(" ") : `${words.slice(0, 8).join(" ")}…`;
}
