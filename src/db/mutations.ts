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
 * `discarded_events` is deliberately NOT cleaned up by deleteIdea: those rows key off
 * canonical_events, not idea_nodes (the gate declined to build an idea from them at all), and
 * the same "don't destroy source-adjacent evidence" invariant applies -- a threshold change
 * should still be able to replay them. deleteDiscardedEvents exists only for the replay pass
 * that promotes one into a real idea.
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
  db.prepare(
    "DELETE FROM related_ideas WHERE idea_id = ? OR related_idea_id = ?",
  ).run(ideaId, ideaId);
  db.prepare("DELETE FROM identity_resolutions WHERE matched_idea_id = ?").run(
    ideaId,
  );
  db.prepare("DELETE FROM idea_nodes WHERE id = ?").run(ideaId);
  return true;
}

const VALID_STATES: IdeaState[] = [
  "developing",
  "established",
  "rejected",
  "dormant",
  "contested",
];

export function setIdeaState(
  db: Database,
  ideaId: string,
  state: IdeaState,
): boolean {
  if (!VALID_STATES.includes(state))
    throw new Error(`Invalid idea state: ${state}`);
  const result = db
    .prepare("UPDATE idea_nodes SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, new Date().toISOString(), ideaId);
  return result.changes > 0;
}

export function renameIdea(
  db: Database,
  ideaId: string,
  title: string,
): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new Error("Title cannot be empty");
  const result = db
    .prepare("UPDATE idea_nodes SET title = ?, updated_at = ? WHERE id = ?")
    .run(trimmed, new Date().toISOString(), ideaId);
  return result.changes > 0;
}

export function setOpenLoopResolved(
  db: Database,
  loopId: string,
  resolved: boolean,
): boolean {
  const result = db
    .prepare("UPDATE open_loops SET resolved = ? WHERE id = ?")
    .run(resolved ? 1 : 0, loopId);
  return result.changes > 0;
}

/** Removes discarded_events rows the replay pass has since promoted into real ideas. */
export function deleteDiscardedEvents(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM discarded_events WHERE id IN (${placeholders})`).run(
    ...ids,
  );
}

export interface MergeIdeasResult {
  movedEvolutionSteps: number;
  /** Evolution steps left on keepId because the same cognitive event already backed it. */
  sharedEvolutionSteps: number;
  movedOpenLoops: number;
  dedupedOpenLoops: number;
  movedDecisions: number;
}

const COUNT = (db: Database, table: string, col: string, val: string): number =>
  (
    db
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
      .get(val) as { n: number }
  ).n;

/**
 * Merge `dropId` into `keepId`. Every provenance-linked child row -- evolution steps, open loops,
 * decisions, relations, identity-resolution audit rows -- is repointed onto `keepId`; then
 * `keepId`'s derived fields are re-derived from the combined evolution, and `dropId` is deleted.
 *
 * This is THREAD.md §23's still-pending "merge two ideas" (see this module's header). It never
 * touches canonical_events or cognitive_events -- §30's invariant holds: derived interpretation
 * is correctable, source evidence is not.
 *
 * The current_formulation / state recompute is NOT the blocked "manual formulation edit" case the
 * header describes. That case is blocked because a hand-typed formulation has no source event.
 * This re-derives, from real provenance-linked steps only, exactly the invariant
 * applyCognitiveEvent maintains at ingest (latest step is the formulation; state is the running
 * result of the state-changing event types). No synthetic events, no unsourced text.
 *
 * Runs in one transaction and throws (rolling back) if a row count doesn't reconcile -- on
 * production data a silent partial merge is worse than a visible failure.
 */
export function mergeIdeas(
  db: Database,
  keepId: string,
  dropId: string,
): MergeIdeasResult {
  if (keepId === dropId)
    throw new Error("mergeIdeas: keepId and dropId are the same idea");
  if (!db.query("SELECT 1 FROM idea_nodes WHERE id = ?").get(keepId)) {
    throw new Error(`mergeIdeas: keep idea ${keepId} not found`);
  }
  if (!db.query("SELECT 1 FROM idea_nodes WHERE id = ?").get(dropId)) {
    throw new Error(`mergeIdeas: drop idea ${dropId} not found`);
  }

  return db.transaction((): MergeIdeasResult => {
    // evolution_steps -- PK (idea_id, cognitive_event_id). A collision means the SAME cognitive
    // event already backs keepId. That shouldn't happen for a genuine duplicate, but if it does
    // the shared step must stay on keepId, not vanish.
    const evoOnDrop = COUNT(db, "evolution_steps", "idea_id", dropId);
    const shared = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM evolution_steps d
             WHERE d.idea_id = ?1
               AND EXISTS (SELECT 1 FROM evolution_steps k
                            WHERE k.idea_id = ?2 AND k.cognitive_event_id = d.cognitive_event_id)`,
        )
        .get(dropId, keepId) as { n: number }
    ).n;
    db.prepare(
      "UPDATE OR IGNORE evolution_steps SET idea_id = ? WHERE idea_id = ?",
    ).run(keepId, dropId);
    const evoLeftOnDrop = COUNT(db, "evolution_steps", "idea_id", dropId);
    if (evoLeftOnDrop !== shared) {
      throw new Error(
        `mergeIdeas: evolution_steps did not reconcile (${evoLeftOnDrop} left on ${dropId}, expected ${shared} shared)`,
      );
    }
    db.prepare("DELETE FROM evolution_steps WHERE idea_id = ?").run(dropId);
    const movedEvolutionSteps = evoOnDrop - shared;

    // open_loops / decisions -- globally-unique ids, no structural collision, plain repoint.
    const movedOpenLoops = Number(
      db
        .prepare("UPDATE open_loops SET idea_id = ? WHERE idea_id = ?")
        .run(keepId, dropId).changes,
    );
    const dedupedOpenLoops = dedupeOpenLoops(db, keepId);
    const movedDecisions = Number(
      db
        .prepare("UPDATE decisions SET idea_id = ? WHERE idea_id = ?")
        .run(keepId, dropId).changes,
    );

    // related_ideas -- symmetric rows. Repoint both columns, then drop the self-link that a
    // pre-existing keep<->drop relation becomes, plus any duplicate pair.
    db.prepare(
      "UPDATE OR IGNORE related_ideas SET idea_id = ? WHERE idea_id = ?",
    ).run(keepId, dropId);
    db.prepare(
      "UPDATE OR IGNORE related_ideas SET related_idea_id = ? WHERE related_idea_id = ?",
    ).run(keepId, dropId);
    db.prepare(
      "DELETE FROM related_ideas WHERE idea_id = ? OR related_idea_id = ?",
    ).run(dropId, dropId);
    db.prepare(
      "DELETE FROM related_ideas WHERE idea_id = related_idea_id",
    ).run();

    // identity_resolutions -- audit rows keyed by cognitive_event_id; matched_idea_id is not
    // unique, so a plain repoint is safe and keeps the trail pointing at a live idea.
    db.prepare(
      "UPDATE identity_resolutions SET matched_idea_id = ? WHERE matched_idea_id = ?",
    ).run(keepId, dropId);

    rederiveIdea(db, keepId);
    db.prepare("DELETE FROM idea_nodes WHERE id = ?").run(dropId);

    return {
      movedEvolutionSteps,
      sharedEvolutionSteps: shared,
      movedOpenLoops,
      dedupedOpenLoops,
      movedDecisions,
    };
  })();
}

