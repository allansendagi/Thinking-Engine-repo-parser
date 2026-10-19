import type { Database } from "bun:sqlite";
import { deriveTitle, isNamingTitle } from "../state/buildIdeaNode";
import type { ConsolidatedIdea } from "./consolidate";

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
      db.exec(`INSERT OR IGNORE INTO ${t} SELECT * FROM ${backupOf(t)}${where}`);
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
 * Replace the served graph with the v2 ideas. Sparks (a lone thought nobody came back to) are
 * not served -- they stay in idea_view_v2 and become ideas once they recur. What the person
 * already knows an idea by survives the rewrite: its id (kept by consolidate), its title, why it
 * matters, and every question they marked answered.
 */
export function materializeV2(db: Database, ideas: ConsolidatedIdea[]): { served: number; sparks: number } {
  const served = ideas.filter((i) => !i.isSpark);
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
    const typeOf = new Map((db.query("SELECT id, type FROM cognitive_events").all() as { id: string; type: string }[]).map((r) => [r.id, r.type]));
    /** v1 ids are `idea_<founding thought>`: was this idea founded on an idea, not a question/ask? */
    const foundedOnIdea = (v1: string) => ["new_idea", "claim", "refinement"].includes(typeOf.get(v1.replace(/^idea_/, "")) ?? "");
    /**
     * Names, assigned once each across the whole graph: a title the person gave first, then the
     * clearest existing titles (founded on an idea, then most of the group's thoughts) -- each to
     * the group holding most of that old idea's thoughts, so no two ideas end up with one name.
     * A group with no name of its own gets one carved from its founding statement.
     */
    const claims: { group: number; v1: string; rank: number[] }[] = [];
    served.forEach(({ node, thoughtIds }, group) => {
      const votes = new Map<string, number>();
      for (const t of thoughtIds) {
        const v1 = v1IdeaOf.get(t);
        if (v1 && before.has(v1)) votes.set(v1, (votes.get(v1) ?? 0) + 1);
      }
      for (const [v1, n] of votes) {
        if (!renamed.has(v1) && !isNamingTitle(before.get(v1)!.title)) continue;
        claims.push({ group, v1, rank: [renamed.has(v1) ? 1 : 0, foundedOnIdea(v1) ? 1 : 0, n, v1 === node.id ? 1 : 0] });
      }
    });
    const cmp = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!; return 0; };
    claims.sort((a, b) => cmp(a.rank, b.rank) || a.v1.localeCompare(b.v1));
    const named = new Map<number, string>();
    const usedTitles = new Set<string>();
    for (const c of claims) {
      const title = before.get(c.v1)!.title;
      if (named.has(c.group) || usedTitles.has(title.toLowerCase())) continue;
      named.set(c.group, title);
      usedTitles.add(title.toLowerCase());
    }
    const titleFor = (group: number): string => {
      const own = named.get(group);
      if (own) return own;
      const { node, founderId } = served[group]!;
      return deriveTitle(statementOf.get(founderId) ?? node.currentFormulation);
    };
    const resolvedLoops = new Set((db.query("SELECT id FROM open_loops WHERE resolved = 1").all() as { id: string }[]).map((r) => r.id));
    const why = new Map(
      (db.query("SELECT id, why_it_matters FROM cognitive_events WHERE why_it_matters IS NOT NULL").all() as { id: string; why_it_matters: string }[]).map(
        (r) => [r.id, r.why_it_matters],
      ),
    );
    clearServing(db);

    // v2 re-decides what the signal gate set aside: a set-aside thought it groups into an idea is
    // promoted, exactly as the replay pass promotes one (the row is copied, never invented).
    const promote = db.prepare(
      `INSERT OR IGNORE INTO cognitive_events (id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, role, adopted_source_event_id, adopted_quote)
       SELECT id, type, statement, confidence, persistence, persistence_reason, source_event_id, evidence_quote, role, adopted_source_event_id, adopted_quote
         FROM discarded_events WHERE id = ?`,
    );
    for (const { thoughtIds } of served) for (const t of thoughtIds) promote.run(t);

    const putIdea = db.prepare(
      "INSERT INTO idea_nodes (id, title, state, current_formulation, why_it_matters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const putStep = db.prepare(
      "INSERT OR REPLACE INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)",
    );
    const putLoop = db.prepare("INSERT OR REPLACE INTO open_loops (id, idea_id, statement, created_at, resolved) VALUES (?, ?, ?, ?, ?)");
    const putDecision = db.prepare("INSERT OR REPLACE INTO decisions (id, idea_id, statement, decided_at, source_event_id) VALUES (?, ?, ?, ?, ?)");
    const putRelated = db.prepare("INSERT OR IGNORE INTO related_ideas (idea_id, related_idea_id) VALUES (?, ?)");

    served.forEach(({ node, thoughtIds }, group) => {
      const prior = before.get(node.id);
      const title = titleFor(group);
      const whyItMatters = prior?.why_it_matters ?? thoughtIds.map((t) => why.get(t)).find((w) => w) ?? null;
      putIdea.run(node.id, title, node.state, node.currentFormulation, whyItMatters, node.createdAt, node.updatedAt);
      for (const s of node.evolution) putStep.run(node.id, s.cognitiveEventId, s.formulation, s.createdAt, s.sourceEventId);
      for (const l of node.openLoops) putLoop.run(l.id, node.id, l.statement, l.createdAt, l.resolved || resolvedLoops.has(l.id) ? 1 : 0);
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
  return { served: served.length, sparks: ideas.length - served.length };
}
