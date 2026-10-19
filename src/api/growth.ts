import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openMetrics } from "./metrics";
import { excludedUserIds } from "./revenue";
import { dbPathForUser } from "../db/tenancy";

/**
 * Growth: the whole path from a website visit to a paying, returning user, measured first-party.
 *
 *   download click -> file downloaded -> app opened -> first capture -> first idea -> back in week 2 -> Pro
 *
 *  - Clicks: `download_events` (metrics.ts), now with where the visitor came from.
 *  - Files downloaded: GitHub's own per-asset download counts. `Thread.dmg` is what the website
 *    serves; `Thread-x.y.z.dmg` is what Sparkle fetches to update an installed app; `appcast.xml`
 *    is fetched on every update check. GitHub only keeps running totals, so a daily snapshot is
 *    stored here and days are the differences.
 *  - Opened, captured, first idea, Pro: `milestones`, one row per account per first time.
 *  - Coming back: `active_days` (metrics.ts), grouped by the week the account was created.
 * Apple gives no numbers for apps distributed outside the App Store; this is the substitute.
 */

export type Milestone = "first_capture" | "first_idea" | "first_keep" | "extension_connected" | "pro";
const KINDS: Milestone[] = ["first_capture", "first_idea", "first_keep", "extension_connected", "pro"];

