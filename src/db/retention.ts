import type { Database } from "bun:sqlite";

/**
 * How long Thread keeps the raw text of conversations once it has turned them into ideas.
 *
 *   null  keep it for as long as the account exists (the default)
 *   0     remove it as soon as the ideas have been extracted ("keep ideas only")
 *   N     remove it N days after the message was written
 *
 * What is removed is the text of the message, in the messages table and in the raw capture
 * record. What stays: the message's id, role and time (so a re-sent transcript is recognised and
 * nothing is re-processed), and the ideas, the thoughts behind them, and the short quotes that
 * ground each one -- those are the memory.
 *
 * Messages still waiting for the AI are never touched: they are the only copy until their ideas
 * exist.
 */

const KEY = "retention_days";
export const MAX_RETENTION_DAYS = 3650;

export function getRetentionDays(db: Database): number | null {
  const row = db.query("SELECT value FROM account_settings WHERE key = ?").get(KEY) as { value: string } | null;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `null` = keep. Throws on anything that isn't null or a whole number of days in range. */
export function setRetentionDays(db: Database, days: number | null): void {
  if (days === null) {
    db.prepare("DELETE FROM account_settings WHERE key = ?").run(KEY);
    return;
  }
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw new RangeError(`days must be null or a whole number from 0 to ${MAX_RETENTION_DAYS}`);
  }
  db.prepare("INSERT INTO account_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, String(days));
}

export interface RetentionApplied {
  /** Messages whose text was removed by this pass. */
  messages: number;
  /** Raw capture records whose copy of the text was removed. */
  evidenceRecords: number;
}

/**
 * Remove the text this account's retention setting says to. Safe to call any time and as often as
 * wanted: it only ever touches committed messages that are no longer waiting for extraction.
 */
export function applyRetention(db: Database, now: Date = new Date()): RetentionApplied {
  const days = getRetentionDays(db);
  if (days === null) return { messages: 0, evidenceRecords: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const stamp = now.toISOString();
  db.exec("PRAGMA secure_delete = ON;");

  // 0 days: everything already extracted. N days: only what was written before the cutoff.
  const ageClause = days === 0 ? "" : "AND created_at < ?";
  const ageArgs = days === 0 ? [] : [cutoff];

  let messages = 0;
  let evidenceRecords = 0;
  db.transaction(() => {
    messages = db
      .prepare(
        `UPDATE canonical_events SET text = '', text_removed_at = ?
         WHERE text_removed_at IS NULL AND text <> '' AND status = 'committed'
           AND id NOT IN (SELECT event_id FROM pending_extraction)
           ${ageClause}`,
      )
      .run(stamp, ...ageArgs).changes;

    // The raw capture records hold a second copy of the text. Judge each message in them by its
    // own date (a record is stamped when Thread SAW it, which for imported history is long after
    // the message was written), in any conversation with nothing left waiting.
    const rows = db
      .query(
        `SELECT id, payload FROM evidence
         WHERE conversation_id NOT IN (SELECT conversation_id FROM pending_extraction)`,
      )
      .all() as { id: string; payload: string }[];
    const update = db.prepare("UPDATE evidence SET payload = ? WHERE id = ?");
    for (const r of rows) {
      let p: { messages?: { createdAt?: string }[]; purged?: boolean };
      try {
        p = JSON.parse(r.payload);
      } catch {
        continue;
      }
      if (!Array.isArray(p.messages) || p.messages.length === 0) continue;
      const keep = days === 0 ? [] : p.messages.filter((m) => !m.createdAt || m.createdAt >= cutoff);
      if (keep.length === p.messages.length) continue;
      update.run(JSON.stringify({ ...p, messages: keep, ...(keep.length === 0 ? { purged: true } : {}) }), r.id);
      evidenceRecords++;
    }
  })();

  if (messages > 0 || evidenceRecords > 0) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // not in WAL mode
    }
  }
  return { messages, evidenceRecords };
}

export interface RetentionSummary {
  days: number | null;
  /** Messages whose text Thread still holds / has removed under this setting. */
  messagesKept: number;
  messagesRemoved: number;
}

export function retentionSummary(db: Database): RetentionSummary {
  const row = db
    .query("SELECT SUM(text_removed_at IS NULL) AS kept, SUM(text_removed_at IS NOT NULL) AS removed FROM canonical_events")
    .get() as { kept: number | null; removed: number | null };
  return { days: getRetentionDays(db), messagesKept: row.kept ?? 0, messagesRemoved: row.removed ?? 0 };
}

// ---------------------------------------------------------------------------------- the sweep

const lastSwept = new Map<string, number>();
const SWEEP_EVERY_MS = 3_600_000;

/**
 * Apply an account's retention setting in the background -- at most once an hour per account,
 * off the request path, called on every authenticated request (the Mac app syncs each minute).
 * Failures are logged, never thrown.
 */
export function scheduleRetentionSweep(
  userId: string,
  open: (userId: string) => Database,
  now: number = Date.now(),
): void {
  if (now - (lastSwept.get(userId) ?? 0) < SWEEP_EVERY_MS) return;
  lastSwept.set(userId, now);
  queueMicrotask(() => {
    let db: Database | null = null;
    try {
      db = open(userId);
      if (getRetentionDays(db) === null) return;
      const r = applyRetention(db, new Date(now));
      if (r.messages > 0) console.log(`[Thread] retention removed ${r.messages} messages' text for ${userId}`);
    } catch (e) {
      console.error(`[Thread] retention sweep failed for ${userId}:`, e);
    } finally {
      db?.close();
    }
  });
}
