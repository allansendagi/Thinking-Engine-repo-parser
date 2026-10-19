import { openRegistry } from "./auth";

/**
 * Self-hosted product metrics, in the shared registry.db. No third party, no cookies.
 *  - `download_events`: one row per hit on the website's `/download/mac` endpoint. The website
 *    server forwards what it sees (referrer, Vercel's IP-country header, User-Agent) since the
 *    Railway backend is behind a proxy and can't read the real client. That is a CLICK, not a
 *    finished download: bots (crawlers, link previews) are flagged and left out of the totals.
 *  - `account_created`: one row per anonymous account created at first launch -- the nearest
 *    thing to "installs that were opened" (a re-created account after sign-out counts again).
 *  - `active_days`: one row per account per day it talked to the server, with the app version it
 *    used -- daily/weekly/monthly active installs and how many are still on old versions. Keyed by
 *    account id (already held in the registry), removed with the account.
 */

export function openMetrics() {
  const db = openRegistry();
  db.exec(
    `CREATE TABLE IF NOT EXISTS download_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      version TEXT,
      referrer TEXT,
      country TEXT,
      ua_family TEXT,
      created_at TEXT NOT NULL
    );`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS download_events_created ON download_events(created_at);");
  const cols = db.query("PRAGMA table_info(download_events)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "bot")) db.exec("ALTER TABLE download_events ADD COLUMN bot INTEGER NOT NULL DEFAULT 0;");
  // Where the click came from (first touch on the website): a readable bucket plus the campaign.
  for (const col of ["source", "utm_source", "utm_medium", "utm_campaign"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE download_events ADD COLUMN ${col} TEXT;`);
  }
  // Classify rows recorded before the flag existed (idempotent; only touches unflagged rows).
  db.exec(`UPDATE download_events SET bot = 1 WHERE bot = 0 AND ${BOT_SQL}`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS account_created (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_created_at ON account_created(created_at);
    CREATE TABLE IF NOT EXISTS active_days (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      version TEXT,
      PRIMARY KEY (user_id, day)
    );
    CREATE INDEX IF NOT EXISTS active_days_day ON active_days(day);`,
  );
  return db;
}

/** Substrings that mark a client as automated: crawlers, link-preview fetchers, scripts, headless. */
const BOT_WORDS = [
  "bot", "crawl", "spider", "slurp", "preview", "facebookexternalhit", "embedly", "curl/", "wget",
  "python-requests", "python-urllib", "go-http-client", "node-fetch", "axios", "headless",
  "lighthouse", "pingdom", "uptime", "monitor", "scrapy", "httpclient", "okhttp",
];
export function isBotUserAgent(ua: unknown): boolean {
  if (typeof ua !== "string" || !ua.trim()) return false; // unknown is not proof of a bot
  const s = ua.toLowerCase();
  return BOT_WORDS.some((w) => s.includes(w));
}
const BOT_SQL = `(${BOT_WORDS.map((w) => `lower(COALESCE(ua_family, '')) LIKE '%${w.replace(/'/g, "''")}%'`).join(" OR ")})`;

/**
 * The app's version, for the metrics above. `x-thread-app` (sent by current builds as
 * "ThreadMac/0.4.2") wins; older builds fall back to the default User-Agent URLSession writes
 * ("ThreadMac/<version> CFNetwork/..."). null when neither says -- an unknown, not a guess.
 */
export function appVersionFrom(header: unknown, userAgent: unknown): string | null {
  if (typeof header === "string") {
    const m = header.trim().match(/^(?:(?:ThreadMac|Thread)\/)?(\d+\.\d+(?:\.\d+){0,2})$/);
    if (m) return m[1]!;
  }
  if (typeof userAgent === "string") {
    const m = userAgent.match(/^(?:ThreadMac|Thread)\/(\d+\.\d+(?:\.\d+){0,2})/);
    if (m) return m[1]!;
  }
  return null;
}

const PLATFORMS = new Set(["mac", "windows", "linux"]);
const clip = (s: unknown, n: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\x00-\x1f]/g, "").trim().slice(0, n);
  return t.length ? t : null;
};

export interface DownloadHit {
  platform?: unknown;
  version?: unknown;
  referrer?: unknown;
  country?: unknown;
  uaFamily?: unknown;
  /** Readable bucket ("Google", "ChatGPT", "Direct", a utm_source). */
  source?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
}