function openGrowth(): Database {
  const db = openMetrics(); // the registry, with download_events / active_days ensured
  db.exec(
    `CREATE TABLE IF NOT EXISTS milestones (
       user_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       at TEXT NOT NULL,
       PRIMARY KEY (user_id, kind)
     );
     CREATE INDEX IF NOT EXISTS milestones_kind ON milestones(kind, at);
     CREATE TABLE IF NOT EXISTS github_downloads (
       day TEXT NOT NULL,
       asset TEXT NOT NULL,
       count INTEGER NOT NULL,
       PRIMARY KEY (day, asset)
     );
     CREATE TABLE IF NOT EXISTS growth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  return db;
}

// One write per account per milestone per process, not one per request.
const seen = new Set<string>();

/** The first time this account did `kind`. Idempotent; never throws (metrics can't fail a request). */
export function noteMilestone(userId: string, kind: Milestone, at: Date = new Date()): void {
  const key = `${userId}|${kind}`;
  if (seen.has(key)) return;
  try {
    const db = openGrowth();
    try {
      db.prepare("INSERT OR IGNORE INTO milestones (user_id, kind, at) VALUES (?, ?, ?)").run(userId, kind, at.toISOString());
    } finally {
      db.close();
    }
    seen.add(key);
  } catch {
    /* best-effort */
  }
}

/** Remove an account's milestones (account deletion). */
export function forgetMilestones(userId: string): void {
  for (const k of KINDS) seen.delete(`${userId}|${k}`);
  const db = openGrowth();
  try {
    db.prepare("DELETE FROM milestones WHERE user_id = ?").run(userId);
  } finally {
    db.close();
  }
}

/**
 * Once per deployment: fill milestones for accounts that existed before they were recorded, from
 * each account's own database (read-only; skipped when the file doesn't exist). Without this,
 * every earlier cohort would show 0% activation. Times are clamped to the account's creation:
 * an import brings messages older than the account, but it was captured after it.
 */
export function backfillMilestones(force = false): number {
  const reg = openGrowth();
  try {
    if (!force && reg.query("SELECT 1 FROM growth_meta WHERE key = 'milestones_backfilled'").get()) return 0;
    const users = reg.query("SELECT id, created_at, plan FROM users").all() as { id: string; created_at: string; plan: string | null }[];
    const put = reg.prepare("INSERT OR IGNORE INTO milestones (user_id, kind, at) VALUES (?, ?, ?)");
    let n = 0;
    for (const u of users) {
      const clamp = (t: string | null | undefined) => (t ? (t < u.created_at ? u.created_at : t) : null);
      if (u.plan === "pro") n += put.run(u.id, "pro", u.created_at).changes;
      let db: Database | null = null;
      try {
        const path = dbPathForUser(u.id);
        if (!existsSync(path)) continue;
        db = new Database(path, { readonly: true });
        const one = (sql: string) => (db!.query(sql).get() as { t: string | null } | null)?.t ?? null;
        const has = (t: string) => !!db!.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
        const capture = clamp(has("evidence") ? one("SELECT MIN(observed_at) AS t FROM evidence") : null) ?? clamp(one("SELECT MIN(created_at) AS t FROM canonical_events"));
        const idea = clamp(one("SELECT MIN(created_at) AS t FROM idea_nodes"));
        const keep = has("idea_verdicts") ? clamp(one("SELECT MIN(created_at) AS t FROM idea_verdicts WHERE origin IS NULL")) : null;
        const ext = clamp(one("SELECT MIN(created_at) AS t FROM canonical_events WHERE capture_method = 'browser_extension'"));
        for (const [kind, at] of [["first_capture", capture], ["first_idea", idea && capture && idea < capture ? capture : idea], ["first_keep", keep], ["extension_connected", ext]] as const) {
          if (at) n += put.run(u.id, kind, at).changes;
        }
      } catch {
        /* an unreadable or older database: skip it */
      } finally {
        db?.close();
      }
    }
    reg.prepare("INSERT OR REPLACE INTO growth_meta (key, value) VALUES ('milestones_backfilled', ?)").run(new Date().toISOString());
    return n;
  } finally {
    reg.close();
  }
}

// ------------------------------------------------------------------------------ GitHub counts

const REPO = process.env.THREAD_RELEASES_REPO ?? "allansendagi/Thinking-Engine-repo-parser";
let ghCache: { at: number; fetcher: typeof fetch; data: GithubDownloads } | null = null;

export interface GithubDownloads {
  /** Thread.dmg across every release: what the website's Download button serves. */
  website: number;
  /** Thread-x.y.z.dmg: installed apps updating themselves (Sparkle). */
  updates: number;
  /** appcast.xml fetches: update checks by installed apps. */
  updateChecks: number;
  byRelease: { tag: string; publishedAt: string | null; website: number; updates: number }[];
  /** Day-by-day, from stored snapshots (first day has no "before", so it's left out). */
  byDay: { day: string; website: number; updates: number }[];
  fetchedAt: string | null;
  error: string | null;
}

/** GitHub's counts, cached ~15 minutes and snapshotted daily. Never throws. */
export async function githubDownloads(fetcher: typeof fetch = fetch, now: Date = new Date()): Promise<GithubDownloads> {
  // Cached per source: a result fetched one way is never served for a request made another way.
  if (ghCache && ghCache.fetcher === fetcher && now.getTime() - ghCache.at < 15 * 60_000) return ghCache.data;
  const empty = (error: string | null): GithubDownloads => ({ website: 0, updates: 0, updateChecks: 0, byRelease: [], byDay: snapshotDays(), fetchedAt: null, error });
  try {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "thread-admin" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
    if (!res.ok) return empty(`GitHub ${res.status}`);
    const releases = (await res.json()) as { tag_name: string; published_at: string | null; assets: { name: string; download_count: number }[] }[];
    const byRelease = releases
      .filter((r) => r.tag_name.startsWith("thread-signed-"))
      .map((r) => ({
        tag: r.tag_name,
        publishedAt: r.published_at,
        website: r.assets.filter((a) => a.name === "Thread.dmg").reduce((s, a) => s + a.download_count, 0),
        updates: r.assets.filter((a) => /^Thread-\d.*\.dmg$/.test(a.name)).reduce((s, a) => s + a.download_count, 0),
        checks: r.assets.filter((a) => a.name === "appcast.xml").reduce((s, a) => s + a.download_count, 0),
      }));
    const website = byRelease.reduce((s, r) => s + r.website, 0);
    const updates = byRelease.reduce((s, r) => s + r.updates, 0);
    const updateChecks = byRelease.reduce((s, r) => s + r.checks, 0);
    const day = now.toISOString().slice(0, 10);
    const db = openGrowth();
    try {
      const put = db.prepare("INSERT OR REPLACE INTO github_downloads (day, asset, count) VALUES (?, ?, ?)");
      put.run(day, "website", website);
      put.run(day, "updates", updates);
      put.run(day, "checks", updateChecks);
    } finally {
      db.close();
    }
    const data: GithubDownloads = {
      website, updates, updateChecks,
      byRelease: byRelease.map(({ checks: _c, ...r }) => r),
      byDay: snapshotDays(),
      fetchedAt: now.toISOString(),
      error: null,
    };
    ghCache = { at: now.getTime(), fetcher, data };
    return data;
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
}

function snapshotDays(): GithubDownloads["byDay"] {
  const db = openGrowth();
  try {
    const rows = db.query("SELECT day, asset, count FROM github_downloads WHERE asset IN ('website', 'updates') ORDER BY day").all() as { day: string; asset: string; count: number }[];
    const days = [...new Set(rows.map((r) => r.day))];
    const at = (d: string, a: string) => rows.find((r) => r.day === d && r.asset === a)?.count ?? 0;
    return days.slice(1).map((d, i) => ({
      day: d,
      website: Math.max(0, at(d, "website") - at(days[i]!, "website")),
      updates: Math.max(0, at(d, "updates") - at(days[i]!, "updates")),
    }));
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------------------ the summary

export interface Growth {
  windowDays: number;
  /** Accounts created in the window and how far each got (each step is a subset of "opened"). */
  funnel: {
    downloadClicks: number;
    /** Distinct people behind those clicks (one per anonymous daily key). */
    downloadPeople: number;
    opened: number;
    firstCapture: number;
    firstIdea: number;
    firstKeep: number;
    extensionConnected: number;
    /** Of accounts at least 14 days old: came back on any day in their second week. */
    week2: { eligible: number; returned: number };
    pro: number;
  };
  /** Accounts by install week: how many were active in each following week. */
  cohorts: { week: string; size: number; activated: number; retained: (number | null)[] }[];
  /** Where download clicks came from (first touch). */
  sources: { source: string; clicks: number }[];
  campaigns: { campaign: string; source: string | null; clicks: number }[];
  /** Median hours from opening the app to the first idea, for accounts in the window. */
  medianHoursToFirstIdea: number | null;
  /** Headline numbers for this window and the one before it (same length), for "vs previous". */
  totals: { current: PeriodTotals; previous: PeriodTotals };
  /** One row per UTC day in the window, oldest first, zero-filled -- for trend lines. */
  daily: ({ day: string } & PeriodTotals)[];
  note: string;
}

export interface PeriodTotals {
  clicks: number;
  people: number;
  /** New installs opened (each Mac once; older builds per account). */
  opened: number;
  /** Distinct accounts that used Thread (over a day: that day; over a window: any day in it). */
  active: number;
  firstIdeas: number;
  pro: number;
}

/** Headline numbers for [from, to). Days are UTC ISO strings; `to` exclusive. */
/** `AND <col> NOT IN (...)` for operator/test accounts (ids validated, so safe to inline). */
function notExcluded(db: Database, col: string): string {
  const ids = [...excludedUserIds(db)].filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
  return ids.length ? ` AND ${col} NOT IN (${ids.map((i) => `'${i}'`).join(",")})` : "";
}

function periodTotals(db: Database, from: string, to: string): PeriodTotals {
  const n = (sql: string, ...a: string[]) => (db.query(sql).get(...a) as { n: number }).n;
  return {
    clicks: n("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ? AND created_at < ?", from, to),
    people: n(
      `SELECT COUNT(*) AS n FROM (SELECT COALESCE(visitor || substr(created_at, 1, 10), 'row' || id) AS k
         FROM download_events WHERE bot = 0 AND created_at >= ? AND created_at < ? GROUP BY k)`,
      from, to,
    ),
    opened: n(
      `SELECT COUNT(DISTINCT COALESCE(u.install_id, u.id)) AS n FROM users u
         LEFT JOIN installs i ON i.install_id = u.install_id
        WHERE u.created_at >= ? AND u.created_at < ? AND (u.install_id IS NULL OR i.first_seen IS NULL OR i.first_seen >= ?)${notExcluded(db, "u.id")}`,
      from, to, from,
    ),
    active: n(`SELECT COUNT(DISTINCT user_id) AS n FROM active_days WHERE day >= ? AND day < ?${notExcluded(db, "user_id")}`, from.slice(0, 10), to.slice(0, 10)),
    firstIdeas: n("SELECT COUNT(*) AS n FROM milestones WHERE kind = 'first_idea' AND at >= ? AND at < ?", from, to),
    pro: n("SELECT COUNT(*) AS n FROM milestones WHERE kind = 'pro' AND at >= ? AND at < ?", from, to),
  };
}

const COHORT_WEEKS = 8;

/** Monday (UTC) of the week holding `iso`, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function growthSummary(windowDays = 30, now: Date = new Date()): Growth {
  backfillMilestones();
  backfillDownloadSources();
  flagTestDownloads();
  const db = openGrowth();
  try {
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const users = db.query(`SELECT id, created_at, plan FROM users WHERE created_at >= ?${notExcluded(db, "id")}`).all(since) as { id: string; created_at: string; plan: string | null }[];
    const ids = new Set(users.map((u) => u.id));
    const ms = db.query("SELECT user_id, kind, at FROM milestones").all() as { user_id: string; kind: Milestone; at: string }[];
    const reached = (kind: Milestone) => new Set(ms.filter((m) => m.kind === kind && ids.has(m.user_id)).map((m) => m.user_id));
    const clicks = (db.query("SELECT COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ?").get(since) as { n: number }).n;
    const people = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM (SELECT COALESCE(visitor || substr(created_at, 1, 10), 'row' || id) AS k
             FROM download_events WHERE bot = 0 AND created_at >= ? GROUP BY k)`,
        )
        .get(since) as { n: number }
    ).n;

    const active = db.query("SELECT user_id, day FROM active_days").all() as { user_id: string; day: string }[];
    const daysOf = new Map<string, string[]>();
    for (const a of active) (daysOf.get(a.user_id) ?? daysOf.set(a.user_id, []).get(a.user_id)!).push(a.day);
    const DAY = 86_400_000;
    const offset = (created: string, day: string) => Math.floor((Date.parse(day + "T12:00:00Z") - Date.parse(created)) / DAY);

    const eligible = users.filter((u) => now.getTime() - Date.parse(u.created_at) >= 14 * DAY);
    const returned = eligible.filter((u) => (daysOf.get(u.id) ?? []).some((d) => { const o = offset(u.created_at, d); return o >= 7 && o < 14; }));

    // Cohorts: every account (not only the window), by install week, last COHORT_WEEKS weeks.
    const all = db.query(`SELECT id, created_at FROM users WHERE 1=1${notExcluded(db, "id")}`).all() as { id: string; created_at: string }[];
    const captured = new Set(ms.filter((m) => m.kind === "first_capture").map((m) => m.user_id));
    const thisWeek = weekOf(now.toISOString());
    const weeks = Array.from({ length: COHORT_WEEKS }, (_, i) => {
      const d = new Date(thisWeek + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 7 * (COHORT_WEEKS - 1 - i));
      return d.toISOString().slice(0, 10);
    });
    const cohorts = weeks.map((week) => {
      const members = all.filter((u) => weekOf(u.created_at) === week);
      const ageWeeks = Math.floor((Date.parse(thisWeek) - Date.parse(week)) / (7 * DAY));
      const retained = Array.from({ length: COHORT_WEEKS - 1 }, (_, k) => {
        const w = k + 1;
        if (w > ageWeeks || members.length === 0) return null; // that week hasn't happened yet
        return members.filter((u) => (daysOf.get(u.id) ?? []).some((d) => { const o = offset(u.created_at, d); return o >= 7 * w && o < 7 * (w + 1); })).length;
      });
      return { week, size: members.length, activated: members.filter((u) => captured.has(u.id)).length, retained };
    });

    const group = (sql: string) => db.query(sql).all(since) as { k: string | null; s?: string | null; n: number }[];
    const sources = group(
      "SELECT COALESCE(source, 'unknown') AS k, COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ? GROUP BY k ORDER BY n DESC LIMIT 15",
    ).map((r) => ({ source: r.k ?? "unknown", clicks: r.n }));
    const campaigns = group(
      "SELECT utm_campaign AS k, utm_source AS s, COUNT(*) AS n FROM download_events WHERE bot = 0 AND created_at >= ? AND utm_campaign IS NOT NULL GROUP BY k, s ORDER BY n DESC LIMIT 15",
    ).map((r) => ({ campaign: r.k ?? "", source: r.s ?? null, clicks: r.n }));

    const firstIdeaAt = new Map(ms.filter((m) => m.kind === "first_idea").map((m) => [m.user_id, m.at]));
    const hours = users
      .map((u) => firstIdeaAt.get(u.id))
      .map((t, i) => (t ? (Date.parse(t) - Date.parse(users[i]!.created_at)) / 3_600_000 : null))
      .filter((h): h is number => h !== null && h >= 0)
      .sort((a, b) => a - b);

    return {
      windowDays,
      funnel: {
        downloadClicks: clicks,
        downloadPeople: people,
        opened: openedInWindow(db, since),
        firstCapture: reached("first_capture").size,
        firstIdea: reached("first_idea").size,
        firstKeep: reached("first_keep").size,
        extensionConnected: reached("extension_connected").size,
        week2: { eligible: eligible.length, returned: returned.length },
        pro: users.filter((u) => u.plan === "pro").length,
      },
      cohorts,
      sources,
      campaigns,
      medianHoursToFirstIdea: hours.length ? Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10 : null,
      totals: {
        current: periodTotals(db, since, now.toISOString()),
        previous: periodTotals(db, new Date(now.getTime() - 2 * windowDays * DAY).toISOString(), since),
      },
      daily: Array.from({ length: windowDays }, (_, i) => {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (windowDays - 1 - i)));
        const end = new Date(start.getTime() + DAY);
        return { day: start.toISOString().slice(0, 10), ...periodTotals(db, start.toISOString(), end.toISOString()) };
      }),
      note: "“Opened” counts each Mac once (from app 0.4.5, which sends an install id). Accounts from older builds count one each, so it can still run slightly high until those update.",
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------------------ attribution

