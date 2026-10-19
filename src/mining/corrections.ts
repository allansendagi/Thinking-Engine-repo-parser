import type { Database } from "bun:sqlite";
import type { IdeaState } from "../types";
import type { Constraints } from "./consolidate";

/**
 * Personal learning: every correction a person makes is recorded against the THOUGHTS it was
 * about, not just an idea id, because v2 recomputes ideas from thoughts on every pass. That
 * makes a correction permanent: a deleted idea can't be rebuilt from the same thoughts, a merge
 * keeps holding after new thoughts arrive, a split stays split.
 */

export type CorrectionKind = "not_idea" | "merge" | "split" | "rename" | "state";

export function ideaThoughtIds(db: Database, ideaId: string): string[] {
  return (db.query("SELECT cognitive_event_id FROM evolution_steps WHERE idea_id = ? ORDER BY created_at").all(ideaId) as {
    cognitive_event_id: string;
  }[]).map((r) => r.cognitive_event_id);
}

export function recordCorrection(
  db: Database,
  c: { kind: CorrectionKind; ideaId: string; thoughtIds: string[]; otherThoughtIds?: string[]; value?: string },
): void {
  db.prepare(
    "INSERT INTO idea_corrections (kind, idea_id, thought_ids, other_thought_ids, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    c.kind,
    c.ideaId,
    JSON.stringify(c.thoughtIds),
    c.otherThoughtIds ? JSON.stringify(c.otherThoughtIds) : null,
    c.value ?? null,
    new Date().toISOString(),
  );
}

/** A person's explicit "keep": this idea is worth having. Idempotent per idea. */
export function recordKeep(db: Database, ideaId: string, thoughtIds: string[]): void {
  if (db.query("SELECT 1 FROM idea_verdicts WHERE idea_id = ? AND verdict = 'keep'").get(ideaId)) return;
  db.prepare("INSERT INTO idea_verdicts (verdict, idea_id, thought_ids, created_at) VALUES ('keep', ?, ?, ?)").run(
    ideaId,
    JSON.stringify(thoughtIds),
    new Date().toISOString(),
  );
}

const REVIEW = "review";

/**
 * Verdicts on single thoughts ("is this worth keeping?"), e.g. from a review of what was
 * captured. Recorded like in-app clicks -- a keep as a verdict, a no as a not_idea correction --
 * so they teach taste and v2 (a "no" thought is never mined into an idea), but marked as a
 * review. Idempotent per thought: the latest verdict on a thought replaces an earlier review one.
 * Returns how many were recorded; unknown thought ids are skipped.
 */
export function recordThoughtReviews(db: Database, reviews: { thoughtId: string; verdict: "keep" | "not_idea" }[]): number {
  let n = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const { thoughtId, verdict } of reviews) {
      const t = db.query("SELECT statement FROM cognitive_events WHERE id = ?").get(thoughtId) as { statement: string } | null;
      if (!t) continue;
      const ids = JSON.stringify([thoughtId]);
      db.prepare("DELETE FROM idea_verdicts WHERE origin = ? AND thought_ids = ?").run(REVIEW, ids);
      db.prepare("DELETE FROM idea_corrections WHERE origin = ? AND kind = 'not_idea' AND thought_ids = ?").run(REVIEW, ids);
      const ideaId = (db.query("SELECT idea_id FROM evolution_steps WHERE cognitive_event_id = ?").get(thoughtId) as { idea_id: string } | null)?.idea_id ?? "";
      if (verdict === "keep") {
        db.prepare("INSERT INTO idea_verdicts (verdict, idea_id, thought_ids, created_at, origin) VALUES ('keep', ?, ?, ?, ?)").run(ideaId, ids, now, REVIEW);
      } else {
        db.prepare("INSERT INTO idea_corrections (kind, idea_id, thought_ids, value, created_at, origin) VALUES ('not_idea', ?, ?, ?, ?, ?)").run(
          ideaId, ids, t.statement, now, REVIEW,
        );
      }
      n++;
    }
  })();
  return n;
}

export interface TasteLabels {
  /** Thoughts from ideas the person kept. */
  positives: Set<string>;
  /** Thoughts from ideas the person deleted as not ideas. */
  negatives: Set<string>;
  /** Idea ids the person explicitly kept. */
  keptIdeaIds: Set<string>;
  /** Thoughts of ideas the person kept in the app -- an idea holding one is still the kept idea
   *  after a regrouping changed its id. (Reviewed thoughts only teach; they don't confirm.) */
  keptThoughtIds: Set<string>;
  /** Verdicts on SERVED ideas in the order given, newest last -- for the acceptance rate. */
  history: { verdict: "keep" | "not_idea"; at: string }[];
  /** Verdicts given one thought at a time (a review, not ideas Thread showed): they teach taste
   *  but aren't a judgment of what Thread served, so they stay out of the acceptance rate. */
  reviewed: { keeps: number; notIdeas: number };
}

