import type { CanonicalEvent, CognitiveEvent, IdeaNode } from "../types";
import type { EmbeddingProvider } from "../providers/types";

/**
 * Deterministic prefilter for identity resolution (THREAD.md §9, §12). The spec describes
 * identity resolution as an ensemble of semantic + lexical + entity overlap + temporal proximity
 * + relationship traversal + explicit language + model reasoning -- sending every existing idea
 * to the model on every event doesn't scale past a handful of ideas. This module computes the
 * non-model signals and narrows the candidate list; the model (resolve.ts) still makes the final
 * call, this only decides who gets to be considered.
 *
 * Deliberately generous: a false negative here (excluding the idea that should have matched)
 * is much worse than a false positive (including one the model then correctly rejects), because
 * a false negative here is silently unrecoverable downstream -- the model never even sees the
 * candidate. So thresholds lean toward including too much rather than too little.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was",
  "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "i", "you", "we",
  "they", "he", "she", "not", "as", "at", "by", "from", "so", "if", "then", "than", "also", "just",
  "about", "into", "over", "there", "their", "them", "our", "your", "have", "has", "had", "do",
  "does", "did", "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "need", "needs", "needed", "want", "wants", "wanted", "get", "gets", "got", "make", "makes",
  "made", "like", "know", "think", "thinking", "really", "actually", "probably", "maybe",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** |A ∩ B| / |A ∪ B|. 0 when either set is empty. Also the content-fingerprint similarity in
 *  state/resolveConversationIdentity.ts. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenizing is a pure function of the text, and the same idea texts are compared against every new
 * thought -- so each string is split once and remembered, instead of once per comparison. Matching
 * a new thought against an account's ideas used to re-split every formulation of every idea (regex
 * work that dominated a capture and grew with the account). Results are identical. The sets are
 * shared: callers must not mutate them.
 */
const MAX_CACHED = 100_000;
const tokenCache = new Map<string, Set<string>>();
const entityCache = new Map<string, Set<string>>();

export function tokenSet(text: string): Set<string> {
  let s = tokenCache.get(text);
  if (!s) {
    if (tokenCache.size >= MAX_CACHED) tokenCache.clear();
    s = new Set(tokenize(text));
    tokenCache.set(text, s);
  }
  return s;
}

export function lexicalOverlap(a: string, b: string): number {
  return jaccard(tokenSet(a), tokenSet(b));
}

/** Crude proxy for named-entity overlap: capitalized tokens (mid-string), not stopwords. */
function extractEntityTokens(text: string): Set<string> {
  let s = entityCache.get(text);
  if (!s) {
    if (entityCache.size >= MAX_CACHED) entityCache.clear();
    const matches = text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? [];
    s = new Set(matches.map((m) => m.toLowerCase()).filter((t) => !STOPWORDS.has(t)));
    entityCache.set(text, s);
  }
  return s;
}

export function entityOverlap(a: string, b: string): number {
  return jaccard(extractEntityTokens(a), extractEntityTokens(b));
}

/** Exponential decay by days apart. 1.0 at zero distance, ~0.5 at halfLifeDays. */
export function temporalProximity(aIso: string, bIso: string, halfLifeDays = 14): number {
  const aTime = new Date(aIso).getTime();
  const bTime = new Date(bIso).getTime();
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
  const daysApart = Math.abs(aTime - bTime) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, daysApart / halfLifeDays);
}

/** Mild prior favoring ideas that already have relationships -- a weak signal, weighted low. */
export function relationshipBoost(idea: IdeaNode): number {
  return Math.min(idea.relatedIdeaIds.length, 3) / 3;
}

export interface CandidateScore {
  idea: IdeaNode;
  score: number;
  signals: { lexical: number; entity: number; temporal: number; relationship: number; semantic?: number };
}

export interface RankOptions {
  embeddingProvider?: EmbeddingProvider;
  halfLifeDays?: number;
}

