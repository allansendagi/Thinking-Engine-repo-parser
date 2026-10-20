import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./auth";
import { gaReport } from "./ga";
import { activityFeed, classifyDownloads, settleHistory, forgetMilestones, githubDownloads, growthSummary, noteMilestone, sendGaDownload, sourceBucket, weekOf } from "./growth";
import { BURST_CLICKS, downloadSummary, excludedReason, findBursts, noteActive, noteInstall, recordAccountCreated, recordDownload } from "./metrics";

let dir = "";
const saved = { reg: process.env.THREAD_REGISTRY_PATH, data: process.env.THREAD_DATA_DIR };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "growth-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
  process.env.THREAD_DATA_DIR = join(dir, "users");
});
afterAll(() => {
  for (const [k, v] of [["THREAD_REGISTRY_PATH", saved.reg], ["THREAD_DATA_DIR", saved.data]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const addUser = (id: string, createdAt: string, plan = "free") => {
  const db = openRegistry();
  try {
    db.prepare("INSERT INTO users (id, token_hash, created_at, plan) VALUES (?, 'h', ?, ?)").run(id, createdAt, plan);
  } finally {
    db.close();
  }
};

describe("where a download came from", () => {
  test("campaign first, then the first external site, else Direct", () => {
    expect(sourceBucket("newsletter", "https://www.google.com/")).toBe("newsletter");
    expect(sourceBucket(null, "https://www.google.co.uk/search")).toBe("Google");
    expect(sourceBucket(null, "https://chatgpt.com/c/1")).toBe("ChatGPT");
    expect(sourceBucket(null, "https://t.co/abc")).toBe("X");
    expect(sourceBucket(null, "https://news.ycombinator.com/item?id=1")).toBe("Hacker News");
    expect(sourceBucket(null, "https://www.threadnow.app/why")).toBe("Direct");
    expect(sourceBucket(null, null)).toBe("Direct");
    expect(sourceBucket(null, "https://someblog.dev/post")).toBe("someblog.dev");
  });
  test("weeks start on Monday (UTC)", () => {
    expect(weekOf("2026-10-19T10:00:00Z")).toBe("2026-10-19"); // a Monday
    expect(weekOf("2026-10-25T23:00:00Z")).toBe("2026-10-19");
  });
});

describe("growth funnel and cohorts", () => {
  beforeEach(() => { process.env.THREAD_ANALYTICS_START = "2026-01-01T00:00:00.000Z"; });
  afterEach(() => { delete process.env.THREAD_ANALYTICS_START; });
  test("each step counts accounts from the window that got that far; week 2 only for accounts old enough", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    addUser("user_ga", "2026-10-01T09:00:00Z", "pro");
    addUser("user_gb", "2026-10-02T09:00:00Z");
    addUser("user_gc", "2026-10-15T09:00:00Z");
    noteMilestone("user_ga", "first_capture", new Date("2026-10-01T09:10:00Z"));
    noteMilestone("user_ga", "first_idea", new Date("2026-10-01T11:00:00Z"));
    noteMilestone("user_gb", "first_capture", new Date("2026-10-03T09:00:00Z"));
    noteActive("user_ga", "0.4.3", new Date("2026-10-10T08:00:00Z")); // day 8-9: back in week 2
    noteActive("user_gb", "0.4.3", new Date("2026-10-04T08:00:00Z")); // only week 1
    recordDownload({ source: "Google", uaFamily: "Safari", visitor: "v1", country: "AE" }, new Date("2026-10-18T00:00:00Z"));
    recordDownload({ source: "Google", uaFamily: "Safari", utmCampaign: "launch", utmSource: "x", visitor: "v1", country: "AE" }, new Date("2026-10-18T00:00:00Z")); // same person, clicked twice
    recordDownload({ source: "Direct", uaFamily: "Googlebot/2.1", country: "US" }, new Date("2026-10-18T00:00:00Z")); // a bot: never counted

    const g = growthSummary(30, now);
    expect(g.funnel).toEqual({
      downloadClicks: 2, downloadPeople: 1, opened: 3, firstCapture: 2, firstIdea: 1, firstKeep: 0, extensionConnected: 0,
      week2: { eligible: 2, returned: 1 }, pro: 1,
    });
    expect(g.sources).toEqual([{ source: "Google", clicks: 2 }]);
    expect(g.campaigns).toEqual([{ campaign: "launch", source: "x", clicks: 1 }]);
    expect(g.medianHoursToFirstIdea).toBe(2);
    expect(g.daily).toHaveLength(30);
    expect(g.daily.at(-1)!.day).toBe("2026-10-19");
    expect(g.daily.find((d) => d.day === "2026-10-18")!.clicks).toBe(2);
    expect(g.daily.find((d) => d.day === "2026-10-18")!.people).toBe(1);
    expect(g.daily.find((d) => d.day === "2026-10-10")!.active).toBe(1);
    expect(g.totals.current.clicks).toBe(2);
    expect(g.totals.previous.clicks).toBe(0);
    const sept29 = g.cohorts.find((c) => c.week === "2026-09-28")!;
    expect([sept29.size, sept29.activated, sept29.retained[0]]).toEqual([2, 2, 1]);
    const thisWeek = g.cohorts.at(-1)!;
    expect(thisWeek.retained.every((r) => r === null)).toBe(true); // nothing to measure yet
  });

  test("account deletion removes its milestones", () => {
    noteMilestone("user_gone", "first_capture");
    forgetMilestones("user_gone");
    const db = openRegistry();
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM milestones WHERE user_id = 'user_gone'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

describe("installs", () => {
  test("one Mac is one install, however many accounts it creates; older builds count per account", async () => {
    const { recordAccountCreated, noteInstall, installIdFrom, osVersionFrom, usageSummary } = await import("./metrics");
    const mac = "0f8c7a52-1d2e-4b7a-9c3d-2a1b0c9d8e7f";
    expect(installIdFrom(mac.toUpperCase())).toBe(mac);
    expect(installIdFrom("not-a-uuid")).toBeNull();
    expect([osVersionFrom("26.0.1"), osVersionFrom("x")]).toEqual(["26.0.1", null]);
    const t = new Date("2026-10-19T09:00:00Z");
    addUser("user_i1", "2026-10-19T09:00:00Z");
    addUser("user_i2", "2026-10-19T10:00:00Z");
    addUser("user_i3", "2026-10-19T11:00:00Z");
    recordAccountCreated("0.4.5", t, mac, "user_i1");
    noteInstall(mac, "0.4.5", "26.0.1", t);
    recordAccountCreated("0.4.5", t, mac, "user_i2"); // signed out and back in on the same Mac
    recordAccountCreated("0.4.2", t, null, "user_i3"); // an older build: no install id
    const g = growthSummary(1, new Date("2026-10-19T12:00:00Z"));
    expect(g.funnel.opened).toBe(2);
    const u = usageSummary(new Date("2026-10-19T12:00:00Z"));
    expect(u.installs.byOs).toEqual([{ os: "macOS 26.0", installs: 1 }]);
    expect(u.installs.byApp).toEqual([{ version: "0.4.5", installs: 1 }]);
  });
});

describe("old clicks get the best source the data allows", () => {
  test("an external linking page is credited; the site's own page or none is 'not recorded', never a guess", async () => {
    const { backfillDownloadSources, NOT_RECORDED } = await import("./growth");
    const db = openRegistry();
    try {
      db.exec("DELETE FROM growth_meta WHERE key = 'download_sources_backfilled'");
    } finally {
      db.close();
    }
    recordDownload({ referrer: "https://x.com/someone/status/1", uaFamily: "Safari" }, new Date("2026-10-10T00:00:00Z"));
    recordDownload({ referrer: "https://www.threadnow.app/", uaFamily: "Safari" }, new Date("2026-10-10T00:00:00Z"));
    recordDownload({ uaFamily: "Safari" }, new Date("2026-10-10T00:00:00Z"));
    expect(backfillDownloadSources()).toBe(3);
    const reg = openRegistry();
    try {
      const rows = reg.query("SELECT source FROM download_events WHERE created_at = '2026-10-10T00:00:00.000Z' ORDER BY id").all() as { source: string }[];
      expect(rows.map((r) => r.source)).toEqual(["X", NOT_RECORDED, NOT_RECORDED]);
    } finally {
      reg.close();
    }
    expect(backfillDownloadSources()).toBe(0); // once
  });

  test("the anonymous visitor key is stable within a day, changes the next, and needs an IP", async () => {
    const { visitorKey } = await import("./growth");
    const a = await visitorKey("203.0.113.9", "Safari", new Date("2026-10-19T08:00:00Z"));
    expect(await visitorKey("203.0.113.9", "Safari", new Date("2026-10-19T20:00:00Z"))).toBe(a);
    expect(await visitorKey("203.0.113.9", "Safari", new Date("2026-10-20T08:00:00Z"))).not.toBe(a);
    expect(a).not.toContain("203.0.113.9");
    expect(await visitorKey(null, "Safari")).toBeNull();
  });
});

describe("test traffic", () => {
  test("bots are judged from the raw browser string; old test rows are flagged once", async () => {
    const { flagTestDownloads } = await import("./growth");
    const reg = openRegistry();
    try {
      reg.exec("DELETE FROM growth_meta WHERE key = 'test_downloads_flagged'");
    } finally {
      reg.close();
    }
    const at = new Date("2026-10-11T00:00:00Z");
    recordDownload({ userAgent: "curl/8.4.0", uaFamily: "Unknown device" }, at); // bot, caught by the raw string
    recordDownload({ uaFamily: "Chrome on Linux", referrer: "http://127.0.0.1:8080/" }, at); // CI copy of the site
    recordDownload({ uaFamily: "Safari on macOS", referrer: "https://mind-stream-continuity.vercel.app/" }, at); // preview
    recordDownload({ uaFamily: "Safari on macOS", referrer: "https://www.google.com/", country: "AE" }, at); // a person
    flagTestDownloads();
    const db = openRegistry();
    try {
      const rows = db.query("SELECT bot FROM download_events WHERE created_at = '2026-10-11T00:00:00.000Z' ORDER BY id").all() as { bot: number }[];
      expect(rows.map((r) => r.bot)).toEqual([1, 1, 1, 0]);
    } finally {
      db.close();
    }
  });
});

describe("GitHub download counts", () => {
  test("website DMG vs Sparkle updates vs update checks, summed across signed releases", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify([
        { tag_name: "thread-signed-0.4.3", published_at: "2026-10-19", assets: [
          { name: "Thread.dmg", download_count: 12 }, { name: "Thread-0.4.3.dmg", download_count: 30 }, { name: "appcast.xml", download_count: 400 } ] },
        { tag_name: "thread-signed-0.4.2", published_at: "2026-10-17", assets: [
          { name: "Thread.dmg", download_count: 20 }, { name: "Thread-0.4.2.dmg", download_count: 5 } ] },
        { tag_name: "mac-latest", published_at: null, assets: [{ name: "Thread.dmg", download_count: 999 }] },
      ]))) as unknown as typeof fetch;
    const g = await githubDownloads(fetcher, new Date("2026-10-19T12:00:00Z"));
    expect([g.website, g.updates, g.updateChecks, g.error]).toEqual([32, 35, 400, null]);
  });
});

describe("Google Analytics", () => {
  test("reports 'not connected' until configured; a server-side download needs secret + a real client id", async () => {
    delete process.env.GA_PROPERTY_ID;
    expect((await gaReport(30)).connected).toBe(false);
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    process.env.GA_MEASUREMENT_ID = "G-TEST";
    process.env.GA_API_SECRET = "s";
    sendGaDownload(null, {}, fetcher);
    sendGaDownload("not-a-client-id", {}, fetcher);
    sendGaDownload("123.456", { source: "Google" }, fetcher);
    delete process.env.GA_MEASUREMENT_ID;
    delete process.env.GA_API_SECRET;
    expect(calls).toBe(1);
  });
});


describe("why a download click isn't a person", () => {
  test("bot, the founder's own browser, or no location (not served by the live site) -- else it counts", () => {
    expect(excludedReason({ userAgent: "Mozilla/5.0 HeadlessChrome/130", country: "US" })).toBe("bot");
    expect(excludedReason({ uaFamily: "Safari", internal: true, country: "AE" })).toBe("internal");
    expect(excludedReason({ uaFamily: "Chrome on Windows" })).toBe("unverified"); // the CI test-browser pairs: no country
    expect(excludedReason({ uaFamily: "Safari", country: "AE" })).toBeNull();
    expect(excludedReason({ uaFamily: "Safari", country: "" })).toBe("unverified");
  });

  test("the summary counts only people and says what was left out and why", () => {
    const at = new Date("2026-10-18T10:00:00Z");
    recordDownload({ uaFamily: "Safari", country: "DE", visitor: "p1" }, at);
    recordDownload({ uaFamily: "Safari", country: "AE", internal: true }, at);
    recordDownload({ uaFamily: "Chrome on Windows" }, at);
    recordDownload({ uaFamily: "Chrome on Linux" }, at);
    recordDownload({ userAgent: "Googlebot/2.1", country: "US" }, at);
    const s = downloadSummary(30, new Date("2026-10-19T00:00:00Z"));
    expect(s.total).toBeGreaterThanOrEqual(1);
    expect(s.excluded.internal).toBeGreaterThanOrEqual(1);
    expect(s.excluded.unverified).toBeGreaterThanOrEqual(2);
    expect(s.excluded.bot).toBeGreaterThanOrEqual(1);
    expect(s.bots).toBe(s.excluded.bot + s.excluded.internal + s.excluded.unverified + s.excluded.burst);
  });

  test("old rows with no country are reclassified once, never deleted", () => {
    const reg = openRegistry();
    try {
      reg.exec("DELETE FROM growth_meta WHERE key = 'download_reasons_v1'");
      reg.prepare("INSERT INTO download_events (platform, created_at, bot, ua_family, country) VALUES ('mac', '2026-10-12T00:00:00Z', 0, 'Chrome on Linux', NULL)").run();
      reg.prepare("INSERT INTO download_events (platform, created_at, bot, ua_family, country) VALUES ('mac', '2026-10-12T00:00:01Z', 0, 'Safari', 'AE')").run();
    } finally {
      reg.close();
    }
    expect(classifyDownloads()).toBeGreaterThanOrEqual(1);
    expect(classifyDownloads()).toBe(0); // once
    const db = openRegistry();
    try {
      const rows = db.query("SELECT ua_family AS ua, bot, reason FROM download_events WHERE created_at IN ('2026-10-12T00:00:00Z', '2026-10-12T00:00:01Z') ORDER BY created_at").all();
      expect(rows).toEqual([{ ua: "Chrome on Linux", bot: 1, reason: "unverified" }, { ua: "Safari", bot: 0, reason: null }]);
    } finally {
      db.close();
    }
  });
});

describe("the numbers begin at the first public download", () => {
  test("accounts made before the launch cutoff (the founder's own development accounts) stay out of the account-based funnel steps and cohorts", () => {
    const before = growthSummary(90, new Date("2026-10-20T12:00:00Z"));
    addUser("user_dev1", "2026-09-02T09:00:00Z", "pro");
    addUser("user_dev2", "2026-09-03T09:00:00Z", "pro");
    addUser("user_real", "2026-10-16T09:00:00Z", "pro");
    const g = growthSummary(90, new Date("2026-10-20T12:00:00Z"));
    expect(g.funnel.pro - before.funnel.pro).toBe(1); // account-based steps: only the one made after launch
    expect(g.cohorts.reduce((n, c) => n + c.size, 0) - before.cohorts.reduce((n, c) => n + c.size, 0)).toBe(1);
  });
});

describe("what happened lately", () => {
  test("clicks (with why they don't count), new accounts and milestones, newest first, anonymous", () => {
    const now = new Date("2026-10-21T10:00:00Z");
    recordDownload({ uaFamily: "Safari on macOS", country: "DE", source: "Google" }, new Date("2026-10-21T09:00:00Z"));
    recordDownload({ uaFamily: "Chrome on Linux" }, new Date("2026-10-21T09:30:00Z"));
    recordAccountCreated("0.7.0", new Date("2026-10-21T09:45:00Z"));
    addUser("user_feed", "2026-10-21T09:45:00Z");
    noteMilestone("user_feed", "first_capture", new Date("2026-10-21T09:50:00Z"));
    const feed = activityFeed(new Date(now.getTime() - 3_600_000 * 3).toISOString());
    expect(feed.map((e) => e.kind)).toEqual(["first_capture", "account", "download", "download"]);
    expect(feed.find((e) => e.kind === "download" && e.excluded)?.excluded).toBe("unverified");
    expect(feed.find((e) => e.kind === "download" && !e.excluded)?.detail).toContain("DE · Google");
    expect(JSON.stringify(feed)).not.toContain("user_feed"); // no ids
  });
});

describe("one definition of who counts", () => {
  const OP = "11111111-1111-4111-8111-aaaaaaaaaaaa";
  const REAL = "22222222-2222-4222-8222-bbbbbbbbbbbb";
  beforeEach(() => {
    process.env.THREAD_ANALYTICS_START = "2026-10-14T00:00:00.000Z";
    process.env.THREAD_METRICS_EXCLUDE_USERS = "def_operator,def_op_feed";
  });
  afterEach(() => {
    delete process.env.THREAD_ANALYTICS_START;
    delete process.env.THREAD_METRICS_EXCLUDE_USERS;
  });

  test("Pro, first-idea and opened totals leave out operator accounts and accounts from before launch, in both periods", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const cur = () => growthSummary(7, now).totals!;
    const before = { c: cur().current, p: cur().previous };
    addUser("def_operator", "2026-10-22T09:00:00Z", "pro");
    addUser("def_predev", "2026-09-01T09:00:00Z", "pro");
    addUser("def_real", "2026-10-23T09:00:00Z", "pro");
    for (const [id, kind, at] of [
      ["def_operator", "pro", "2026-10-22T09:00:00Z"], ["def_operator", "first_idea", "2026-10-22T10:00:00Z"],
      ["def_predev", "pro", "2026-10-15T09:00:00Z"], ["def_predev", "first_idea", "2026-10-16T09:00:00Z"], // previous period
      ["def_real", "pro", "2026-10-23T09:00:00Z"], ["def_real", "first_idea", "2026-10-23T10:00:00Z"],
    ] as const) noteMilestone(id, kind, new Date(at));
    const after = cur();
    expect(after.current.pro - before.c.pro).toBe(1);
    expect(after.current.firstIdeas - before.c.firstIdeas).toBe(1);
    expect(after.current.opened - before.c.opened).toBe(1);
    expect(after.previous.pro - before.p.pro).toBe(0);
    expect(after.previous.firstIdeas - before.p.firstIdeas).toBe(0);
    expect(after.previous.opened - before.p.opened).toBe(0);
  });

  test("the activity feed doesn't list an operator's Mac, or a pre-launch one, as a new account", () => {
    const t = new Date("2026-10-26T09:00:00Z");
    addUser("def_op_feed", "2026-10-26T08:00:00Z");
    addUser("def_real_feed", "2026-10-26T08:30:00Z");
    recordAccountCreated("16.0", new Date("2026-10-26T08:00:00Z"), OP, "def_op_feed");
    recordAccountCreated("0.7.0", new Date("2026-10-26T08:30:00Z"), REAL, "def_real_feed");
    recordAccountCreated("0.2.9", new Date("2026-10-02T08:30:00Z")); // before launch
    const accounts = activityFeed(new Date(t.getTime() - 86_400_000 * 40).toISOString()).filter((e) => e.kind === "account");
    const versions = accounts.map((e) => e.detail);
    expect(versions).toContain("app 0.7.0");
    expect(versions).not.toContain("app 16.0");
    expect(versions).not.toContain("app 0.2.9");
  });
});

describe("a script's burst of clicks is not people", () => {
  const T0 = Date.parse("2026-10-27T10:54:43.996Z");
  const click = (offsetMs: number, ua = "Chrome on Windows") =>
    recordDownload({ uaFamily: ua, country: "US", visitor: `v${offsetMs}${ua}` }, new Date(T0 + offsetMs));
  const states = () => {
    const db = openRegistry();
    try {
      return db
        .query("SELECT bot, reason FROM download_events WHERE created_at >= ? AND created_at <= ? ORDER BY created_at")
        .all(new Date(T0 - 1000).toISOString(), new Date(T0 + 6 * 3_600_000).toISOString()) as { bot: number; reason: string | null }[];
    } finally {
      db.close();
    }
  };

  test("13 clicks in about a second, each with a real-looking browser, are all excluded as a burst -- including the first five", () => {
    const results = Array.from({ length: 13 }, (_, i) => click(i * 100, ["Chrome on Windows", "Edge on Windows", "Firefox on macOS"][i % 3]));
    expect(results.slice(0, BURST_CLICKS - 1).every((r) => r === null)).toBe(true); // not yet known to be a burst
    expect(results.slice(BURST_CLICKS - 1).every((r) => r === "burst")).toBe(true);
    const rows = states();
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.bot === 1 && r.reason === "burst")).toBe(true); // the early five were marked too
  });

  test("clicks at a human pace are never touched, even a handful close together", () => {
    const base = 4 * 3_600_000; // well apart from the burst above
    for (let i = 0; i < 5; i++) click(base + i * 1500); // five in 6 s: still under the threshold
    for (let i = 0; i < 12; i++) click(base + 60_000 + i * 11_000); // one every 11 s, however long it goes on
    const rows = states().filter((_, i) => i >= 13);
    expect(rows).toHaveLength(17);
    expect(rows.every((r) => r.bot === 0 && r.reason === null)).toBe(true);
  });

  test("findBursts applies the same rule to history", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, t: T0 + i * 800 }));
    expect([...findBursts(rows)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(findBursts(rows.slice(0, BURST_CLICKS - 1)).size).toBe(0);
    expect(findBursts(Array.from({ length: 30 }, (_, i) => ({ id: i, t: T0 + i * 10_001 }))).size).toBe(0);
  });

  test("history recorded before the rule is settled once: bursts marked, never deleted; the test-runner install row removed", () => {
    const reg = openRegistry();
    const base = Date.parse("2026-10-28T08:00:00Z");
    try {
      reg.exec("DELETE FROM growth_meta WHERE key IN ('download_bursts_v1', 'installs_xctest_v1')");
      for (let i = 0; i < 9; i++)
        reg.prepare("INSERT INTO download_events (platform, created_at, bot, ua_family, country, visitor) VALUES ('mac', ?, 0, 'Firefox on Windows', 'US', ?)").run(new Date(base + i * 150).toISOString(), `h${i}`);
      reg.prepare("INSERT INTO download_events (platform, created_at, bot, ua_family, country, visitor) VALUES ('mac', ?, 0, 'Safari', 'AE', 'real')").run(new Date(base + 3_600_000).toISOString());
    } finally {
      reg.close();
    }
    noteInstall("66666666-6666-4666-8666-666666666666", "16.0", "26.6", new Date(base));
    noteInstall("77777777-7777-4777-8777-777777777777", "0.7.0", "15.1", new Date(base));
    const first = settleHistory();
    expect(first.bursts).toBe(9);
    expect(first.installs).toBe(1);
    expect(settleHistory()).toEqual({ bursts: 0, installs: 0 }); // once
    const db = openRegistry();
    try {
      const rows = db.query("SELECT bot, reason FROM download_events WHERE created_at >= ? ORDER BY created_at").all(new Date(base).toISOString()) as { bot: number; reason: string | null }[];
      expect(rows).toHaveLength(10); // nothing deleted
      expect(rows.slice(0, 9).every((r) => r.bot === 1 && r.reason === "burst")).toBe(true);
      expect(rows[9]).toEqual({ bot: 0, reason: null });
      const versions = (db.query("SELECT app_version AS v FROM installs").all() as { v: string }[]).map((r) => r.v);
      expect(versions).not.toContain("16.0");
      expect(versions).toContain("0.7.0"); // a real install is left alone
    } finally {
      db.close();
    }
  });

  test("the summary reports burst clicks as left out, with their own count", () => {
    const s = downloadSummary(30, new Date("2026-10-29T00:00:00Z"));
    expect(s.excluded.burst).toBeGreaterThanOrEqual(13);
    expect(s.bots).toBe(s.excluded.bot + s.excluded.internal + s.excluded.unverified + s.excluded.burst);
  });
});