/** Everything the person has said about what is, and isn't, an idea. */
export function loadTasteLabels(db: Database): TasteLabels {
  const out: TasteLabels = { positives: new Set(), negatives: new Set(), keptIdeaIds: new Set(), keptThoughtIds: new Set(), history: [], reviewed: { keeps: 0, notIdeas: 0 } };
  const parse = (j: string): string[] => {
    try {
      return JSON.parse(j) as string[];
    } catch {
      return [];
    }
  };
  for (const r of db.query("SELECT idea_id, thought_ids, created_at, origin FROM idea_verdicts WHERE verdict = 'keep' ORDER BY id").all() as {
    idea_id: string; thought_ids: string; created_at: string; origin: string | null;
  }[]) {
    for (const t of parse(r.thought_ids)) out.positives.add(t);
    if (r.origin === REVIEW) {
      out.reviewed.keeps++;
      continue;
    }
    out.keptIdeaIds.add(r.idea_id);
    for (const t of parse(r.thought_ids)) out.keptThoughtIds.add(t);
    out.history.push({ verdict: "keep", at: r.created_at });
  }
  for (const r of db.query("SELECT thought_ids, created_at, origin FROM idea_corrections WHERE kind = 'not_idea' ORDER BY id").all() as {
    thought_ids: string; created_at: string; origin: string | null;
  }[]) {
    for (const t of parse(r.thought_ids)) out.negatives.add(t);
    if (r.origin === REVIEW) out.reviewed.notIdeas++;
    else out.history.push({ verdict: "not_idea", at: r.created_at });
  }
  out.history.sort((a, b) => a.at.localeCompare(b.at));
  // A thought judged both ways (kept once, then deleted) takes the later word: the deletion.
  for (const t of out.negatives) {
    out.positives.delete(t);
    out.keptThoughtIds.delete(t);
  }
  return out;
}

export interface LearnedCorrections {
  constraints: Constraints;
  /** Thoughts from ideas the person deleted -- never mined into an idea again. */
  dismissedThoughtIds: Set<string>;
  /** Latest title / state the person gave, by idea id. */
  titles: Map<string, string>;
  states: Map<string, IdeaState>;
}

export function loadCorrections(db: Database): LearnedCorrections {
  const rows = db.query("SELECT kind, idea_id, thought_ids, other_thought_ids, value FROM idea_corrections ORDER BY id").all() as {
    kind: CorrectionKind; idea_id: string; thought_ids: string; other_thought_ids: string | null; value: string | null;
  }[];
  const out: LearnedCorrections = { constraints: { mustLink: [], cannotLink: [] }, dismissedThoughtIds: new Set(), titles: new Map(), states: new Map() };
  for (const r of rows) {
    const ids = JSON.parse(r.thought_ids) as string[];
    const other = r.other_thought_ids ? (JSON.parse(r.other_thought_ids) as string[]) : [];
    if (r.kind === "not_idea") for (const id of ids) out.dismissedThoughtIds.add(id);
    // A chain through one representative per side is enough: must-links are transitive.
    if (r.kind === "merge" && ids[0] && other[0]) out.constraints.mustLink!.push([ids[0], other[0]]);
    if (r.kind === "split") {
      const kept = ids.filter((id) => !other.includes(id));
      for (const a of kept) for (const b of other) out.constraints.cannotLink!.push([a, b]);
    }
    if (r.kind === "rename" && r.value) out.titles.set(r.idea_id, r.value);
    if (r.kind === "state" && r.value) out.states.set(r.idea_id, r.value as IdeaState);
  }
  // A later merge of the same pair overrides an earlier split, and vice versa.
  const key = ([a, b]: [string, string]) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const must = new Set(out.constraints.mustLink!.map(key));
  out.constraints.cannotLink = out.constraints.cannotLink!.filter((p) => !must.has(key(p)));
  return out;
}

/**
 * The person's own "this isn't an idea" examples, most recent first -- shown to the extractor
 * so it learns what this person doesn't want kept. Short and capped: steering, not a rulebook.
 */
export function dismissedExamples(db: Database, limit = 6): string[] {
  return (db.query("SELECT value FROM idea_corrections WHERE kind = 'not_idea' AND value IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit) as {
    value: string;
  }[]).map((r) => r.value.slice(0, 200));
}
