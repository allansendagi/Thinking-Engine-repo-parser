import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./auth";
import { appVersionFrom, noteInstall, downloadSummary, forgetActivity, isBotUserAgent, noteActive, recordAccountCreated, recordDownload, usageSummary } from "./metrics";

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

describe("operator accounts are not customers", () => {
  test("their activity and the Macs they created accounts on are left out of usage", () => {
    const now = new Date("2026-10-18T10:00:00Z");
    const reg = openRegistry();
    try {
      const add = reg.prepare("INSERT INTO users (id, token_hash, created_at, install_id) VALUES (?, 'h', ?, ?)");
      add.run("op_user", now.toISOString(), "11111111-1111-4111-8111-111111111111");
      add.run("real_user", now.toISOString(), "22222222-2222-4222-8222-222222222222");
    } finally {
      reg.close();
    }
    recordAccountCreated("16.0", now, "11111111-1111-4111-8111-111111111111", "op_user");
    recordAccountCreated("0.7.0", now, "22222222-2222-4222-8222-222222222222", "real_user");
    noteInstall("11111111-1111-4111-8111-111111111111", "16.0", "26.6", now);
    noteInstall("22222222-2222-4222-8222-222222222222", "0.7.0", "15.1", now);
    noteActive("op_user", "16.0", now);
    noteActive("real_user", "0.7.0", now);

    const all = usageSummary(now);
    const real = usageSummary(now, { excluded: new Set(["op_user"]), since: "2026-10-14T00:00:00.000Z" });
    expect(all.installs.new7 - real.installs.new7).toBe(1);
    expect(real.installs.byApp.map((a) => a.version)).not.toContain("16.0");
    expect(real.installs.byApp.map((a) => a.version)).toContain("0.7.0");
    expect(all.active.today - real.active.today).toBe(1);
    expect(real.accountsCreated.byVersion.map((v) => v.version)).not.toContain("16.0");
    expect(real.active.byVersion.map((v) => v.version)).not.toContain("16.0");
  });

  test("accounts from before launch (the founder's development) are not customers either", () => {
    const now = new Date("2026-10-19T10:00:00Z");
    const reg = openRegistry();
    try {
      const add = reg.prepare("INSERT INTO users (id, token_hash, created_at, install_id) VALUES (?, 'h', ?, ?)");
      add.run("dev_old", "2026-09-02T09:00:00Z", "33333333-3333-4333-8333-333333333333");
      add.run("cust_new", "2026-10-17T09:00:00Z", "44444444-4444-4444-8444-444444444444");
    } finally {
      reg.close();
    }
    recordAccountCreated("0.3.0", new Date("2026-09-02T09:00:00Z"), "33333333-3333-4333-8333-333333333333", "dev_old");
    recordAccountCreated("0.7.0", new Date("2026-10-17T09:00:00Z"), "44444444-4444-4444-8444-444444444444", "cust_new");
    noteInstall("33333333-3333-4333-8333-333333333333", "0.3.0", "26.6", new Date("2026-09-02T09:00:00Z"));
    noteInstall("33333333-3333-4333-8333-333333333333", "0.3.0", "26.6", now); // still in use today
    noteInstall("44444444-4444-4444-8444-444444444444", "0.7.0", "15.1", new Date("2026-10-17T09:00:00Z"));
    noteInstall("44444444-4444-4444-8444-444444444444", "0.7.0", "15.1", now);
    noteActive("dev_old", "0.3.0", now);
    noteActive("cust_new", "0.7.0", now);
    const all = usageSummary(now);
    const launched = usageSummary(now, { excluded: new Set(), since: "2026-10-14T00:00:00.000Z" });
    expect(all.active.today - launched.active.today).toBe(1);
    expect(launched.installs.byApp.map((a) => a.version)).not.toContain("0.3.0");
    expect(launched.installs.byApp.map((a) => a.version)).toContain("0.7.0");
    expect(launched.accountsCreated.byVersion.map((v) => v.version)).not.toContain("0.3.0");
    expect(launched.installs.total).toBe(all.installs.total - 1);
  });

  test("an operator account made before builds sent an install id is still recognised by the Mac it uses", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const OLD_MAC = "55555555-5555-4555-8555-555555555555";
    const reg = openRegistry();
    try {
      reg.prepare("INSERT INTO users (id, token_hash, created_at) VALUES ('op_legacy', 'h', '2026-09-05T09:00:00Z')").run(); // no install_id
    } finally {
      reg.close();
    }
    noteInstall(OLD_MAC, "0.7.0", "26.9", now, "op_legacy"); // seen later, on an authenticated request
    const pop = { excluded: new Set(["op_legacy"]), since: "2026-10-14T00:00:00.000Z" };
    expect(usageSummary(now).installs.byOs.find((o) => o.os === "macOS 26.9")?.installs).toBe(1); // counted when nobody is excluded
    // The same account excluded only by the launch cutoff (not named as an operator) also drops its Mac.
    for (const p of [pop, { excluded: new Set<string>(), since: "2026-10-14T00:00:00.000Z" }]) {
      const u = usageSummary(now, p);
      expect(u.installs.byOs.find((o) => o.os === "macOS 26.9")).toBeUndefined();
    }
  });
});
