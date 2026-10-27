import type { Database } from "bun:sqlite";
import { deriveTitle, isNamingTitle, isPersonTitle } from "../state/buildIdeaNode";
import type { CognitiveEventType } from "../types";
import { ANCHOR_TYPES, type ConsolidatedIdea } from "./consolidate";

/**
 * Serving v2: for accounts switched over, the ideas the person sees ARE the v2 consolidation --
 * written into the same tables v1 serves from (idea_nodes, evolution_steps, open_loops,
 * decisions, related_ideas), so every reader, every correction endpoint, the MCP server and the
 * Mac keep working unchanged. v1 keeps running underneath (extraction + gate); v2 regroups what
 * it produced after every capture.
 *
 * Switched on per account by THREAD_V2_SERVING_USERS (comma-separated user ids, or `*`). The
 * first switch-over saves the v1 graph to backup tables; switching back restores it exactly --
 * v1 can't be rebuilt without paying the model again, so it is never thrown away.
 */

export function servesV2(userId: string): boolean {
  const raw = process.env.THREAD_V2_SERVING_USERS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim()).includes(userId);
}

const SERVING_TABLES = ["idea_nodes", "evolution_steps", "open_loops", "decisions", "related_ideas"] as const;
const backupOf = (t: string) => `v1_backup_${t}`;

export function hasV1Backup(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(backupOf("idea_nodes"));
}

function backupV1(db: Database): void {
  if (hasV1Backup(db)) return;
  for (const t of SERVING_TABLES) db.exec(`CREATE TABLE ${backupOf(t)} AS SELECT * FROM ${t}`);
  db.exec(`CREATE TABLE ${backupOf("identity_resolutions")} AS SELECT cognitive_event_id, matched_idea_id FROM identity_resolutions`);
}

/** Drop the saved v1 graph -- e.g. when a conversation is deleted, so no copy of it survives. */
export function dropV1Backup(db: Database): void {
  for (const t of [...SERVING_TABLES, "identity_resolutions"]) db.exec(`DROP TABLE IF EXISTS ${backupOf(t)}`);
}

function clearServing(db: Database): void {
  // identity_resolutions.matched_idea_id references idea_nodes; keep the audit rows, unlink them.
  db.exec("UPDATE identity_resolutions SET matched_idea_id = NULL");
  for (const t of ["related_ideas", "decisions", "open_loops", "evolution_steps", "idea_nodes"]) db.exec(`DELETE FROM ${t}`);
}

