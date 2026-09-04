import { openRegistry } from "./auth";

/**
 * Self-hosted waitlist signups -- an append-only `waitlist_signups` table in the shared
 * registry.db, one row per person who joins from the website's /waitlist page while the Mac
 * download is deactivated. No third party, no cookies, same shape as metrics.ts's
 * download_events: a public write endpoint, an admin-gated read, plain SQLite underneath.
 */

function openWaitlist() {
  const db = openRegistry();
  db.exec(
    `CREATE TABLE IF NOT EXISTS waitlist_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      note TEXT,
      referrer TEXT,
      country TEXT,
      created_at TEXT NOT NULL
    );`,
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS waitlist_signups_created ON waitlist_signups(created_at);",
  );
  return db;
}

const clip = (s: unknown, n: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, n);
  return t.length ? t : null;
};

export interface WaitlistSubmission {
  email: string;
  name?: unknown;
  note?: unknown;
  referrer?: unknown;
  country?: unknown;
}

/** `email` must already be validated (EMAIL_RE, in handler.ts) before this is called -- this
 *  layer only clips/normalizes, it doesn't reject. Idempotent: re-joining with the same email
 *  (case-insensitively -- stored lowercased) is a no-op, not an error, and never reveals to the
 *  caller which case they're in beyond `alreadyJoined` -- nothing about a waitlist signup is
 *  sensitive enough to need constant-time comparison here, unlike auth. */
export function addToWaitlist(
  sub: WaitlistSubmission,
  now: Date = new Date(),
): { alreadyJoined: boolean } {
  const email = sub.email.trim().toLowerCase();
  const db = openWaitlist();
  try {
    const existing = db
      .query("SELECT id FROM waitlist_signups WHERE email = ?")
      .get(email);
    if (existing) return { alreadyJoined: true };
    db.prepare(
      `INSERT INTO waitlist_signups (email, name, note, referrer, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      email,
      clip(sub.name, 80),
      clip(sub.note, 500),
      clip(sub.referrer, 300),
      clip(sub.country, 2)?.toUpperCase() ?? null,
      now.toISOString(),
    );
    return { alreadyJoined: false };
  } finally {
    db.close();
  }
}

export interface WaitlistEntry {
  email: string;
  name: string | null;
  note: string | null;
  referrer: string | null;
  country: string | null;
  createdAt: string;
}

export interface WaitlistSummary {
  total: number;
  today: number;
  last7: number;
  /** Newest first, uncapped -- this list IS the deliverable (who to actually email/onboard),
   *  unlike download_events' capped "recent" table which exists only for an admin glance. */
  entries: WaitlistEntry[];
}

export function waitlistSummary(now: Date = new Date()): WaitlistSummary {
  const db = openWaitlist();
  try {
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
    const ago7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const count = (sql: string, ...args: unknown[]) =>
      (db.query(sql).get(...(args as never[])) as { n: number }).n;

    const total = count("SELECT COUNT(*) AS n FROM waitlist_signups");
    const today = count(
      "SELECT COUNT(*) AS n FROM waitlist_signups WHERE created_at >= ?",
      startOfToday,
    );
    const last7 = count(
      "SELECT COUNT(*) AS n FROM waitlist_signups WHERE created_at >= ?",
      ago7,
    );

    const entries = db
      .query(
        `SELECT email, name, note, referrer, country, created_at AS createdAt
         FROM waitlist_signups ORDER BY id DESC`,
      )
      .all() as WaitlistEntry[];

    return { total, today, last7, entries };
  } finally {
    db.close();
  }
}