/**
 * Where a download click came from, as one readable bucket: the campaign's utm_source when the
 * link carried one, else the first external site the visitor arrived from, else "Direct".
 */
export function sourceBucket(utmSource: string | null | undefined, referrer: string | null | undefined): string {
  const u = utmSource?.trim().toLowerCase();
  if (u) return u.slice(0, 40);
  let host = "";
  try {
    host = referrer ? new URL(referrer).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }
  if (!host || host.endsWith("threadnow.app")) return "Direct";
  const known: [RegExp, string][] = [
    [/(^|\.)google\./, "Google"], [/(^|\.)bing\.com$/, "Bing"], [/duckduckgo\.com$/, "DuckDuckGo"],
    [/(^|\.)chatgpt\.com$|openai\.com$/, "ChatGPT"], [/perplexity\.ai$/, "Perplexity"], [/claude\.ai$/, "Claude"],
    [/(^|\.)(x|twitter)\.com$|^t\.co$/, "X"], [/linkedin\.com$|^lnkd\.in$/, "LinkedIn"], [/reddit\.com$/, "Reddit"],
    [/producthunt\.com$/, "Product Hunt"], [/news\.ycombinator\.com$/, "Hacker News"], [/youtube\.com$|youtu\.be$/, "YouTube"],
    [/github\.com$/, "GitHub"], [/facebook\.com$|fb\.com$/, "Facebook"], [/instagram\.com$/, "Instagram"],
  ];
  return known.find(([re]) => re.test(host))?.[1] ?? host.slice(0, 60);
}