/** Switch an account back: the v1 graph exactly as it was when v2 started serving. */
export function restoreV1(db: Database): boolean {
  if (!hasV1Backup(db)) return false;
  db.transaction(() => {
    clearServing(db);
    for (const t of ["idea_nodes", "evolution_steps", "open_loops", "decisions", "related_ideas"]) {
      // Only rows whose thoughts still exist: a conversation deleted meanwhile stays deleted.
      const where =
        t === "evolution_steps" ? " WHERE cognitive_event_id IN (SELECT id FROM cognitive_events)" :
        t === "decisions" ? " WHERE source_event_id IN (SELECT id FROM canonical_events)" : "";
      // By column name, not position: a backup made before a column was added has fewer columns,
      // and a positional copy would fail and strand the account on v2.
      const have = new Set((db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
      const cols = (db.query(`PRAGMA table_info(${backupOf(t)})`).all() as { name: string }[]).map((c) => c.name).filter((c) => have.has(c));
      db.exec(`INSERT OR IGNORE INTO ${t} (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM ${backupOf(t)}${where}`);
    }
    db.exec(
      `UPDATE identity_resolutions SET matched_idea_id = (SELECT b.matched_idea_id FROM ${backupOf("identity_resolutions")} b
         WHERE b.cognitive_event_id = identity_resolutions.cognitive_event_id AND b.matched_idea_id IN (SELECT id FROM idea_nodes))`,
    );
    dropV1Backup(db);
  })();
  return true;
}

/**
 * Replace the served graph with the v2 ideas. What the person
 * already knows an idea by survives the rewrite: its id (kept by consolidate), its title, why it
 * matters, and every question they marked answered.
 */
export function materializeV2(db: Database, ideas: ConsolidatedIdea[]): { served: number; sparks: number } {
  // Sparks are served too: a new thought must be findable the moment it's captured, and taste
  // (the Maybe tray) -- not hiding -- is what keeps weak ones out of the way.
  const served = ideas;
  const servedIds = new Set(served.map((i) => i.node.id));
  db.transaction(() => {
    backupV1(db);
    const before = new Map(
      (db.query("SELECT id, title, why_it_matters FROM idea_nodes").all() as { id: string; title: string; why_it_matters: string | null }[]).map(
        (r) => [r.id, r],
      ),
    );
    const v1IdeaOf = new Map(
      (db.query("SELECT idea_id, cognitive_event_id FROM evolution_steps").all() as { idea_id: string; cognitive_event_id: string }[]).map(
        (r) => [r.cognitive_event_id, r.idea_id],
      ),
    );
    const renamed = new Set((db.query("SELECT DISTINCT idea_id FROM idea_corrections WHERE kind = 'rename'").all() as { idea_id: string }[]).map((r) => r.idea_id));
    const statementOf = new Map(
      (db.query("SELECT id, statement FROM cognitive_events UNION ALL SELECT id, statement FROM discarded_events").all() as { id: string; statement: string }[]).map(
        (r) => [r.id, r.statement],
      ),
    );
    /**
     * The title must name what the person is judging when they press Keep or Not an idea: the
     * idea's founding thought (see headlineThoughtIds). So: their own rename of this idea, else
     * the title the founding thought's old idea had (when it reads as a name and no other idea
     * took it), else one carved from the founding statement.
     */
    // The extractor's own short name for a new idea ("Computable authority"), and each thought's
    // type -- a name beats a sentence cut at eight words.
    const named = db.query(
      "SELECT id, type, title FROM cognitive_events UNION ALL SELECT id, type, title FROM discarded_events WHERE id NOT IN (SELECT id FROM cognitive_events)",
    ).all() as { id: string; type: string; title: string | null }[];
    const modelTitleOf = new Map(named.filter((r) => r.title).map((r) => [r.id, r.title!]));
    const typeOf = new Map(named.map((r) => [r.id, r.type]));
    // A name the tidy pass gave this idea's founding thought (mining/tidy.ts).
    const storedName = new Map(
      (db.query("SELECT founder_thought_id, name FROM idea_names").all() as { founder_thought_id: string; name: string }[]).map((r) => [r.founder_thought_id, r.name]),
    );
    const usedTitles = new Set<string>();
    const free = (t: string) => !usedTitles.has(t.toLowerCase());
    /**
     * In order: the person's own rename; the extractor's name for the founding thought, then for
     * any other new idea in the group; the old v1 title when it reads as a name; a title carved
     * from the founding statement -- or, when that one only narrates the person ("They are
     * naming..."), from the next thing the idea states.
     */
    const titleFor = (node: ConsolidatedIdea["node"], founderId: string, thoughtIds: string[]): string => {
      const pick = (t: string) => (usedTitles.add(t.toLowerCase()), t);
      if (renamed.has(node.id) && before.has(node.id)) return pick(before.get(node.id)!.title);
      const modelNamed = [founderId, ...thoughtIds.filter((t) => t !== founderId && typeOf.get(t) === "new_idea")];
      for (const id of modelNamed) {
        const raw = modelTitleOf.get(id);
        if (!raw) continue;
        const t = deriveTitle(statementOf.get(id) ?? "", raw);
        if (isNamingTitle(t) && free(t)) return pick(t);
      }
      const stored = storedName.get(founderId);
      if (stored && free(stored)) return pick(stored);
      const v1 = v1IdeaOf.get(founderId);
      const old = v1 ? before.get(v1)?.title : undefined;
      if (old && isNamingTitle(old) && free(old)) return pick(old);
      const stated = [founderId, ...thoughtIds.filter((t) => t !== founderId && ANCHOR_TYPES.has(typeOf.get(t) as CognitiveEventType))];
      for (const id of stated) {
        const t = deriveTitle(statementOf.get(id) ?? "");
        if (t && !isPersonTitle(t) && free(t)) return pick(t);
      }
      return pick(deriveTitle(statementOf.get(founderId) ?? node.currentFormulation));
    };
    // Who decided each question's state. A person's word wins, whichever way: ticked stays ticked,
    // unticked stays open. So does a closure from before Thread recorded who made it (it may have
    // been theirs -- never undo it). Thread's own closures follow the evidence, so they heal.
    const loopBefore = new Map(
      (db.query("SELECT id, resolved, set_by FROM open_loops").all() as { id: string; resolved: number; set_by: string | null }[]).map((r) => [r.id, r]),
    );
    const personsWord = (id: string): { resolved: boolean } | null => {
      const b = loopBefore.get(id);
      if (!b) return null;
      return b.set_by === "user" || (b.set_by === null && b.resolved === 1) ? { resolved: b.resolved === 1 } : null;
    };
    const why = new Map(
      (db.query("SELECT id, why_it_matters FROM cognitive_events WHERE why_it_matters IS NOT NULL").all() as { id: string; why_it_matters: string }[]).map(
        (r) => [r.id, r.why_it_matters],
      ),
    );
    clearServing(db);

    // v2 re-decides what the signal gate set aside: a set-aside thought it groups into an idea is
    // promoted, exactly as the replay pass promotes one (the row is copied, never invented).
    const promote = db.prepare(
      `INSERT OR IGNORE INTO cognitive_events (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, role, adopted_source_event_id, adopted_quote, answers_event_id, title)
       SELECT id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, role, adopted_source_event_id, adopted_quote, answers_event_id, title
         FROM discarded_events WHERE id = ?`,
    );
    for (const { thoughtIds } of served) for (const t of thoughtIds) promote.run(t);

    const putIdea = db.prepare(
      "INSERT INTO idea_nodes (id, title, state, current_formulation, why_it_matters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const putStep = db.prepare(
      "INSERT OR REPLACE INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)",
    );
    const putLoop = db.prepare("INSERT OR REPLACE INTO open_loops (id, idea_id, statement, created_at, resolved, set_by, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const putDecision = db.prepare("INSERT OR REPLACE INTO decisions (id, idea_id, statement, decided_at, source_event_id) VALUES (?, ?, ?, ?, ?)");
    const putRelated = db.prepare("INSERT OR IGNORE INTO related_ideas (idea_id, related_idea_id) VALUES (?, ?)");

    // Renamed ideas claim their titles first, so a derived name can't take a person's own.
    const order = [...served].sort((a, b) => Number(renamed.has(b.node.id)) - Number(renamed.has(a.node.id)));
    order.forEach(({ node, thoughtIds, founderId }) => {
      const prior = before.get(node.id);
      const title = titleFor(node, founderId, thoughtIds);
      const whyItMatters = prior?.why_it_matters ?? thoughtIds.map((t) => why.get(t)).find((w) => w) ?? null;
      putIdea.run(node.id, title, node.state, node.currentFormulation, whyItMatters, node.createdAt, node.updatedAt);
      for (const s of node.evolution) putStep.run(node.id, s.cognitiveEventId, s.formulation, s.createdAt, s.sourceEventId);
      for (const l of node.openLoops) {
        const theirs = personsWord(l.id);
        const closed = theirs ? theirs.resolved : l.resolved;
        putLoop.run(l.id, node.id, l.statement, l.createdAt, closed ? 1 : 0, theirs ? "user" : "thread", !theirs && closed ? l.resolvedBy ?? null : null);
      }
      for (const d of node.decisions) putDecision.run(d.id, node.id, d.statement, d.decidedAt, d.sourceEventId);
    });
    for (const { node } of served) {
      for (const r of node.relatedIdeaIds) {
        if (!servedIds.has(r)) continue;
        putRelated.run(node.id, r);
        putRelated.run(r, node.id); // stored symmetrically, like v1
      }
    }
  })();
  return { served: served.length, sparks: ideas.filter((i) => i.isSpark).length };
}

const POSITIONAL = new Set(["new_idea", "claim", "refinement", "contradiction", "decision"]);

/**
 * The thoughts a person is judging when they press Keep or Not an idea on a v2 idea: the one it
 * was founded on (its title) and the one it currently says (its headline) -- not every thought
 * grouped under it. A v2 idea can hold dozens of thoughts; one click must not permanently label
 * them all. Whatever else was in the group is regrouped on the next pass and shown on its own.
 */
export function headlineThoughtIds(db: Database, ideaId: string): string[] {
  const steps = db
    .query(
      `SELECT s.cognitive_event_id AS id, c.type, c.role FROM evolution_steps s JOIN cognitive_events c ON c.id = s.cognitive_event_id
        WHERE s.idea_id = ? ORDER BY s.created_at, s.cognitive_event_id`,
    )
    .all(ideaId) as { id: string; type: string; role: string | null }[];
  if (steps.length === 0) return [];
  const positional = steps.filter((t) => POSITIONAL.has(t.type) && !(t.type === "claim" && (t.role === "option" || t.role === "reason")));
  const founder = steps.find((t) => t.type === "new_idea") ?? positional[0] ?? steps[0]!;
  const current = positional.at(-1) ?? steps.at(-1)!;
  return [...new Set([founder.id, current.id])];
}
