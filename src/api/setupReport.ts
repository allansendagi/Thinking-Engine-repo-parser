import { openMetrics } from "./metrics";

/**
 * What the Mac knows about its own setup, so "opened Thread but nothing was ever captured" has a
 * reason. Content-free by construction: every field is a yes/no, a small count, or a name from a
 * fixed list -- anything else is dropped here, whatever a client sends. Only the latest report per
 * account is kept, and it goes when the account does.
 */
export const BROWSERS = ["chrome", "brave", "arc", "edge", "safari", "firefox", "other"] as const;
export const AI_APPS = ["cursor", "chatgpt", "claude"] as const;
export const LOCAL_SOURCES = ["claude_code", "codex", "gemini_cli", "copilot", "jan", "ollama", "lm_studio"] as const;
export const BLOCKERS = ["accessibility", "notPaired", "captureError"] as const;

export interface SetupReport {
  /** A browser extension has ever connected to this Mac. */
  extensionEverConnected: boolean;
  /** Minutes since the extension last checked in; null if never. */
  extensionLastSeenMinutes: number | null;
  defaultBrowser: (typeof BROWSERS)[number] | null;
  /** Browsers the extension can run in that are installed. */
  extensionBrowsersInstalled: (typeof BROWSERS)[number][];
  /** Desktop AI apps installed. */
  aiAppsInstalled: (typeof AI_APPS)[number][];
  /** Cursor's local history store exists. */
  cursorHistoryFound: boolean;
  /** Tools with readable history folders on this Mac. */
  localSourcesFound: (typeof LOCAL_SOURCES)[number][];
  accessibilityGranted: boolean;
  /** Setup problems the app is currently telling the person about. */
  blockers: (typeof BLOCKERS)[number][];
  /** Captures saved on the Mac, waiting to send. */
  pendingCaptures: number;
}

const pick = <T extends string>(allowed: readonly T[], v: unknown): T[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)))] : [];
const count = (v: unknown, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);

/** Keep only the known fields, in their known shapes. */
export function sanitizeSetupReport(raw: unknown): SetupReport {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const browser = typeof r.defaultBrowser === "string" && (BROWSERS as readonly string[]).includes(r.defaultBrowser) ? (r.defaultBrowser as SetupReport["defaultBrowser"]) : null;
  return {
    extensionEverConnected: r.extensionEverConnected === true,
    extensionLastSeenMinutes: typeof r.extensionLastSeenMinutes === "number" ? count(r.extensionLastSeenMinutes, 525_600) : null,
    defaultBrowser: browser,
    extensionBrowsersInstalled: pick(BROWSERS, r.extensionBrowsersInstalled),
    aiAppsInstalled: pick(AI_APPS, r.aiAppsInstalled),
    cursorHistoryFound: r.cursorHistoryFound === true,
    localSourcesFound: pick(LOCAL_SOURCES, r.localSourcesFound),
    accessibilityGranted: r.accessibilityGranted === true,
    blockers: pick(BLOCKERS, r.blockers),
    pendingCaptures: count(r.pendingCaptures, 100_000),
  };
}

function open() {
  const db = openMetrics();
  db.exec("CREATE TABLE IF NOT EXISTS setup_reports (user_id TEXT PRIMARY KEY, at TEXT NOT NULL, report TEXT NOT NULL)");
  return db;
}

export function saveSetupReport(userId: string, raw: unknown, now: Date = new Date()): SetupReport {
  const report = sanitizeSetupReport(raw);
  const db = open();
  try {
    db.prepare("INSERT OR REPLACE INTO setup_reports (user_id, at, report) VALUES (?, ?, ?)").run(userId, now.toISOString(), JSON.stringify(report));
  } finally {
    db.close();
  }
  return report;
}

export function loadSetupReports(): Map<string, { at: string; report: SetupReport }> {
  const db = open();
  try {
    const rows = db.query("SELECT user_id, at, report FROM setup_reports").all() as { user_id: string; at: string; report: string }[];
    return new Map(rows.map((r) => [r.user_id, { at: r.at, report: sanitizeSetupReport(JSON.parse(r.report)) }]));
  } finally {
    db.close();
  }
}

export function forgetSetupReport(userId: string): void {
  const db = open();
  try {
    db.prepare("DELETE FROM setup_reports WHERE user_id = ?").run(userId);
  } finally {
    db.close();
  }
}

/**
 * Why an account that opened Thread has captured nothing, from its latest report. First match wins:
 *  - no_report: an app build that doesn't report (or it never reached the server).
 *  - extension_connected_no_chats: the browser is connected; no AI chat has been opened since.
 *  - cursor_found_nothing_new: Cursor's history is there, but Thread only captures Cursor turns
 *    made after it was installed (older history is the explicit "Recover my thinking"), and none yet.
 *  - local_tool_found_nothing_new: the same, for another tool with readable history.
 *  - no_supported_browser: no Chrome / Brave / Arc / Edge -- the extension can't run.
 *  - desktop_ai_apps_only: has ChatGPT or Claude desktop apps, no connected extension -- Thread
 *    can't read those apps.
 *  - extension_not_connected: a supported browser is installed; the extension never connected.
 */
export function noCaptureReason(entry: { report: SetupReport } | undefined): string {
  if (!entry) return "no_report";
  const r = entry.report;
  if (r.extensionEverConnected) return "extension_connected_no_chats";
  if (r.cursorHistoryFound) return "cursor_found_nothing_new";
  if (r.localSourcesFound.length > 0) return "local_tool_found_nothing_new";
  if (r.extensionBrowsersInstalled.length === 0) return "no_supported_browser";
  if (r.aiAppsInstalled.some((a) => a === "chatgpt" || a === "claude")) return "desktop_ai_apps_only";
  return "extension_not_connected";
}
