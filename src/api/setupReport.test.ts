import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSetupReport, loadSetupReports, noCaptureReason, sanitizeSetupReport, saveSetupReport } from "./setupReport";

let dir = "";
const saved = process.env.THREAD_REGISTRY_PATH;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
});
afterAll(() => {
  if (saved === undefined) delete process.env.THREAD_REGISTRY_PATH;
  else process.env.THREAD_REGISTRY_PATH = saved;
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  extensionEverConnected: false, extensionLastSeenMinutes: null, defaultBrowser: "safari", extensionBrowsersInstalled: [],
  aiAppsInstalled: [], cursorHistoryFound: false, localSourcesFound: [], accessibilityGranted: false, blockers: [], pendingCaptures: 0,
};

describe("setup report", () => {
  test("keeps only known fields in known shapes -- anything else a client sends is dropped", () => {
    const r = sanitizeSetupReport({
      ...base,
      extensionBrowsersInstalled: ["chrome", "chrome", "netscape", 7],
      aiAppsInstalled: ["cursor", "/Users/someone/Secret.app"],
      pendingCaptures: 1e9,
      blockers: ["notPaired", "rm -rf"],
      conversationTitle: "Q4 layoffs plan",
      defaultBrowser: "https://evil",
    });
    expect(r.extensionBrowsersInstalled).toEqual(["chrome"]);
    expect(r.aiAppsInstalled).toEqual(["cursor"]);
    expect(r.blockers).toEqual(["notPaired"]);
    expect(r.pendingCaptures).toBe(100_000);
    expect(r.defaultBrowser).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/layoffs|Users|evil|rm -rf/);
    expect(sanitizeSetupReport("not an object").extensionEverConnected).toBe(false);
  });

  test("why nothing was captured, first match wins", () => {
    const why = (over: object) => noCaptureReason({ report: sanitizeSetupReport({ ...base, ...over }) });
    expect(noCaptureReason(undefined)).toBe("no_report");
    expect(why({ extensionEverConnected: true, cursorHistoryFound: true })).toBe("extension_connected_no_chats");
    expect(why({ cursorHistoryFound: true, extensionBrowsersInstalled: ["chrome"] })).toBe("cursor_found_nothing_new");
    expect(why({ localSourcesFound: ["claude_code"] })).toBe("local_tool_found_nothing_new");
    expect(why({ aiAppsInstalled: ["chatgpt"] })).toBe("no_supported_browser");
    expect(why({ extensionBrowsersInstalled: ["chrome"], aiAppsInstalled: ["claude"] })).toBe("desktop_ai_apps_only");
    expect(why({ extensionBrowsersInstalled: ["arc"] })).toBe("extension_not_connected");
  });

  test("latest report per account is kept, and goes with the account", () => {
    saveSetupReport("user_x", { ...base, pendingCaptures: 1 }, new Date("2026-11-01T00:00:00Z"));
    saveSetupReport("user_x", { ...base, pendingCaptures: 2 }, new Date("2026-11-02T00:00:00Z"));
    expect(loadSetupReports().get("user_x")).toEqual({ at: "2026-11-02T00:00:00.000Z", report: sanitizeSetupReport({ ...base, pendingCaptures: 2 }) });
    forgetSetupReport("user_x");
    expect(loadSetupReports().has("user_x")).toBe(false);
  });
});
