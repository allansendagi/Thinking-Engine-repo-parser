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
  // `visitor`: an anonymous, daily-rotating fingerprint (see growth.ts visitorKey) -- counts
  // people, not clicks. Never an IP address.
  for (const col of ["source", "utm_source", "utm_medium", "utm_campaign", "visitor", "reason"]) {
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE download_events ADD COLUMN ${col} TEXT;`);
  }
  // Classify rows recorded before the flag existed (idempotent; only touches unflagged rows).
  db.exec(`UPDATE download_events SET bot = 1, reason = COALESCE(reason, 'bot') WHERE bot = 0 AND ${BOT_SQL}`);
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
    CREATE INDEX IF NOT EXISTS active_days_day ON active_days(day);
    CREATE TABLE IF NOT EXISTS installs (
      install_id TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      app_version TEXT,
      os_version TEXT
    );
    CREATE INDEX IF NOT EXISTS installs_first ON installs(first_seen);
    CREATE INDEX IF NOT EXISTS installs_last ON installs(last_seen);`,
  );
  // Which install an account was created on, so signing out and back in on the same Mac isn't a
  // second install. Null for accounts from builds that predate the install id.
  for (const [table, col] of [["account_created", "install_id"], ["users", "install_id"]] as const) {
    const have = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (have.length && !have.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT;`);
  }
  return db;
}

/**
 * The Mac app's install id (`x-thread-install`): a random UUID made on first launch and kept in
 * the app's preferences, so it survives sign-out (and reinstalling). Not derived from the
 * hardware or anything personal. null when absent or malformed.
 */
export function installIdFrom(header: unknown): string | null {
  return typeof header === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.trim())
    ? header.trim().toLowerCase()
    : null;
}

/** macOS version from `x-thread-os` ("26.0.1"), or null. */
export function osVersionFrom(header: unknown): string | null {
  return typeof header === "string" && /^\d{1,3}(\.\d{1,3}){0,2}$/.test(header.trim()) ? header.trim() : null;
}

const seenInstalls = new Map<string, string>();

/** This install was used now, with this app and macOS version. Once per install per day; never throws. */
export function noteInstall(installId: string | null, appVersion: string | null, osVersion: string | null, now: Date = new Date()): void {
  if (!installId) return;
  try {
    const memo = `${now.toISOString().slice(0, 10)}|${appVersion ?? ""}|${osVersion ?? ""}`;
    if (seenInstalls.get(installId) === memo) return;
    const db = openMetrics();
    try {
      db.prepare(
        `INSERT INTO installs (install_id, first_seen, last_seen, app_version, os_version) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(install_id) DO UPDATE SET last_seen = excluded.last_seen,
           app_version = COALESCE(excluded.app_version, installs.app_version),
           os_version = COALESCE(excluded.os_version, installs.os_version)`,
      ).run(installId, now.toISOString(), now.toISOString(), clip(appVersion, 24), clip(osVersion, 16));
    } finally {
      db.close();
    }
    seenInstalls.set(installId, memo);
  } catch {
    /* metrics must never be able to fail a request */
  }
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
  /** The raw User-Agent: bots are detected from this, never from the display label (a label like
   *  "Unknown device" or "Chrome on Linux" has already lost the words that mark a bot). */
  userAgent?: unknown;
  /** Readable bucket ("Google", "ChatGPT", "Direct", a utm_source). */
  source?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  visitor?: unknown;
  /** The person recording the click is the founder (an operator cookie on the website): never a customer. */
  internal?: unknown;
}

/**
 * Why a click isn't counted as a person, or null when it is:
 *  - bot: a crawler, link preview, script or headless browser (from the raw User-Agent);
 *  - internal: the founder's own browser (operator cookie);
 *  - unverified: Vercel's edge adds the visitor's country to every real visit, so a click with no
 *    country didn't come through the live site (a test run, a copy of the site, a script).
 */
export type ExcludedReason = "bot" | "internal" | "unverified";
export function excludedReason(hit: { userAgent?: unknown; uaFamily?: unknown; internal?: unknown; country?: unknown }): ExcludedReason | null {
  if (isBotUserAgent(hit.userAgent ?? hit.uaFamily)) return "bot";
  if (hit.internal === true) return "internal";
  if (!clip(hit.country, 2)) return "unverified";
  return null;
}

export function recordDownload(hit: DownloadHit, now: Date = new Date()): void {
  const platform = clip(hit.platform, 16)?.toLowerCase() ?? "mac";
  const reason = excludedReason(hit);
  const db = openMetrics();
  try {
    db.prepare(
      `INSERT INTO download_events (platform, version, referrer, country, ua_family, created_at, bot, source, utm_source, utm_medium, utm_campaign, visitor, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PLATFORMS.has(platform) ? platform : "other",
      clip(hit.version, 24),
      clip(hit.referrer, 300),
      clip(hit.country, 2)?.toUpperCase() ?? null,
      clip(hit.uaFamily, 40),
      now.toISOString(),
      reason ? 1 : 0,
      clip(hit.source, 60),
      clip(hit.utmSource, 60),
      clip(hit.utmMedium, 60),
      clip(hit.utmCampaign, 100),
      clip(hit.visitor, 32),
      reason,
    );
  } finally {
    db.close();
  }
}

