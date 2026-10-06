import type { Database } from "bun:sqlite";
import { existsSync, statSync, unlinkSync } from "node:fs";

/**
 * Everything the person can see, export and delete about what Thread holds -- written against
 * the schema, one place, so "what does Thread store?" and "is it really gone?" have one answer
 * and one test.
 *
 * Deleting uses SQLite's secure_delete (freed pages are overwritten, not just unlinked) and a
 * WAL truncate afterwards, so deleted text isn't left behind inside the database file.
 */

// ------------------------------------------------------------------------------------ summary

export interface DataSummary {
  conversations: number;
  messages: number;
  /** Per-source conversation counts, e.g. { chatgpt: 214, claude: 31 }. */
  sources: Record<string, number>;
  ideas: number;
  thoughts: number;
  /** Thoughts the quality gate set aside -- kept so the same ones are never re-extracted. */
  setAsideThoughts: number;
  openQuestions: number;
  decisions: number;
  /** Meaning-vectors: one per thought per model. */
  vectors: number;
  vectorModels: string[];
  corrections: number;
  /** Captured messages still waiting to be turned into ideas. */
  waitingForAi: number;
  /** Raw captures kept as evidence (sensor payloads). */
  evidenceRecords: number;
  firstCaptureAt: string | null;
  lastCaptureAt: string | null;
  /** Size of this account's database on disk, bytes. */
  bytes: number;
}

const n = (db: Database, sql: string): number => (db.query(sql).get() as { n: number }).n;

export function dataSummary(db: Database): DataSummary {
  const sources: Record<string, number> = {};
  for (const r of db
    .query("SELECT source, COUNT(DISTINCT conversation_id) AS c FROM canonical_events GROUP BY source")
    .all() as { source: string; c: number }[]) {
    sources[r.source] = r.c;
  }
  const span = db.query("SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM canonical_events").get() as {
    a: string | null;
    b: string | null;
  };
  const models = (db.query("SELECT DISTINCT model FROM thought_vectors ORDER BY model").all() as { model: string }[]).map(
    (r) => r.model,
  );
  let bytes = 0;
  try {
    const file = db.filename;
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (f && existsSync(f)) bytes += statSync(f).size;
  } catch {
    // in-memory or unreadable: report 0 rather than fail the whole screen
  }
  return {
    conversations: n(db, "SELECT COUNT(DISTINCT conversation_id) AS n FROM canonical_events"),
    messages: n(db, "SELECT COUNT(*) AS n FROM canonical_events"),
    sources,
    ideas: n(db, "SELECT COUNT(*) AS n FROM idea_nodes"),
    thoughts: n(db, "SELECT COUNT(*) AS n FROM cognitive_events"),
    setAsideThoughts: n(db, "SELECT COUNT(*) AS n FROM discarded_events"),
    openQuestions: n(db, "SELECT COUNT(*) AS n FROM open_loops"),
    decisions: n(db, "SELECT COUNT(*) AS n FROM decisions"),
    vectors: n(db, "SELECT COUNT(*) AS n FROM thought_vectors"),
    vectorModels: models,
    corrections: n(db, "SELECT COUNT(*) AS n FROM idea_corrections"),
    waitingForAi: n(db, "SELECT COUNT(*) AS n FROM pending_extraction"),
    evidenceRecords: n(db, "SELECT COUNT(*) AS n FROM evidence"),
    firstCaptureAt: span.a,
    lastCaptureAt: span.b,
    bytes,
  };
}

// ------------------------------------------------------------------------------------ export

/** Tables copied verbatim into an export. Vectors are numbers a person can't read, so they're
 *  counted (see `dataSummary`) rather than dumped; the v2 view is a recomputable cache. */
const EXPORT_TABLES = [
  "canonical_events",
  "evidence",
  "cognitive_events",
  "discarded_events",
  "cognitive_event_sources",
  "idea_nodes",
  "evolution_steps",
  "open_loops",
  "decisions",
  "related_ideas",
  "identity_resolutions",
  "idea_corrections",
  "pending_extraction",
] as const;

export function exportAll(db: Database): Record<string, unknown> {
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const t of EXPORT_TABLES) out[t] = db.query(`SELECT * FROM ${t}`).all();
  out.summary = dataSummary(db);
  return out;
}

