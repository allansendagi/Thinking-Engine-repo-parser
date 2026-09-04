import { openRegistry } from "./auth";

/**
 * Self-hosted product metrics. Right now: app downloads -- an append-only `download_events` table
 * in the shared registry.db, one row per hit on the website's `/download/mac` endpoint. No third
 * party, no cookies; the website server forwards what it sees (referrer, Vercel's IP-country
 * header, User-Agent) since the Railway backend is behind a proxy and can't read the real client.
 */

function openMetrics() {
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
  return db;
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
}

export function recordDownload(hit: DownloadHit, now: Date = new Date()): void {
  const platform = clip(hit.platform, 16)?.toLowerCase() ?? "mac";
  const db = openMetrics();
  try {
    db.prepare(
      `INSERT INTO download_events (platform, version, referrer, country, ua_family, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PLATFORMS.has(platform) ? platform : "other",
      clip(hit.version, 24),
      clip(hit.referrer, 300),
      clip(hit.country, 2)?.toUpperCase() ?? null,
      clip(hit.uaFamily, 40),
      now.toISOString(),
    );
  } finally {
    db.close();
  }
}

export interface DownloadSummary {
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

    const total = count("SELECT COUNT(*) AS n FROM download_events");
    const today = count("SELECT COUNT(*) AS n FROM download_events WHERE created_at >= ?", startOfToday);
    const last7 = count("SELECT COUNT(*) AS n FROM download_events WHERE created_at >= ?", ago(7));
    const last30 = count("SELECT COUNT(*) AS n FROM download_events WHERE created_at >= ?", ago(30));

    const byDay = (
      db
        .query(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
           FROM download_events WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
        )
        .all(since) as { day: string; count: number }[]
    );
    const topGroup = (col: string) =>
      db
        .query(
          `SELECT COALESCE(${col}, 'unknown') AS k, COUNT(*) AS count
           FROM download_events WHERE created_at >= ? GROUP BY k ORDER BY count DESC LIMIT 12`,
        )
        .all(since) as { k: string; count: number }[];

    const recent = (
      db
        .query(
          `SELECT created_at AS at, platform, version, country, ua_family AS uaFamily, referrer
           FROM download_events ORDER BY id DESC LIMIT 40`,
        )
        .all() as DownloadSummary["recent"]
    );

    return {
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

// Admin identity moved to ./admin (also used by the capture gate). Re-exported so existing
// importers of "./metrics" keep working.
export { adminEmails, isAdmin } from "./admin";