const WEIGHTS = { lexical: 0.4, entity: 0.3, temporal: 0.1, relationship: 0.1, semantic: 0.4 };

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * Scores every existing idea against a new cognitive event. Does NOT decide anything -- narrowing
 * and the final match decision are separate steps (narrowCandidates, then resolve.ts).
 */
export async function rankCandidates(
  event: CognitiveEvent,
  sourceEvent: CanonicalEvent,
  ideas: IdeaNode[],
  options: RankOptions = {},
): Promise<CandidateScore[]> {
  const scored: CandidateScore[] = [];

  // Embed the event statement ONCE, not once per idea -- semanticScore used to re-embed it inside
  // the loop, so an account with 40 ideas paid 40 identical event embeddings per cognitive event.
  const eventVec = options.embeddingProvider
    ? await options.embeddingProvider.embed(event.statement)
    : null;

  for (const idea of ideas) {
    const lastEvolutionTime = idea.evolution.at(-1)?.createdAt ?? idea.createdAt;
    // Everything the idea has been called, not only its latest wording: a refinement of an idea
    // often echoes its title or an earlier formulation more than whatever was said last. Max, not
    // a concatenation, so the score scale (and the signal gate's threshold on it) is unchanged.
    const texts = [idea.currentFormulation, idea.title, ...idea.evolution.map((s) => s.formulation)];
    const signals: CandidateScore["signals"] = {
      lexical: Math.max(...texts.map((t) => lexicalOverlap(event.statement, t))),
      entity: Math.max(...texts.map((t) => entityOverlap(event.statement, t))),
      temporal: temporalProximity(sourceEvent.createdAt, lastEvolutionTime, options.halfLifeDays),
      relationship: relationshipBoost(idea),
    };

    const weightsUsed: { weight: number; value: number }[] = [
      { weight: WEIGHTS.lexical, value: signals.lexical },
      { weight: WEIGHTS.entity, value: signals.entity },
      { weight: WEIGHTS.temporal, value: signals.temporal },
      { weight: WEIGHTS.relationship, value: signals.relationship },
    ];

    if (options.embeddingProvider && eventVec) {
      const ideaVec = await options.embeddingProvider.embed(idea.currentFormulation);
      signals.semantic = cosine(eventVec, ideaVec);
      weightsUsed.push({ weight: WEIGHTS.semantic, value: signals.semantic });
    }

    const totalWeight = weightsUsed.reduce((sum, w) => sum + w.weight, 0);
    const score = totalWeight === 0 ? 0 : weightsUsed.reduce((sum, w) => sum + w.weight * w.value, 0) / totalWeight;

    scored.push({ idea, score, signals });
  }

  return scored.sort((a, b) => b.score - a.score);
}

export interface NarrowOptions {
  maxCandidates?: number;
  minScore?: number;
  /** The top-N ranked ideas are kept below `minScore` as long as they clear `keepFloor`. Default 5. */
  alwaysKeep?: number;
  /** Minimum score for the always-kept top few -- roughly "touched within the last month". Default 0.01. */
  keepFloor?: number;
}

/**
 * Narrows a ranked list before it goes to the model. Deliberately generous (see module doc) --
 * this is a scale mechanism, not a decision mechanism.
 */
export function narrowCandidates(
  ranked: CandidateScore[],
  options: NarrowOptions = {},
): CandidateScore[] {
  const maxCandidates = options.maxCandidates ?? 12;
  const minScore = options.minScore ?? 0.05;
  // Without an embeddings provider there's no semantic signal, so the same idea in different
  // words can score ~0 lexically. The model is the real judge and is instructed to be
  // conservative, so a slightly wider net here costs a few prompt tokens, while a candidate
  // dropped here is a duplicate idea nothing downstream can catch. Keep the floor-free top few.
  // "Some signal" still means some: an idea with no shared words and no recent activity at all
  // isn't worth a reasoning call (a genuinely new topic must stay free).
  const alwaysKeep = options.alwaysKeep ?? 5;
  const keepFloor = options.keepFloor ?? 0.01;
  return ranked
    .filter((c, i) => (i < alwaysKeep && c.score >= keepFloor) || c.score >= minScore)
    .slice(0, maxCandidates);
}
