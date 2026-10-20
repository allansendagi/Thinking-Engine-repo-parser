import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appVersionFrom, downloadSummary, forgetActivity, isBotUserAgent, noteActive, recordAccountCreated, recordDownload, usageSummary } from "./metrics";

let dir = "";
const prev = process.env.THREAD_REGISTRY_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
});
afterAll(() => {
  if (prev === undefined) delete process.env.THREAD_REGISTRY_PATH;
  else process.env.THREAD_REGISTRY_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("bot detection", () => {
  test("flags crawlers, link previews and scripts; leaves browsers and unknowns", () => {
    for (const ua of ["Googlebot/2.1", "Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "curl/8.4.0", "python-requests/2.31", "HeadlessChrome/120", "Mozilla/5.0 (compatible; AhrefsBot/7.0)"])
      expect(isBotUserAgent(ua)).toBe(true);
    for (const ua of ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", "Safari", "", null, undefined])
      expect(isBotUserAgent(ua)).toBe(false);
  });
});

describe("app version", () => {
  test("header wins; UA is the fallback; unknown is null", () => {
    expect(appVersionFrom("ThreadMac/0.4.2", "ThreadMac/0.2.9 CFNetwork/1494 Darwin/23")).toBe("0.4.2");
    expect(appVersionFrom("0.4.2", null)).toBe("0.4.2");
    expect(appVersionFrom(null, "ThreadMac/0.2.9 CFNetwork/1494.0.7 Darwin/23.4.0")).toBe("0.2.9");
    expect(appVersionFrom(null, "Mozilla/5.0 Safari")).toBeNull();
    expect(appVersionFrom("garbage", undefined)).toBeNull();
  });
});

describe("downloads exclude bots from every number", () => {
  test("counted separately and not in totals, byDay or recent", () => {
    const now = new Date("2026-10-16T10:00:00Z");
    recordDownload({ platform: "mac", version: "latest", uaFamily: "Mozilla/5.0 Safari", country: "AE" }, now);
    recordDownload({ platform: "mac", version: "latest", uaFamily: "Mozilla/5.0 Safari", country: "AE" }, now);
    recordDownload({ platform: "mac", version: "latest", uaFamily: "Slackbot-LinkExpanding", country: "US" }, now);
    const s = downloadSummary(30, now);
    expect(s.total).toBe(2);
    expect(s.bots).toBe(1);
    expect(s.byDay.reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(s.recent.every((r) => !String(r.uaFamily).includes("Slackbot"))).toBe(true);
  });
});

describe("accounts created and active installs", () => {
  test("counts new accounts by version and distinct active accounts by latest version", () => {
    const now = new Date("2026-10-16T10:00:00Z");
    recordAccountCreated("0.4.1", now);
    recordAccountCreated("0.4.1", now);
    recordAccountCreated(null, now);
    noteActive("user_a", "0.4.0", new Date("2026-10-14T10:00:00Z"));
    noteActive("user_a", "0.4.1", new Date("2026-10-16T09:00:00Z")); // upgraded
    noteActive("user_a", "0.4.1", new Date("2026-10-16T09:30:00Z")); // memoised, no second write
    noteActive("user_b", "0.2.9", new Date("2026-10-15T09:00:00Z"));
    noteActive("user_c", null, new Date("2026-10-16T09:00:00Z"));
    const u = usageSummary(now);
    expect(u.accountsCreated.total).toBe(3);
    expect(u.accountsCreated.today).toBe(3);
    expect(u.accountsCreated.byVersion.find((v) => v.version === "0.4.1")?.count).toBe(2);
    expect(u.active.today).toBe(2); // a and c
    expect(u.active.last7).toBe(3);
    const by = Object.fromEntries(u.active.byVersion.map((v) => [v.version, v.users]));
    expect(by["0.4.1"]).toBe(1); // user_a counted once, at the version used last
    expect(by["0.2.9"]).toBe(1);
    expect(by["unknown"]).toBe(1);
  });

  test("forgetActivity removes an account's rows", () => {
    const now = new Date("2026-10-16T10:00:00Z");
    noteActive("user_gone", "0.4.1", now);
    const before = usageSummary(now).active.last7;
    forgetActivity("user_gone");
    expect(usageSummary(now).active.last7).toBe(before - 1);
  });
});
