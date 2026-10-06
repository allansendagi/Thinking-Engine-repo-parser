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