/**
 * Drop open loops on `ideaId` whose statement is a case-insensitive duplicate of an earlier one
 * (a merged twin usually carries the same unresolved question). Keeps the earliest; if a later
 * duplicate was resolved, the kept one inherits that.
 */
function dedupeOpenLoops(db: Database, ideaId: string): number {
  const rows = db
    .query(
      "SELECT id, statement, resolved FROM open_loops WHERE idea_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(ideaId) as { id: string; statement: string; resolved: number }[];
  const kept = new Map<string, { id: string; resolved: number }>();
  let removed = 0;
  for (const r of rows) {
    const key = r.statement.trim().toLowerCase();
    const prior = kept.get(key);
    if (!prior) {
      kept.set(key, { id: r.id, resolved: r.resolved });
      continue;
    }
    if (r.resolved && !prior.resolved) {
      db.prepare("UPDATE open_loops SET resolved = 1 WHERE id = ?").run(
        prior.id,
      );
      prior.resolved = 1;
    }
    db.prepare("DELETE FROM open_loops WHERE id = ?").run(r.id);
    removed++;
  }
  return removed;
}

/**
 * Re-derive an idea's current_formulation / state / created_at / updated_at from its evolution
 * steps, replaying the state transitions applyCognitiveEvent applies at ingest. Replays over
 * every step including the first: for a real duplicate cluster the earliest step is always a
 * `new_idea` (non-state-changing), so this matches ingest; if it somehow isn't, the more-decided
 * outcome is the safer answer anyway.
 */
function rederiveIdea(db: Database, ideaId: string): void {
  const steps = db
    .query(
      `SELECT es.formulation AS formulation, es.created_at AS created_at, ce.type AS type
         FROM evolution_steps es
         JOIN cognitive_events ce ON ce.id = es.cognitive_event_id
        WHERE es.idea_id = ?
        ORDER BY es.created_at ASC, es.cognitive_event_id ASC`,
    )
    .all(ideaId) as { formulation: string; created_at: string; type: string }[];
  if (steps.length === 0) return;

  let state = "developing";
  for (const s of steps) {
    if (s.type === "decision") state = "established";
    else if (s.type === "rejection") state = "rejected";
    else if (s.type === "contradiction") state = "contested";
    else if (s.type === "resolution" && state === "contested")
      state = "developing";
  }

  const first = steps[0] as { created_at: string };
  const last = steps[steps.length - 1] as {
    formulation: string;
    created_at: string;
  };
  db.prepare(
    "UPDATE idea_nodes SET current_formulation = ?, state = ?, created_at = ?, updated_at = ? WHERE id = ?",
  ).run(last.formulation, state, first.created_at, last.created_at, ideaId);
}