// ------------------------------------------------------------------------- delete a conversation

export interface ConversationDeletion {
  messages: number;
  thoughts: number;
  setAsideThoughts: number;
  vectors: number;
  steps: number;
  decisions: number;
  corrections: number;
  evidenceRecords: number;
  waitingForAi: number;
  /** Ideas that had nothing left once this conversation went, and were removed. */
  ideasRemoved: number;
  /** Ideas that keep other conversations' thinking, and were re-derived from what remains. */
  ideasRewritten: number;
  /** Open questions dropped from rewritten ideas -- they can't be traced to a conversation, so
   *  they can't be proven free of the deleted one. */
  openQuestionsRemoved: number;
}

const marks = (xs: unknown[]) => xs.map(() => "?").join(",");
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/**
 * Remove a conversation and everything Thread derived from it: the messages, the thoughts and
 * their vectors, the evolution steps and decisions they fed, corrections made about them, raw
 * evidence, and the waiting-for-AI rows. An idea left with nothing is removed; an idea that also
 * rests on other conversations is kept, rewritten from what remains.
 */
export function deleteConversation(db: Database, conversationId: string): ConversationDeletion | null {
  const events = ids(db.query("SELECT id FROM canonical_events WHERE conversation_id = ?").all(conversationId) as { id: string }[]);
  const evidenceRows = (db.query("SELECT COUNT(*) AS n FROM evidence WHERE conversation_id = ?").get(conversationId) as { n: number }).n;
  if (events.length === 0 && evidenceRows === 0) return null;

  db.exec("PRAGMA secure_delete = ON;");
  const out: ConversationDeletion = {
    messages: events.length,
    thoughts: 0,
    setAsideThoughts: 0,
    vectors: 0,
    steps: 0,
    decisions: 0,
    corrections: 0,
    evidenceRecords: evidenceRows,
    waitingForAi: 0,
    ideasRemoved: 0,
    ideasRewritten: 0,
    openQuestionsRemoved: 0,
  };

  db.transaction(() => {
    const evMarks = marks(events);
    const thoughts = events.length
      ? ids(db.query(`SELECT id FROM cognitive_events WHERE source_event_id IN (${evMarks})`).all(...events) as { id: string }[])
      : [];
    const setAside = events.length
      ? ids(db.query(`SELECT id FROM discarded_events WHERE source_event_id IN (${evMarks})`).all(...events) as { id: string }[])
      : [];
    const thoughtSet = new Set([...thoughts, ...setAside]);

    // Ideas touched, found before their links are cut.
    const affected = new Set<string>();
    if (events.length) {
      for (const r of db.query(`SELECT DISTINCT idea_id FROM evolution_steps WHERE source_event_id IN (${evMarks})`).all(...events) as { idea_id: string }[]) affected.add(r.idea_id);
      for (const r of db.query(`SELECT DISTINCT idea_id FROM decisions WHERE source_event_id IN (${evMarks})`).all(...events) as { idea_id: string }[]) affected.add(r.idea_id);
    }
    if (thoughts.length) {
      for (const r of db.query(`SELECT DISTINCT idea_id FROM evolution_steps WHERE cognitive_event_id IN (${marks(thoughts)})`).all(...thoughts) as { idea_id: string }[]) affected.add(r.idea_id);
    }

    // Corrections that mention these thoughts (their JSON id lists), incl. the "not an idea"
    // statement kept for learning.
    for (const c of db.query("SELECT id, thought_ids, other_thought_ids FROM idea_corrections").all() as {
      id: number;
      thought_ids: string;
      other_thought_ids: string | null;
    }[]) {
      const mentioned = [c.thought_ids, c.other_thought_ids ?? "[]"].some((j) => {
        try {
          return (JSON.parse(j) as string[]).some((t) => thoughtSet.has(t));
        } catch {
          return false;
        }
      });
      if (mentioned) {
        db.prepare("DELETE FROM idea_corrections WHERE id = ?").run(c.id);
        out.corrections++;
      }
    }

    if (thoughts.length) {
      const m = marks(thoughts);
      db.prepare(`DELETE FROM identity_resolutions WHERE cognitive_event_id IN (${m})`).run(...thoughts);
      out.steps += db.prepare(`DELETE FROM evolution_steps WHERE cognitive_event_id IN (${m})`).run(...thoughts).changes;
      db.prepare(`DELETE FROM cognitive_event_sources WHERE cognitive_event_id IN (${m})`).run(...thoughts);
    }
    if (events.length) {
      out.steps += db.prepare(`DELETE FROM evolution_steps WHERE source_event_id IN (${evMarks})`).run(...events).changes;
      out.decisions = db.prepare(`DELETE FROM decisions WHERE source_event_id IN (${evMarks})`).run(...events).changes;
      db.prepare(`DELETE FROM cognitive_event_sources WHERE canonical_event_id IN (${evMarks})`).run(...events);
      out.thoughts = db.prepare(`DELETE FROM cognitive_events WHERE source_event_id IN (${evMarks})`).run(...events).changes;
      out.setAsideThoughts = db.prepare(`DELETE FROM discarded_events WHERE source_event_id IN (${evMarks})`).run(...events).changes;
    }
    if (thoughtSet.size) {
      const all = [...thoughtSet];
      out.vectors = db.prepare(`DELETE FROM thought_vectors WHERE thought_id IN (${marks(all)})`).run(...all).changes;
    }
    out.evidenceRecords = db.prepare("DELETE FROM evidence WHERE conversation_id = ?").run(conversationId).changes;
    out.waitingForAi = db.prepare("DELETE FROM pending_extraction WHERE conversation_id = ?").run(conversationId).changes;
    db.prepare("DELETE FROM canonical_events WHERE conversation_id = ?").run(conversationId);

    // The v2 view is a cache recomputed from thoughts; clear it so no deleted thought lingers there.
    db.exec("DELETE FROM idea_view_v2;");

    for (const ideaId of affected) {
      const remaining = (db.query("SELECT COUNT(*) AS n FROM evolution_steps WHERE idea_id = ?").get(ideaId) as { n: number }).n;
      if (remaining === 0) {
        db.prepare("DELETE FROM open_loops WHERE idea_id = ?").run(ideaId);
        db.prepare("DELETE FROM decisions WHERE idea_id = ?").run(ideaId);
        db.prepare("DELETE FROM related_ideas WHERE idea_id = ? OR related_idea_id = ?").run(ideaId, ideaId);
        db.prepare("DELETE FROM identity_resolutions WHERE matched_idea_id = ?").run(ideaId);
        db.prepare("DELETE FROM idea_nodes WHERE id = ?").run(ideaId);
        out.ideasRemoved++;
      } else {
        const latest = db
          .query("SELECT formulation FROM evolution_steps WHERE idea_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(ideaId) as { formulation: string } | null;
        db.prepare("UPDATE idea_nodes SET current_formulation = COALESCE(?, current_formulation), why_it_matters = NULL, updated_at = ? WHERE id = ?").run(
          latest?.formulation ?? null,
          new Date().toISOString(),
          ideaId,
        );
        out.openQuestionsRemoved += db.prepare("DELETE FROM open_loops WHERE idea_id = ?").run(ideaId).changes;
        out.ideasRewritten++;
      }
    }
  })();

  checkpoint(db);
  return out;
}

/** Fold the write-ahead log back in and truncate it, so removed text isn't sitting in -wal. */
function checkpoint(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // not in WAL mode (tests, in-memory): nothing to fold
  }
}

// ---------------------------------------------------------------------------- delete everything

/** What deleting an account removes, counted before it goes -- shown to the person, and the
 *  receipt returned afterwards. */
export interface AccountDeletion {
  conversations: number;
  messages: number;
  ideas: number;
  thoughts: number;
  vectors: number;
  corrections: number;
  evidenceRecords: number;
  /** Files removed from the server's disk. */
  filesRemoved: number;
}

/** Remove the account's database files from disk. The caller removes the registry rows. */
export function purgeUserFiles(dbFile: string): number {
  let removed = 0;
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`]) {
    if (existsSync(f)) {
      unlinkSync(f);
      removed++;
    }
  }
  return removed;
}
