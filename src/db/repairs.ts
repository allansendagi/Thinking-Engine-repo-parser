import type { Database } from "bun:sqlite";

/**
 * One-time data repairs, each run once per database and recorded in `data_repairs`. They run from
 * openDb when the schema fingerprint changes -- and the repair names are part of that fingerprint,
 * so adding a repair is enough: every account is repaired on its next request, never twice.
 */
const REPAIRS: { name: string; run: (db: Database) => Record<string, number> }[] = [
  { name: "2026-11-provenance", run: repairProvenance },
  { name: "2026-11-message-times", run: repairMessageTimes },
];

/** Part of the schema fingerprint (db/client.ts): adding a repair re-runs openDb's migration
 *  step on every database once, which is what runs the new repair. */
export const REPAIR_NAMES = (): string[] => REPAIRS.map((r) => r.name);

export function runDataRepairs(db: Database): void {
  const done = new Set((db.query("SELECT name FROM data_repairs").all() as { name: string }[]).map((r) => r.name));
  for (const r of REPAIRS) {
    if (done.has(r.name)) continue;
    db.transaction(() => {
      const detail = r.run(db);
      db.prepare("INSERT INTO data_repairs (name, ran_at, detail) VALUES (?, ?, ?)").run(r.name, new Date().toISOString(), JSON.stringify(detail));
      if (Object.values(detail).some((n) => n > 0)) console.log(`[Thread] data repair ${r.name}: ${JSON.stringify(detail)}`);
    })();
  }
}

/**
 * Thoughts whose source message no longer contains their quote (see keepMessagesFixed in
 * api/ingest.ts for how that happened): point each at a message the person wrote in the same
 * conversation that does contain the quote -- the earliest, if several do. A thought whose words
 * survive nowhere keeps its own quote and is left as it is; nothing is deleted.
 */
export function repairProvenance(db: Database): { repointed: number; unrecoverable: number } {
  type Row = { id: string; source_event_id: string; evidence_quote: string; conversation_id: string; text: string };
  const broken = (table: string) =>
    (db.query(
      `SELECT t.id, t.source_event_id, t.evidence_quote, c.conversation_id, c.text
       FROM ${table} t JOIN canonical_events c ON c.id = t.source_event_id
       WHERE c.text_removed_at IS NULL AND instr(lower(c.text), lower(t.evidence_quote)) = 0`,
    ).all() as Row[]);
  const candidates = db.prepare(
    `SELECT id FROM canonical_events
     WHERE conversation_id = ? AND role = 'user' AND text_removed_at IS NULL AND instr(lower(text), lower(?)) > 0
     ORDER BY idx, created_at LIMIT 1`,
  );
  let repointed = 0, unrecoverable = 0;
  for (const table of ["cognitive_events", "discarded_events"] as const) {
    const move = db.prepare(`UPDATE ${table} SET source_event_id = ? WHERE id = ?`);
    for (const t of broken(table)) {
      const home = candidates.get(t.conversation_id, t.evidence_quote) as { id: string } | null;
      if (!home) {
        unrecoverable++;
        continue;
      }
      move.run(home.id, t.id);
      if (table === "cognitive_events") {
        db.prepare("UPDATE evolution_steps SET source_event_id = ? WHERE cognitive_event_id = ? AND source_event_id = ?").run(home.id, t.id, t.source_event_id);
        db.prepare("UPDATE decisions SET source_event_id = ? WHERE id = ? AND source_event_id = ?").run(home.id, `dec_${t.id}`, t.source_event_id);
      }
      repointed++;
    }
  }
  return { repointed, unrecoverable };
}

/**
 * Messages re-dated by later captures (see keepMessagesFixed in api/ingest.ts): a browser capture
 * stamped every message with the moment of capture and the store took the newest, so opening an
 * old conversation moved all of it to "now". The evidence log keeps each observation's new turns
 * with the time they were stamped when first seen -- the earliest of those is when the message
 * was first captured. Restore it wherever the stored time is later. Never moves a time forward.
 */
export function repairMessageTimes(db: Database): { restored: number } {
  const firstSeen = new Map<string, string>();
  const toIso = (t: unknown): string | null => {
    const ms = typeof t === "string" ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  for (const row of db.query("SELECT observed_at, payload FROM evidence").all() as { observed_at: string; payload: string }[]) {
    let messages: { id?: unknown; createdAt?: unknown }[] = [];
    try {
      messages = (JSON.parse(row.payload) as { messages?: typeof messages }).messages ?? [];
    } catch {
      continue;
    }
    for (const m of messages) {
      if (typeof m.id !== "string") continue;
      const at = toIso(m.createdAt) ?? toIso(row.observed_at);
      if (!at) continue;
      const prev = firstSeen.get(m.id);
      if (!prev || at < prev) firstSeen.set(m.id, at);
    }
  }
  const stored = db.query("SELECT id, created_at FROM canonical_events").all() as { id: string; created_at: string }[];
  const set = db.prepare("UPDATE canonical_events SET created_at = ? WHERE id = ?");
  let restored = 0;
  for (const r of stored) {
    const first = firstSeen.get(r.id);
    const now = toIso(r.created_at);
    if (first && now && first < now) {
      set.run(first, r.id);
      restored++;
    }
  }
  return { restored };
}
