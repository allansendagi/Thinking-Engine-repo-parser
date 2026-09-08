import type {
  AccountInfo,
  CaptureHealth,
  CaptureReport,
  Credentials,
  PairingState,
  Settings,
  SourceHealth,
} from "./types";

export const DEFAULT_API_BASE_URL = "https://thinking-engine-repo-parser-production.up.railway.app";

/** Thin wrapper over chrome.storage.local so the rest of the code isn't littered with string keys. */

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(["apiBaseUrl", "credentials"]);
  return {
    apiBaseUrl: (result.apiBaseUrl as string | undefined) ?? DEFAULT_API_BASE_URL,
    credentials: (result.credentials as Credentials | undefined) ?? null,
  };
}

export async function setApiBaseUrl(apiBaseUrl: string): Promise<void> {
  await chrome.storage.local.set({ apiBaseUrl });
}

export async function setCredentials(credentials: Credentials): Promise<void> {
  await chrome.storage.local.set({ credentials });
}

export async function clearCredentials(): Promise<void> {
  await chrome.storage.local.remove("credentials");
}

// --- Account identity (shown in the popup) --------------------------------------------------

export async function getAccountInfo(): Promise<AccountInfo | null> {
  const { accountInfo } = await chrome.storage.local.get("accountInfo");
  return (accountInfo as AccountInfo | undefined) ?? null;
}

export async function setAccountInfo(info: AccountInfo | null): Promise<void> {
  if (info) await chrome.storage.local.set({ accountInfo: info });
  else await chrome.storage.local.remove("accountInfo");
}

// --- Capture health ------------------------------------------------------------------------
//
// Folds each content-script `CaptureReport` into a per-source verdict the popup can render.
// The point: a broken adapter (site redesign) otherwise fails completely silently -- capture
// just stops and nothing says so.

/** Two consecutive "conversation open, container in the DOM, extracted nothing" passes before
 *  we call a source degraded -- one empty pass is normal (between turns, mid-render). */
const DEGRADE_AFTER_EMPTY = 2;

export async function getCaptureHealth(): Promise<CaptureHealth> {
  const { captureHealth } = await chrome.storage.local.get("captureHealth");
  return (captureHealth as CaptureHealth | undefined) ?? {};
}

function foldReport(prev: SourceHealth | undefined, r: CaptureReport): SourceHealth {
  const base: SourceHealth = prev ?? {
    source: r.source,
    state: "idle",
    lastCaptureAt: null,
    lastSeenAt: null,
    lastError: null,
    emptyStreak: 0,
    detail: "",
  };
  const next: SourceHealth = { ...base, source: r.source, lastSeenAt: r.at };

  if (r.error) {
    next.state = "error";
    next.lastError = r.error;
    next.emptyStreak = 0;
    next.detail = `Last capture failed: ${r.error}`;
    return next;
  }
  if (!r.onConversation) {
    next.state = "idle";
    next.emptyStreak = 0;
    next.lastError = null;
    next.detail = "No conversation open";
    return next;
  }
  if (r.extracted > 0) {
    next.state = "ok";
    next.emptyStreak = 0;
    next.lastError = null;
    if (r.sent > 0) next.lastCaptureAt = r.at;
    next.detail = r.sent > 0 ? "Captured just now" : "Up to date";
    return next;
  }
  // On a conversation, extracted nothing.
  if (!r.containerPresent) {
    // Page still mounting -- not a failure, just say nothing changed.
    next.detail = base.state === "ok" ? "Up to date" : "Waiting for the page to load";
    return next;
  }
  next.emptyStreak = base.emptyStreak + 1;
  if (next.emptyStreak >= DEGRADE_AFTER_EMPTY) {
    next.state = "degraded";
    next.detail = "The page changed and Thread can't read it — reload the tab; if it sticks, update Thread.";
  } else {
    next.detail = base.state === "degraded" ? next.detail : "Up to date";
  }
  return next;
}

