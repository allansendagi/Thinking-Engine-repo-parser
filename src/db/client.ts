import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL mode: readers don't block writers and vice versa. Default (rollback journal) mode
  // serializes all access to a file and is fine for a single local user, but this backend now
  // opens/closes a connection per HTTP request against the same per-user file -- under real
  // concurrent traffic (e.g. the extension capturing while the Mac app reads), the default mode
  // would surface as intermittent "database is locked" errors. Not applicable to ":memory:" (used
  // only in tests), which has no journal file to configure.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * In-place column additions for per-user DBs that predate a schema change. schema.sql only uses
 * CREATE TABLE IF NOT EXISTS, so a new column on an existing table needs an explicit ALTER.
 * Idempotent: a duplicate-column error just means the migration already ran. New TABLES are
 * handled by schema.sql itself.
 */
function migrate(db: Database): void {
  const addColumns: [table: string, column: string][] = [
    ["cognitive_events", "persistence TEXT NOT NULL DEFAULT 'high'"],
    ["cognitive_events", "persistence_reason TEXT"],
    ["canonical_events", "source_url TEXT"],
  ];
  for (const [table, column] of addColumns) {
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
  ];
  for (const table of tables) {
    db.exec(`DELETE FROM ${table};`);
  }
}
