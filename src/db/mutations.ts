import type { Database } from "bun:sqlite";
import type { IdeaState } from "../types";

/**
 * Human corrections to derived state (THREAD.md §23, §30): the user can reject, delete, rename,
 * or mark loops resolved. These only ever touch idea_nodes and its dependent tables
 * (evolution_steps, open_loops, decisions, related_ideas) -- never canonical_events or
 * cognitive_events. That's deliberate: §30's invariant is that derived interpretation must be
 * correctable without destroying source evidence. Deleting an idea removes Thread's
 * *interpretation* that these events form a persistent idea; it does not un-happen the
 * conversation that produced it, and the raw events remain available for a future re-processing
 * pass to reconsider.
 *
 * NOT implemented here: merging two ideas, or editing an idea's current formulation directly.
 * Both are real THREAD.md §23 actions still pending -- see README. Editing the formulation in
 * particular isn't a simple field update: every existing evolution step is provenance-linked to
 * a real source event, and a manual edit has no such source, so it needs either a schema change
 * (nullable provenance for manual corrections) or a synthetic event to stay consistent with that
 * invariant. Deferring rather than doing it halfway.
 */

export function deleteIdea(db: Database, ideaId: string): boolean {
  const exists = db.query("SELECT 1 FROM idea_nodes WHERE id = ?").get(ideaId);
  if (!exists) return false;

  db.prepare("DELETE FROM evolution_steps WHERE idea_id = ?").run(ideaId);
  db.prepare("DELETE FROM open_loops WHERE idea_id = ?").run(ideaId);
  db.prepare("DELETE FROM decisions WHERE idea_id = ?").run(ideaId);
  db.prepare("DELETE FROM related_ideas WHERE idea_id = ? OR related_idea_id = ?").run(ideaId, ideaId);
  db.prepare("DELETE FROM identity_resolutions WHERE matched_idea_id = ?").run(ideaId);
  db.prepare("DELETE FROM idea_nodes WHERE id = ?").run(ideaId);
  return true;
}

const VALID_STATES: IdeaState[] = ["developing", "established", "rejected", "dormant", "contested"];

export function setIdeaState(db: Database, ideaId: string, state: IdeaState): boolean {
  if (!VALID_STATES.includes(state)) throw new Error(`Invalid idea state: ${state}`);
  const result = db
    .prepare("UPDATE idea_nodes SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, new Date().toISOString(), ideaId);
  return result.changes > 0;
}

export function renameIdea(db: Database, ideaId: string, title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error("Title cannot be empty");
  const result = db
    .prepare("UPDATE idea_nodes SET title = ?, updated_at = ? WHERE id = ?")
    .run(trimmed, new Date().toISOString(), ideaId);
  return result.changes > 0;
}

export function setOpenLoopResolved(db: Database, loopId: string, resolved: boolean): boolean {
  const result = db
    .prepare("UPDATE open_loops SET resolved = ? WHERE id = ?")
    .run(resolved ? 1 : 0, loopId);
  return result.changes > 0;
}
