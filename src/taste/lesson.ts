import type { Database } from "bun:sqlite";
import { loadEventSources, loadIdeas } from "../db/queries";
import { loadThoughtVectors, vectorModels } from "../db/thoughts";
import { chooseMeaningModel, cosine } from "../mining/consolidate";
import { loadTasteLabels } from "../mining/corrections";
import { headlineThoughtIds } from "../mining/serve";
import type { IdeaNode } from "../types";
import { tasteReport } from "./taste";

/**
 * Teach Thread: a few questions, at most once a day, chosen so each answer teaches the most.
 *
 *  - "Keep this?" on the ideas Thread is least sure about -- taste scores nearest 0.5. Until there
 *    are enough answers to score at all, the newest unjudged ideas (they're what the person is
 *    thinking about now, so the answer is easy).
 *  - "Same idea?" on two related ideas sitting right on the line between "the same idea" and "the
 *    same subject" -- measured on the owner's labels: the same idea averages ~0.71 cosine, the
 *    same subject ~0.59, so pairs near 0.65 are the ones only the person can call.
 *
 * Every answer goes into the learning that already exists -- a Keep or Not an idea into taste (and
 * a Not an idea into extraction and regrouping), a Same / Different into the grouping constraints
 * -- marked as a lesson so it never skews the acceptance rate. Nothing is asked twice; a skipped
 * idea rests for a week. Free: no model call, only stored meaning-vectors.
 */

export const IDEA_QUESTIONS = 5;
export const PAIR_QUESTIONS = 2;
const SKIP_REST_DAYS = 7;
/** The same-idea / same-subject boundary in raw cosine (owner's labels: 0.71 vs 0.59). */
const PAIR_BOUNDARY = 0.65;
const PAIR_BAND: [number, number] = [0.55, 0.85];

export interface LessonIdea {
  ideaId: string;
  title: string;
  statement: string;
  source: string | null;
  lastTouched: string;
}

export type LessonQuestion =
  | ({ kind: "idea"; reason: "unsure" | "new" } & LessonIdea)
  | { kind: "pair"; a: LessonIdea; b: LessonIdea };

export interface Lesson {
  questions: LessonQuestion[];
  /** Everything Thread has learned from: Keep / Not an idea (any origin) + Same / Different answers. */
  learned: number;
  /** Share of the last verdicts on ideas Thread showed (browsing, not lessons) that were Keep. */
  acceptanceRate: number | null;
  /** How many verdicts that rate is over. */
  acceptanceSample: number;
  /** Taste has enough answers of both kinds to sort ideas. */
  ready: boolean;
}

function lessonIdea(idea: IdeaNode, sources: Map<string, string>): LessonIdea {
  const last = idea.evolution.at(-1);
  return {
    ideaId: idea.id,
    title: idea.title,
    statement: idea.currentFormulation,
    source: last ? sources.get(last.sourceEventId) ?? null : null,
    lastTouched: last?.createdAt ?? idea.updatedAt,
  };
}

/** A pair's identity that survives regrouping: the two ideas' founding thoughts, sorted. */
export function pairKey(db: Database, a: string, b: string): string | null {
  const fa = headlineThoughtIds(db, a)[0];
  const fb = headlineThoughtIds(db, b)[0];
  return fa && fb ? [fa, fb].sort().join("|") : null;
}

export function buildLesson(db: Database, now: Date = new Date()): Lesson {
  const report = tasteReport(db);
  const labels = loadTasteLabels(db);
  const ideas = loadIdeas(db);
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const sources = loadEventSources(db);
  const restSince = new Date(now.getTime() - SKIP_REST_DAYS * 86_400_000).toISOString();
  const resting = new Set(
    (db.query("SELECT idea_id FROM learn_skips WHERE skipped_at >= ?").all(restSince) as { idea_id: string }[]).map((r) => r.idea_id),
  );

  // 1. Ideas: not yet judged, not resting; least certain first (or newest, before taste is ready).
  const open = report.ideas.filter((t) => t.tier !== "confirmed" && !resting.has(t.ideaId) && byId.has(t.ideaId));
  const lastTouched = (id: string) => byId.get(id)!.evolution.at(-1)?.createdAt ?? byId.get(id)!.updatedAt;
  const ranked = report.ready
    ? open
        .filter((t) => t.score !== null)
        .sort((x, y) => Math.abs(x.score! - 0.5) - Math.abs(y.score! - 0.5) || lastTouched(y.ideaId).localeCompare(lastTouched(x.ideaId)))
    : open.sort((x, y) => lastTouched(y.ideaId).localeCompare(lastTouched(x.ideaId)));
  const ideaQuestions: LessonQuestion[] = ranked.slice(0, IDEA_QUESTIONS).map((t) => ({
    kind: "idea",
    reason: report.ready ? "unsure" : "new",
    ...lessonIdea(byId.get(t.ideaId)!, sources),
  }));

  // 2. Pairs: related ideas (same theme) whose founding thoughts sit near the same-idea boundary.
  const pairQuestions: LessonQuestion[] = [];
  const model = chooseMeaningModel(vectorModels(db));
  if (model) {
    const vectors = loadThoughtVectors(db, model);
    const answered = new Set((db.query("SELECT pair_key FROM learn_pairs").all() as { pair_key: string }[]).map((r) => r.pair_key));
    const asked = new Set(ideaQuestions.map((q) => (q.kind === "idea" ? q.ideaId : "")));
    const founder = new Map<string, string | undefined>();
    const founderOf = (id: string) => {
      if (!founder.has(id)) founder.set(id, headlineThoughtIds(db, id)[0]);
      return founder.get(id);
    };
    const candidates: { a: string; b: string; key: string; distance: number }[] = [];
    const seen = new Set<string>();
    for (const idea of ideas) {
      for (const other of idea.relatedIdeaIds) {
        if (!byId.has(other) || asked.has(idea.id) || asked.has(other)) continue;
        const fa = founderOf(idea.id), fb = founderOf(other);
        if (!fa || !fb) continue;
        const key = [fa, fb].sort().join("|");
        if (seen.has(key) || answered.has(key)) continue;
        seen.add(key);
        const va = vectors.get(fa), vb = vectors.get(fb);
        if (!va || !vb) continue;
        const c = cosine(va, vb);
        if (c < PAIR_BAND[0] || c > PAIR_BAND[1]) continue;
        candidates.push({ a: idea.id, b: other, key, distance: Math.abs(c - PAIR_BOUNDARY) });
      }
    }
    candidates.sort((x, y) => x.distance - y.distance || x.key.localeCompare(y.key));
    const used = new Set<string>();
    for (const c of candidates) {
      if (pairQuestions.length >= PAIR_QUESTIONS) break;
      if (used.has(c.a) || used.has(c.b)) continue; // one question per idea per lesson
      used.add(c.a);
      used.add(c.b);
      pairQuestions.push({ kind: "pair", a: lessonIdea(byId.get(c.a)!, sources), b: lessonIdea(byId.get(c.b)!, sources) });
    }
  }

  const pairAnswers = (db.query("SELECT COUNT(*) AS n FROM learn_pairs WHERE answer <> 'skip'").get() as { n: number }).n;
  const merges = (db.query("SELECT COUNT(*) AS n FROM idea_corrections WHERE kind IN ('merge', 'split') AND origin IS NULL").get() as { n: number }).n;
  return {
    questions: [...ideaQuestions, ...pairQuestions],
    learned: report.keeps + report.notIdeas + pairAnswers + merges,
    acceptanceRate: report.acceptanceRate,
    acceptanceSample: report.acceptanceSample,
    ready: report.ready,
  };
}