/**
 * GA4 Measurement Protocol: the server-side "download" for the visitor's GA client id, so GA's
 * own funnels see the real download (the click alone can be lost when the page navigates away).
 * Only when GA_MEASUREMENT_ID and GA_API_SECRET are set. Fire-and-forget.
 */
export function sendGaDownload(clientId: string | null | undefined, params: Record<string, string>, fetcher: typeof fetch = fetch): void {
  const id = process.env.GA_MEASUREMENT_ID, secret = process.env.GA_API_SECRET;
  if (!id || !secret || !clientId || !/^\d+\.\d+$/.test(clientId)) return;
  void fetcher(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(id)}&api_secret=${encodeURIComponent(secret)}`, {
    method: "POST",
    body: JSON.stringify({ client_id: clientId, events: [{ name: "download_served", params: { ...params, engagement_time_msec: 1 } }] }),
  }).catch(() => {});
}

/** Label for clicks recorded before sources were: their visitor's first touch was never stored. */
export const NOT_RECORDED = "Not recorded (before 19 Oct)";

/**
 * Once: give download clicks recorded before sources existed the best source the data allows.
 * Each kept the page that linked to /download/mac: when that's an external site (a direct link
 * shared on X, a blog...), that site gets the credit; when it's Thread's own site or nothing, the
 * visitor's real origin was never recorded and the row says exactly that -- never a guess.
 */
export function backfillDownloadSources(): number {
  const db = openGrowth();
  try {
    if (db.query("SELECT 1 FROM growth_meta WHERE key = 'download_sources_backfilled'").get()) return 0;
    const rows = db.query("SELECT id, referrer FROM download_events WHERE source IS NULL").all() as { id: number; referrer: string | null }[];
    const put = db.prepare("UPDATE download_events SET source = ? WHERE id = ?");
    db.transaction(() => {
      for (const r of rows) {
        const b = sourceBucket(null, r.referrer);
        put.run(b === "Direct" ? NOT_RECORDED : b, r.id);
      }
      db.prepare("INSERT OR REPLACE INTO growth_meta (key, value) VALUES ('download_sources_backfilled', ?)").run(new Date().toISOString());
    })();
    return rows.length;
  } finally {
    db.close();
  }
}

/**
 * An anonymous key for "the same person today": a hash of a secret salt (kept only on this
 * server), the day, the visitor's IP and browser. It changes every day and can't be turned back
 * into an IP, so it counts people without identifying anyone; the IP itself is never stored.
 */
export async function visitorKey(ip: string | null, userAgent: string | null, now: Date = new Date()): Promise<string | null> {
  if (!ip) return null;
  const db = openGrowth();
  let salt: string;
  try {
    const row = db.query("SELECT value FROM growth_meta WHERE key = 'visitor_salt'").get() as { value: string } | null;
    salt = row?.value ?? crypto.randomUUID() + crypto.randomUUID();
    if (!row) db.prepare("INSERT OR IGNORE INTO growth_meta (key, value) VALUES ('visitor_salt', ?)").run(salt);
  } finally {
    db.close();
  }
  const data = new TextEncoder().encode(`${salt}|${now.toISOString().slice(0, 10)}|${ip}|${userAgent ?? ""}`);
  return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex").slice(0, 24);
}

/**
 * New installs opened in the window: each Mac once -- an account re-created on a Mac that was
 * already counted (sign out, sign back in) isn't a new install. Accounts from builds without an
 * install id count one each.
 */
function openedInWindow(db: Database, since: string): number {
  return (
    db
      .query(
        `SELECT COUNT(DISTINCT COALESCE(u.install_id, u.id)) AS n FROM users u
          LEFT JOIN installs i ON i.install_id = u.install_id
          WHERE u.created_at >= ? AND (u.install_id IS NULL OR i.first_seen IS NULL OR i.first_seen >= ?)${notExcluded(db, "u.id")}`,
      )
      .get(since, since) as { n: number }
  ).n;
}

/**
 * Once: mark download clicks that weren't real people. Until 19 Oct the bot check looked at the
 * display label ("Unknown device", "Chrome on Linux") instead of the raw browser string, so
 * scripts and headless test browsers were counted; and copies of the site (local, preview, CI)
 * pinged the production counter. Marked, not deleted: rows from those copies (by referrer host),
 * our own test campaign tags, and clicks with no recognisable browser at all.
 */
export function flagTestDownloads(): number {
  const db = openGrowth();
  try {
    if (db.query("SELECT 1 FROM growth_meta WHERE key = 'test_downloads_flagged'").get()) return 0;
    const n = db
      .prepare(
        `UPDATE download_events SET bot = 1 WHERE bot = 0 AND (
           ua_family = 'Unknown device'
           OR referrer LIKE 'http://localhost%' OR referrer LIKE 'http://127.0.0.1%'
           OR referrer LIKE '%.vercel.app%'
           OR utm_source IN ('test', 'qa', 'ga-realtime-check')
           OR source IN ('127.0.0.1', 'localhost') OR source LIKE '%.vercel.app'
         )`,
      )
      .run().changes;
    db.prepare("INSERT OR REPLACE INTO growth_meta (key, value) VALUES ('test_downloads_flagged', ?)").run(new Date().toISOString());
    return n;
  } finally {
    db.close();
  }
}
