import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Embedded at build time, not read from disk at start-up, so the engine also runs as a single
// compiled binary (`bun build --compile`), where no source tree exists next to it.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

const ADD_COLUMNS: [table: string, column: string][] = [
  ["cognitive_events", "persistence TEXT NOT NULL DEFAULT 'high'"],
  ["cognitive_events", "persistence_reason TEXT"],
  ["canonical_events", "source_url TEXT"],
  ["canonical_events", "capture_method TEXT"],
  ["canonical_events", "capture_fidelity TEXT"],
  ["canonical_events", "status TEXT NOT NULL DEFAULT 'committed'"],
  ["evidence", "identity TEXT"],
  ["evidence", "source TEXT"],
  ["cognitive_events", "role TEXT"],
  ["cognitive_events", "adopted_source_event_id TEXT"],
  ["cognitive_events", "adopted_quote TEXT"],
  ["discarded_events", "role TEXT"],
  ["discarded_events", "adopted_source_event_id TEXT"],
  ["discarded_events", "adopted_quote TEXT"],
];

/**
 * A fingerprint of schema.sql + the column migrations, stored in each file's `PRAGMA
 * user_version`. The API opens a user's DB on every request; re-running the whole schema plus
 * every ALTER each time was pure overhead. Now it runs only when the file is new or the schema
 * changed -- and because the version is derived from the schema text itself, editing schema.sql
 * or ADD_COLUMNS re-applies automatically with no number to remember to bump.
 */
const SCHEMA_VERSION = (() => {
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (const ch of SCHEMA_SQL + JSON.stringify(ADD_COLUMNS)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h | 0) || 1; // user_version is a signed 32-bit int; 0 means "never initialized"
})();

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  // Deleted content is overwritten, not just unlinked: without this a deleted conversation's
  // text stays readable in the file's free pages. Per-connection, so it's set on every open --
  // an idea deleted through any code path, not only the privacy routes, leaves nothing behind.
  db.exec("PRAGMA secure_delete = ON;");
  // WAL mode: readers don't block writers and vice versa. Default (rollback journal) mode
  // serializes all access to a file and is fine for a single local user, but this backend now
  // opens/closes a connection per HTTP request against the same per-user file -- under real
  // concurrent traffic (e.g. the extension capturing while the Mac app reads), the default mode
  // would surface as intermittent "database is locked" errors. Not applicable to ":memory:" (used
  // only in tests), which has no journal file to configure.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version !== SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
  return db;
}

/**
 * In-place column additions for per-user DBs that predate a schema change. schema.sql only uses
 * CREATE TABLE IF NOT EXISTS, so a new column on an existing table needs an explicit ALTER.
 * Idempotent: a duplicate-column error just means the migration already ran. New TABLES are
 * handled by schema.sql itself.
 */
function migrate(db: Database): void {
  for (const [table, column] of ADD_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column};`);
    } catch {
      // column already exists
    }
  }
}

/** Wipes all rows without dropping tables -- used between eval runs so results don't accumulate. */
export function resetDb(db: Database): void {
  const tables = [
    "identity_resolutions",
    "related_ideas",
    "decisions",
    "open_loops",
    "evolution_steps",
    "cognitive_event_sources",
    "idea_nodes",
    "discarded_events",
    "cognitive_events",
    "canonical_events",
    "evidence",
  ];
  for (const table of tables) {
    db.exec(`DELETE FROM ${table};`);
  }
}
