import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./auth";
import { gaReport } from "./ga";
import { forgetMilestones, githubDownloads, growthSummary, noteMilestone, sendGaDownload, sourceBucket, weekOf } from "./growth";
import { noteActive, recordDownload } from "./metrics";

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
    recordDownload({ source: "Google", uaFamily: "Safari" }, new Date("2026-10-18T00:00:00Z"));
    recordDownload({ source: "Google", uaFamily: "Safari", utmCampaign: "launch", utmSource: "x" }, new Date("2026-10-18T00:00:00Z"));
    recordDownload({ source: "Direct", uaFamily: "Googlebot/2.1" }, new Date("2026-10-18T00:00:00Z")); // a bot: never counted

    const g = growthSummary(30, now);
    expect(g.funnel).toEqual({
      downloadClicks: 2, opened: 3, firstCapture: 2, firstIdea: 1, firstKeep: 0, extensionConnected: 0,
      week2: { eligible: 2, returned: 1 }, pro: 1,
    });
    expect(g.sources).toEqual([{ source: "Google", clicks: 2 }]);
    expect(g.campaigns).toEqual([{ campaign: "launch", source: "x", clicks: 1 }]);
    expect(g.medianHoursToFirstIdea).toBe(2);
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