/** One anonymous account created at first launch (see the header: not strictly "installs"). */
export function recordAccountCreated(version: string | null, now: Date = new Date(), installId: string | null = null, userId: string | null = null): void {
  const db = openMetrics();
  try {
    db.prepare("INSERT INTO account_created (version, created_at, install_id) VALUES (?, ?, ?)").run(clip(version, 24), now.toISOString(), installId);
    if (userId && installId) db.prepare("UPDATE users SET install_id = ? WHERE id = ?").run(installId, userId);
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
  /** Distinct people (daily-rotating anonymous key), from when it was recorded; null before. */
  people: { today: number; last7: number; last30: number };
  /** Hits in the window that aren't people (bots, tests, the founder) -- excluded from every number below. */
  bots: number;
  /** The same hits by reason. */
  excluded: { bot: number; internal: number; unverified: number };
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
    const excluded = { bot: 0, internal: 0, unverified: 0 };
    for (const r of db
      .query("SELECT COALESCE(reason, 'bot') AS r, COUNT(*) AS n FROM download_events WHERE bot = 1 AND created_at >= ? GROUP BY r")
      .all(since) as { r: keyof typeof excluded; n: number }[]) {
      if (r.r in excluded) excluded[r.r] = r.n;
      else excluded.bot += r.n;
    }
    // A person is one fingerprint per day; rows from before fingerprints existed count once each.
    const people = (from: string) =>
      count(
        `SELECT COUNT(*) AS n FROM (SELECT COALESCE(visitor || substr(created_at, 1, 10), 'row' || id) AS k
           FROM download_events WHERE bot = 0 AND created_at >= ? GROUP BY k)`,
        from,
      );
    return {
      people: { today: people(startOfToday), last7: people(ago(7)), last30: people(ago(30)) },
      bots,
      excluded,
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
  /** Installs (Mac app 0.4.5+ sends an install id): each Mac counted once, however many accounts it makes. */
  installs: {
    total: number;
    newToday: number;
    new7: number;
    new30: number;
    active7: number;
    byOs: { os: string; installs: number }[];
    byApp: { version: string; installs: number }[];
  };
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
    const major = (os: string | null) => (os ? `macOS ${os.split(".").slice(0, 2).join(".")}` : "unknown");
    const activeInstalls = db.query("SELECT app_version, os_version FROM installs WHERE last_seen >= ?").all(ago(7)) as { app_version: string | null; os_version: string | null }[];
    const tally = <T extends string>(xs: T[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      installs: {
        total: n("SELECT COUNT(*) AS n FROM installs"),
        newToday: n("SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?", day(0)),
        new7: n("SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?", ago(7)),
        new30: n("SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?", ago(30)),
        active7: activeInstalls.length,
        byOs: tally(activeInstalls.map((i) => major(i.os_version))).map(([os, installs]) => ({ os, installs })),
        byApp: tally(activeInstalls.map((i) => i.app_version ?? "unknown")).map(([version, installs]) => ({ version, installs })),
      },
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
