import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
  return db;
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
    "cognitive_events",
    "canonical_events",
  ];
  for (const table of tables) {
    db.exec(`DELETE FROM ${table};`);
  }
}
