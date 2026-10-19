import type { Database } from "bun:sqlite";
import { loadCanonicalEventsByIds, loadIdeas } from "../db/queries";
import { loadThoughtVectors, vectorModels } from "../db/thoughts";
import { chooseMeaningModel, cosine } from "../mining/consolidate";
import { searchIdeas } from "../mcp/tools";
import type { IdeaNode } from "../types";

/**
 * "What do I actually think about X?" -- answered from the person's own captured thinking, never
 * from a model's general knowledge: where they stand, how they got there, what they decided, what
 * is still open, each point linked to the conversation it came from. Extractive by design: no
 * model writes the answer, so it can't put words in the person's mouth, and it costs nothing
 * beyond embedding the question (Voyage, when the account's thoughts have Voyage vectors).
 */

export interface Moment {
  statement: string;
  at: string;
  source: string | null;
  sourceUrl: string | null;
  conversationId: string | null;
}

export interface Stance {
  ideaId: string;
  title: string;
  state: string;
  /** 0..1, how close the idea is to the question. */
  relevance: number;
  /** Where the person stands now, in their own words. */
  stance: string;
  decisions: Moment[];
  /** Earlier positions, oldest first -- how they got to the stance. */
  path: Moment[];
  openQuestions: { statement: string; raisedAt: string }[];
  related: { id: string; title: string }[];
}

export interface AskAnswer {
  query: string;
  /** "meaning" when ranked by meaning vectors, "words" when only by shared words. */
  method: "meaning" | "words";
  ideas: Stance[];
  /** Across the ideas returned: how much thinking this rests on. */
  conversations: number;
  tools: string[];
  firstAt: string | null;
  lastAt: string | null;
}

const MAX_IDEAS = 5;
/** Ideas within this much of the best match are returned too (relative, so it adapts per model). */
const RELATIVE_BAND = 0.12;
const MAX_PATH = 5;

/**
 * @param embedQuery returns the question's vector in `model`'s space, or null to rank by words.
 */
export async function askMyThinking(
  db: Database,
  query: string,
  embedQuery?: (q: string, model: string) => Promise<number[] | null>,
): Promise<AskAnswer> {
  const ideas = loadIdeas(db);
  const byId = new Map(ideas.map((i) => [i.id, i]));
  let ranked: { idea: IdeaNode; score: number }[] = [];
  let method: AskAnswer["method"] = "words";

  const model = chooseMeaningModel(vectorModels(db));
  const qv = model && embedQuery ? await embedQuery(query, model).catch(() => null) : null;
  if (model && qv) {
    const vectors = loadThoughtVectors(db, model);
    ranked = ideas
      .map((idea) => {
        const scores = idea.evolution.map((s) => vectors.get(s.cognitiveEventId)).filter((v): v is Float32Array => !!v).map((v) => cosine(qv, v));
        return { idea, score: scores.length ? Math.max(...scores) : -1 };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) method = "meaning";
  }
  if (method === "words") {
    ranked = searchIdeas(db, query, MAX_IDEAS * 2).map((r) => ({ idea: byId.get(r.id)!, score: r.score })).filter((r) => r.idea);
  }
  const top = ranked[0]?.score ?? 0;
  const chosen = ranked.filter((r) => r.score >= top - RELATIVE_BAND).slice(0, MAX_IDEAS);

  const events = new Map(
    loadCanonicalEventsByIds(db, chosen.flatMap((r) => r.idea.evolution.map((s) => s.sourceEventId))).map((e) => [e.id, e]),
  );
  const moment = (statement: string, at: string, sourceEventId: string): Moment => {
    const e = events.get(sourceEventId);
    return { statement, at, source: e?.source ?? null, sourceUrl: e?.sourceUrl ?? null, conversationId: e?.conversationId ?? null };
  };
  const typeOf = new Map((db.query("SELECT id, type FROM cognitive_events").all() as { id: string; type: string }[]).map((r) => [r.id, r.type]));
  const POSITIONAL = new Set(["new_idea", "claim", "refinement", "contradiction"]);

  const out: Stance[] = chosen.map(({ idea, score }) => {
    const positional = idea.evolution.filter((s) => POSITIONAL.has(typeOf.get(s.cognitiveEventId) ?? ""));
    const earlier = positional.filter((s) => s.formulation !== idea.currentFormulation);
    return {
      ideaId: idea.id,
      title: idea.title,
      state: idea.state,
      relevance: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100,
      stance: idea.currentFormulation,
      decisions: idea.decisions.map((d) => moment(d.statement, d.decidedAt, d.sourceEventId)),
      path: earlier.slice(-MAX_PATH).map((s) => moment(s.formulation, s.createdAt, s.sourceEventId)),
      openQuestions: idea.openLoops.filter((l) => !l.resolved).map((l) => ({ statement: l.statement, raisedAt: l.createdAt })),
      related: idea.relatedIdeaIds.map((id) => byId.get(id)).filter((r): r is IdeaNode => !!r).map((r) => ({ id: r.id, title: r.title })),
    };
  });

  const steps = chosen.flatMap((r) => r.idea.evolution);
  const evs = steps.map((s) => events.get(s.sourceEventId)).filter((e) => !!e);
  const times = steps.map((s) => s.createdAt).sort();
  return {
    query,
    method,
    ideas: out,
    conversations: new Set(evs.map((e) => e!.conversationId)).size,
    tools: [...new Set(evs.map((e) => e!.source as string))].sort(),
    firstAt: times[0] ?? null,
    lastAt: times.at(-1) ?? null,
  };
}