export function recordDownload(hit: DownloadHit, now: Date = new Date()): void {
  const platform = clip(hit.platform, 16)?.toLowerCase() ?? "mac";
  const db = openMetrics();
  try {
    db.prepare(
      `INSERT INTO download_events (platform, version, referrer, country, ua_family, created_at, bot, source, utm_source, utm_medium, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PLATFORMS.has(platform) ? platform : "other",
      clip(hit.version, 24),
      clip(hit.referrer, 300),
      clip(hit.country, 2)?.toUpperCase() ?? null,
      clip(hit.uaFamily, 40),
      now.toISOString(),
      isBotUserAgent(hit.uaFamily) ? 1 : 0,
      clip(hit.source, 60),
      clip(hit.utmSource, 60),
      clip(hit.utmMedium, 60),
      clip(hit.utmCampaign, 100),
    );
  } finally {
    db.close();
  }
}

/** One anonymous account created at first launch (see the header: not strictly "installs"). */
export function recordAccountCreated(version: string | null, now: Date = new Date()): void {
  const db = openMetrics();
  try {
    db.prepare("INSERT INTO account_created (version, created_at) VALUES (?, ?)").run(clip(version, 24), now.toISOString());
  } finally {
    db.close();
  }
}

// Per-process memo so a client that syncs every minute causes one write per account per day (or
// per version change), not 1,440.
const noted = new Map<string, string>();

/** Mark this account active today with the version it used. Best-effort; never throws. */
export function noteActive(userId: string, version: string | null, now: Date = new Date()): void {
  try {
    const day = now.toISOString().slice(0, 10);
    const memo = `${day}|${version ?? ""}`;
    if (noted.get(userId) === memo) return;
    const db = openMetrics();
    try {
      db.prepare(
        `INSERT INTO active_days (user_id, day, version) VALUES (?, ?, ?)
         ON CONFLICT(user_id, day) DO UPDATE SET version = COALESCE(excluded.version, active_days.version)`,
      ).run(userId, day, clip(version, 24));
    } finally {
      db.close();
    }
    noted.set(userId, memo);
  } catch {
    /* metrics must never be able to fail a request */
  }
}

/** Remove an account's activity rows (called when the account is deleted). */
export function forgetActivity(userId: string): void {
  noted.delete(userId);
  const db = openMetrics();
  try {
    db.prepare("DELETE FROM active_days WHERE user_id = ?").run(userId);
  } finally {
    db.close();
  }
}

export interface DownloadSummary {
  /** Automated hits (crawlers, link previews, scripts) in the window -- excluded from every number below. */
  bots: number;
  total: number;
  today: number;
  last7: number;
  last30: number;
  windowDays: number;
  byDay: { day: string; count: number }[];
  byVersion: { version: string; count: number }[];
  byCountry: { country: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  /** Most recent hits, newest first (up to 40) -- for the admin "recent downloads" table. */
  recent: { at: string; platform: string; version: string | null; country: string | null; uaFamily: string | null; referrer: string | null }[];
}

export function downloadSummary(windowDays = 30, now: Date = new Date()): DownloadSummary {
  const db = openMetrics();
  try {
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const count = (sql: string, ...args: unknown[]) =>
      (db.query(sql).get(...(args as never[])) as { n: number }).n;

    const total = count("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0");
    const today = count("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ?", startOfToday);
    const last7 = count("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ?", ago(7));
    const last30 = count("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ?", ago(30));

    const byDay = (
      db
        .query(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
           FROM download_events WHERE bot = 0 AND created_at >= ? GROUP BY day ORDER BY day ASC`,
        )
        .all(since) as { day: string; count: number }[]
    );
    const topGroup = (col: string) =>
      db
        .query(
          `SELECT COALESCE(${col}, 'unknown') AS k, COUNT(*) AS count
           FROM download_events WHERE bot = 0 AND created_at >= ? GROUP BY k ORDER BY count DESC LIMIT 12`,
        )
        .all(since) as { k: string; count: number }[];

    const recent = (
      db
        .query(
          `SELECT created_at AS at, platform, version, country, ua_family AS uaFamily, referrer
           FROM download_events WHERE bot = 0 ORDER BY id DESC LIMIT 40`,
        )
        .all() as DownloadSummary["recent"]
    );

    const bots = count("SELECT COUNT(*) AS n FROM download_events WHERE bot = 1 AND created_at >= ?", since);
    return {
      bots,
      total,
      today,
      last7,
      last30,
      windowDays,
      byDay,
      byVersion: topGroup("version").map((r) => ({ version: r.k, count: r.count })),
      byCountry: topGroup("country").map((r) => ({ country: r.k, count: r.count })),
      byPlatform: topGroup("platform").map((r) => ({ platform: r.k, count: r.count })),
      recent,
    };
  } finally {
    db.close();
  }
}

export interface UsageSummary {
  accountsCreated: { total: number; today: number; last7: number; last30: number; byDay: { day: string; count: number }[]; byVersion: { version: string; count: number }[] };
  active: { today: number; last7: number; last30: number; byVersion: { version: string; users: number }[] };
}

/** Accounts created and active installs by version (UTC days). */
export function usageSummary(now: Date = new Date()): UsageSummary {
  const db = openMetrics();
  try {
    const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const n = (sql: string, ...a: unknown[]) => (db.query(sql).get(...(a as never[])) as { n: number }).n;
    const created = (since: string) => n("SELECT COUNT(*) AS n FROM account_created WHERE created_at >= ?", since);
    const active = (from: string) => n("SELECT COUNT(DISTINCT user_id) AS n FROM active_days WHERE day >= ?", from);
    return {
      accountsCreated: {
        total: n("SELECT COUNT(*) AS n FROM account_created"),
        today: created(day(0)),
        last7: created(ago(7)),
        last30: created(ago(30)),
        byDay: db
          .query("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM account_created WHERE created_at >= ? GROUP BY day ORDER BY day ASC")
          .all(ago(30)) as { day: string; count: number }[],
        byVersion: (db
          .query("SELECT COALESCE(version, 'unknown') AS version, COUNT(*) AS count FROM account_created GROUP BY version ORDER BY count DESC LIMIT 12")
          .all() as { version: string; count: number }[]),
      },
      active: {
        today: active(day(0)),
        last7: active(day(6)),
        last30: active(day(29)),
        // Each active account counted once, at the version it used most recently this week.
        byVersion: db
          .query(
            `SELECT COALESCE(version, 'unknown') AS version, COUNT(*) AS users FROM (
               SELECT user_id, version, MAX(day) FROM active_days WHERE day >= ? GROUP BY user_id
             ) GROUP BY version ORDER BY users DESC LIMIT 12`,
          )
          .all(day(6)) as { version: string; users: number }[],
      },
    };
  } finally {
    db.close();
  }
}

// Admin identity moved to ./admin (also used by the capture gate). Re-exported so existing
// importers of "./metrics" keep working.
export { adminEmails, isAdmin } from "./admin";