export async function recordCaptureReport(report: CaptureReport): Promise<CaptureHealth> {
  const health = await getCaptureHealth();
  health[report.source] = foldReport(health[report.source], report);
  await chrome.storage.local.set({ captureHealth: health });
  return health;
}

/** Exposed for tests -- the pure fold, no storage. */
export const _foldReport = foldReport;

const DEFAULT_PAIRING_STATE: PairingState = {
  status: "unpaired",
  userId: null,
  lastAttemptAt: null,
  detail: "Open Thread for Mac to connect this browser.",
};

export async function getPairingState(): Promise<PairingState> {
  const result = await chrome.storage.local.get("pairingState");
  return (result.pairingState as PairingState | undefined) ?? DEFAULT_PAIRING_STATE;
}

export async function setPairingState(patch: Partial<PairingState>): Promise<PairingState> {
  const next = { ...(await getPairingState()), ...patch };
  await chrome.storage.local.set({ pairingState: next });
  return next;
}

/**
 * Per-conversation record of which message ids have already been sent, so the content script
 * doesn't re-POST a full transcript's worth of already-known messages on every mutation. This is
 * purely a client-side optimization -- the backend independently re-derives "what's new" from its
 * own DB and would produce the same result without this, just with a larger request body each
 * time. Keyed by `sentIds:<conversationId>`.
 */
export async function getSentIds(conversationId: string): Promise<Set<string>> {
  const key = `sentIds:${conversationId}`;
  const result = await chrome.storage.local.get(key);
  const ids = (result[key] as string[] | undefined) ?? [];
  return new Set(ids);
}

export async function addSentIds(conversationId: string, ids: string[]): Promise<void> {
  const key = `sentIds:${conversationId}`;
  const existing = await getSentIds(conversationId);
  for (const id of ids) existing.add(id);
  await chrome.storage.local.set({ [key]: [...existing] });
}

/**
 * When the return nudge for an idea was last dismissed or acted on, as `{ ideaId: ISO }`. The
 * rule in lib/resume.ts suppresses a suggestion whose idea hasn't been touched since this
 * timestamp, so a "Not now" holds until the idea genuinely moves -- matching the Mac app's snooze.
 */
export async function getResumeSnooze(): Promise<Record<string, string>> {
  const result = await chrome.storage.local.get("resumeSnooze");
  return (result.resumeSnooze as Record<string, string> | undefined) ?? {};
}

export async function setResumeSnooze(ideaId: string, whenIso: string = new Date().toISOString()): Promise<void> {
  const next = { ...(await getResumeSnooze()), [ideaId]: whenIso };
  await chrome.storage.local.set({ resumeSnooze: next });
}

/**
 * How many times each idea's nudge has been shown, and the activity timestamp it was showing
 * against, as `{ ideaId: { count, sinceActivity } }`. Drives nudge fatigue in lib/resume.ts:
 * offered a few times without a resume and the idea stops being suggested. Mirrors the Mac app's
 * `thread.resumeShown`.
 */
export async function getResumeShown(): Promise<Record<string, { count: number; sinceActivity: string }>> {
  const result = await chrome.storage.local.get("resumeShown");
  return (result.resumeShown as Record<string, { count: number; sinceActivity: string }> | undefined) ?? {};
}

/** Record that the nudge was shown for `ideaId`. Resets the counter when the idea has moved
 *  (its last activity is newer than what a prior show was recorded against). */
export async function noteResumeShown(ideaId: string, lastActivityIso: string): Promise<void> {
  const all = await getResumeShown();
  const prev = all[ideaId];
  const moved = !prev || Date.parse(lastActivityIso) > Date.parse(prev.sinceActivity);
  const next = { ...all, [ideaId]: { count: moved ? 1 : prev.count + 1, sinceActivity: lastActivityIso } };
  await chrome.storage.local.set({ resumeShown: next });
}
