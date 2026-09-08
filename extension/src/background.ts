import {
  CAPTURE_MAX_ATTEMPTS,
  clearCredentials,
  enqueueCapture,
  getAccountInfo,
  getCaptureHealth,
  getCaptureQueue,
  getPairingState,
  getResumeShown,
  getResumeSnooze,
  getSettings,
  noteResumeShown,
  recordCaptureReport,
  setAccountInfo,
  setApiBaseUrl,
  setCaptureQueue,
  setCredentials,
  setPairingState,
  setResumeSnooze,
} from "./lib/storage";
import {
  ApiError,
  continueFromIdea,
  getAccount,
  getThinkingState,
  ingestConversation,
  isPaymentRequired,
  isUnauthorized,
  resolveContinuationText,
  verifyCredentials,
} from "./lib/api";
import { fetchDesktopPairing, PAIRING_PORT } from "./lib/pairing";
import { suggestionFromState, type ResumeSuggestion } from "./lib/resume";
import type { CaptureMessage, ExtensionStatus, HealthMessage, PairingState } from "./lib/types";

/**
 * Identity model: Thread for Mac is the account authority. It creates and owns the account and,
 * while running, serves the credentials on a loopback endpoint. This extension NEVER mints its
 * own account -- it only adopts credentials from the Mac app (auto, via the local handshake) or
 * from a pairing string the user pastes into the popup. That is what keeps browser capture and
 * the app's recovery UI pointed at the same per-user store on the backend.
 */

const RETRY_ALARM = "thread:pair-retry";

/**
 * Reconcile the current pairing status. Returns true when the extension ends up paired.
 *
 * `force` (an explicit "Reconnect" from the popup) re-pulls from the Mac's loopback even when the
 * current credentials still verify -- the only way to move the extension onto a different account,
 * e.g. after Thread for Mac recovered a stranded one. It also lets the Mac register the handshake
 * so its Settings shows "Browser connected". Automatic triggers keep the verify-first shortcut so
 * a working extension is never disturbed.
 */
async function ensurePaired(trigger: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { credentials } = await getSettings();

  if (opts.force) {
    const forced = await fetchDesktopPairing().catch(() => null);
    if (forced) {
      await setApiBaseUrl(forced.apiBaseUrl);
      await setCredentials(forced.credentials);
      await markPaired(forced.credentials.userId, `Reconnected to Thread for Mac (${trigger}).`);
      return true;
    }
    // Mac not reachable / pairing window closed -- fall through and keep whatever works.
  }

  if (credentials) {
    try {
      await verifyCredentials();
      // Verified -- but if Thread for Mac is up with a pairing window open AND now serving a
      // DIFFERENT account (the user switched accounts on the Mac), follow it. Without this the
      // extension stays on the old account until that token is actually revoked. Cheap: the
      // loopback 404s in the common case (no window open) with a 1.5s timeout.
      const peek = await fetchDesktopPairing().catch(() => null);
      if (peek && peek.credentials.userId !== credentials.userId) {
        await setApiBaseUrl(peek.apiBaseUrl);
        await setCredentials(peek.credentials);
        await setAccountInfo(null);
        await markPaired(peek.credentials.userId, `Followed Thread for Mac to a different account (${trigger}).`);
        return true;
      }
      await markPaired(credentials.userId, `Verified (${trigger}).`);
      return true;
    } catch (err) {
      if (!isUnauthorized(err)) {
        // Network blip, backend down -- keep the credentials, stay optimistic.
        await setPairingState({ lastAttemptAt: nowIso, detail: "Backend unreachable; will retry." });
        return true;
      }
      await clearCredentials();
      await setAccountInfo(null);
      await setPairingState({ status: "rejected", detail: "Saved credentials were rejected. Re-pairing…" });
    }
  }

  const desktop = await fetchDesktopPairing().catch((err) => {
    console.warn("[Thread] desktop pairing endpoint answered oddly:", err);
    return null;
  });

  if (desktop) {
    await setApiBaseUrl(desktop.apiBaseUrl);
    await setCredentials(desktop.credentials);
    await markPaired(desktop.credentials.userId, `Connected to Thread for Mac (${trigger}).`);
    return true;
  }

  const prior = await getPairingState();
  await setPairingState({
    status: prior.status === "rejected" ? "rejected" : "unpaired",
    userId: null,
    lastAttemptAt: nowIso,
    detail:
      prior.status === "rejected"
        ? "Credentials expired. Open Thread for Mac to reconnect."
        : "Open Thread for Mac to connect this browser.",
  });
  await setBadge(true);
  return false;
}

async function markPaired(userId: string, detail: string): Promise<PairingState> {
  await setBadge(false);
  void pingDesktop(userId);
  void refreshAccountInfo(userId);
  return setPairingState({ status: "paired", userId, lastAttemptAt: new Date().toISOString(), detail });
}

/**
 * Pull the account this browser is now capturing as -- id, email, plan -- so the popup can name
 * it. Best-effort: cleared if the id no longer matches, left stale on a network blip.
 */
async function refreshAccountInfo(userId: string): Promise<void> {
  try {
    const a = await getAccount();
    if (a.userId !== userId) {
      await setAccountInfo(null);
      return;
    }
    await setAccountInfo({
      userId: a.userId,
      email: a.email ?? null,
      plan: a.plan,
      isPro: a.isPro,
      ideaCount: a.ideaCount,
      fetchedAt: new Date().toISOString(),
    });
  } catch {
    // keep whatever's cached
  }
}

/**
 * Tell Thread for Mac "this browser is connected as <userId>". The Mac shows "Browser connected"
 * off this ping -- it's the only way it learns about a pairing that happened via a pasted code
 * (which never hits the loopback). Best-effort: the app isn't always running. `PAIRING_PORT` /
 * host permission for 127.0.0.1 are already in the manifest.
 */
async function pingDesktop(userId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${PAIRING_PORT}/thread/hello?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
      cache: "no-store",
    });
  } catch {
    // Mac app not running / not listening -- nothing to do.
  }
}

async function setBadge(needsAttention: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: needsAttention ? "!" : "" });
  if (needsAttention) await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

/**
 * Reloading/updating the extension leaves the content script dead in every AI tab that was
 * already open ("Extension context invalidated" -- see capture.ts, which tears itself down).
 * Re-inject the fresh content script into those tabs so capture resumes without the user
 * reloading each one by hand. `bootstrapContentScript` is idempotent, so a tab that reloaded on
 * its own in the meantime is unharmed.
 */
const CONTENT_SCRIPT_TARGETS: { matches: string[]; file: string }[] = [
  { matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"], file: "dist/content-chatgpt.js" },
  { matches: ["https://claude.ai/*"], file: "dist/content-claude.js" },
  { matches: ["https://gemini.google.com/*"], file: "dist/content-gemini.js" },
];

async function reinjectOpenTabs(): Promise<void> {
  for (const { matches, file } of CONTENT_SCRIPT_TARGETS) {
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({ url: matches });
    } catch {
      continue;
    }
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
      } catch {
        // Tab navigated away / a restricted page / no host permission on that exact URL -- skip.
      }
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void ensurePaired("install");
  if (details.reason === "install" || details.reason === "update") void reinjectOpenTabs();
});
chrome.runtime.onStartup.addListener(() => void ensurePaired("startup"));

// On every service-worker start (including a manual reload), tell the Mac right away if we're
// already paired -- so "Browser connected" appears without waiting for the 1-minute alarm.
void (async () => {
  const { userId, status } = await getPairingState();
  if (status === "paired" && userId) void pingDesktop(userId);
})();

chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  const state = await getPairingState();
  if (state.status !== "paired") {
    await ensurePaired("retry");
  } else if (state.userId) {
    // Paired already -- keep the Mac's "Browser connected" indicator fresh (covers a pairing
    // done by pasted code, and a Mac app that started after the extension).
    void pingDesktop(state.userId);
  }
  await drainQueue(); // retry any captures parked by a transient failure
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isPairNowMessage(message)) {
    // The popup button is an explicit user act -- force a fresh pull from the Mac.
    ensurePaired("popup", { force: true })
      .then(() => getPairingState())
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (isHealthMessage(message)) {
    void recordCaptureReport(message.report);
    return false; // fire-and-forget
  }

  if (isStatusQuery(message)) {
    buildStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (isAnnounceMessage(message)) {
    // Popup pasted a pairing string -- tell the Mac right away so it shows "Browser connected".
    getSettings()
      .then(({ credentials }) => (credentials ? pingDesktop(credentials.userId) : undefined))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (isCaptureMessage(message)) {
    handleCapture(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async sendResponse
  }

  if (isResumeCheckMessage(message)) {
    resumeSuggestion()
      .then((suggestion) => sendResponse({ ok: true, suggestion }))
      .catch((err) => sendResponse({ ok: false, error: String(err), suggestion: null }));
    return true;
  }

  if (isResumeDismissMessage(message)) {
    setResumeSnooze(message.ideaId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (isContinuePacketMessage(message)) {
    continuePacket(message.ideaId)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

/**
 * The continuation packet text for one idea -- the compact cognitive checkpoint the content
 * script drops into the AI tool's composer. Not Pro-gated. Throws (surfaced to the card) on a
 * missing pairing or an API error so the card can fall back to the Mac-app hand-off.
 */
async function continuePacket(ideaId: string): Promise<string> {
  const { credentials } = await getSettings();
  if (!credentials) throw new Error("Not paired -- open Thread for Mac.");
  const res = await continueFromIdea(ideaId);
  // Bake every model-written slot in so what lands in the composer is ready to send, not a
  // template with `{{...}}` tokens in it.
  return resolveContinuationText(res);
}

/**
 * The one qualifying "you may be returning to this" idea, or null. Computed from Thinking State
 * with the exact rule the Mac app uses (lib/resume.ts). Silent about pairing/network problems --
 * a return nudge is a nicety; if we can't answer, we just don't show one.
 */
async function resumeSuggestion(): Promise<ResumeSuggestion | null> {
  const { credentials } = await getSettings();
  if (!credentials) return null;
  try {
    const [state, snoozed, history] = await Promise.all([
      getThinkingState(),
      getResumeSnooze(),
      getResumeShown(),
    ]);
    const suggestion = suggestionFromState(state, snoozed, history);
    if (suggestion) {
      // Record the show so nudge fatigue can decay it — mirrors the Mac app's noteResumeShown.
      const lastActivity = state.recentChanges
        .filter((c) => c.ideaId === suggestion.ideaId)
        .map((c) => c.createdAt)
        .sort()
        .at(-1);
      if (lastActivity) void noteResumeShown(suggestion.ideaId, lastActivity);
    }
    return suggestion;
  } catch {
    return null;
  }
}

/** One round-trip for the popup: pairing, which account, per-source capture health, queue depth. */
async function buildStatus(): Promise<ExtensionStatus> {
  const [pairing, account, health, queue] = await Promise.all([
    getPairingState(),
    getAccountInfo(),
    getCaptureHealth(),
    getCaptureQueue(),
  ]);
  // Opportunistically refresh the account name if we're paired and it's missing/stale (>1h).
  if (pairing.status === "paired" && pairing.userId) {
    const stale = !account || Date.now() - Date.parse(account.fetchedAt) > 60 * 60 * 1000;
    if (stale) void refreshAccountInfo(pairing.userId);
  }
  // Opening the popup is a good moment to drain -- the user's here, likely online.
  if (queue.length > 0) void drainQueue();
  return { pairing, account, health, queued: queue.length };
}

type Capture = Pick<CaptureMessage, "conversationId" | "source" | "sourceUrl" | "messages">;
type SendOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "unauthorized" } // creds gone -- re-pair, then a fresh mutation retries
  | { kind: "capped" } // 402 -- account is fine, just at the Free cap; don't retry
  | { kind: "transient"; error: string }; // offline / 5xx -- worth queueing

/** One ingest attempt. Refreshes "Capturing." on success; classifies the failure so the caller
 *  can decide between queue / re-pair / give up. Does NOT itself queue or clear credentials. */
async function sendCapture(c: Capture): Promise<SendOutcome> {
  try {
    const result = await ingestConversation(c.conversationId, c.source, c.messages, c.sourceUrl);
    const { credentials } = await getSettings();
    if (credentials) await markPaired(credentials.userId, "Capturing.");
    return { kind: "ok", result };
  } catch (err) {
    if (isUnauthorized(err)) return { kind: "unauthorized" };
    if (isPaymentRequired(err)) return { kind: "capped" };
    return { kind: "transient", error: err instanceof ApiError ? `${err.status} ${err.message}` : String(err) };
  }
}

/**
 * Retry every queued conversation once. Stops the whole pass on `unauthorized` (nothing will
 * work until re-paired) and on `capped` (hammering a Free-cap account is pointless). A `transient`
 * failure bumps `attempts` and is dropped past `CAPTURE_MAX_ATTEMPTS`. Called from the retry
 * alarm and after any successful live capture.
 */
async function drainQueue(): Promise<void> {
  const queue = await getCaptureQueue();
  if (queue.length === 0) return;
  const { credentials } = await getSettings();
  if (!credentials) return;

  const keep: typeof queue = [];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i]!;
    const outcome = await sendCapture(entry);
    if (outcome.kind === "ok") continue; // done -- drop it
    if (outcome.kind === "unauthorized" || outcome.kind === "capped") {
      keep.push(...queue.slice(i)); // stop the pass; leave this and the rest for next time
      break;
    }
    if (entry.attempts + 1 < CAPTURE_MAX_ATTEMPTS) keep.push({ ...entry, attempts: entry.attempts + 1 });
    // else: give it up -- it isn't transient any more
  }
  await setCaptureQueue(keep);
  await setBadge(keep.length > 0 || (await getPairingState()).status !== "paired");
}

async function handleCapture(
  message: CaptureMessage,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; queued?: boolean; retry?: boolean }> {
  const { credentials } = await getSettings();
  if (!credentials) {
    const paired = await ensurePaired("capture");
    if (!paired) return { ok: false, error: "Not paired -- open Thread for Mac.", retry: true };
  }

  const outcome = await sendCapture(message);
  if (outcome.kind === "ok") {
    console.log(`[Thread] ingested ${message.conversationId}`);
    void drainQueue(); // a working connection is a good moment to flush anything parked
    return { ok: true, result: outcome.result };
  }
  if (outcome.kind === "unauthorized") {
    await clearCredentials();
    await setAccountInfo(null);
    await setPairingState({ status: "rejected", detail: "Credentials rejected mid-capture. Re-pairing…" });
    const repaired = await ensurePaired("capture-401");
    if (repaired) {
      const retry = await sendCapture(message);
      if (retry.kind === "ok") return { ok: true, result: retry.result };
    }
    return { ok: false, error: "Credentials expired -- reconnect Thread for Mac.", retry: true };
  }
  if (outcome.kind === "capped") {
    await setPairingState({
      status: "paired",
      detail: "Free plan limit reached. Upgrade to Pro from your Thread account to keep capturing.",
    });
    await setBadge(true);
    return { ok: false, error: "Free plan limit reached -- upgrade to Pro from your Thread account." };
  }
  // transient -- park the full transcript so it survives the worker being killed and retries later
  console.error(`[Thread] ingest failed for ${message.conversationId}, queued for retry:`, outcome.error);
  await enqueueCapture(message);
  await setBadge(true);
  return { ok: false, error: outcome.error, queued: true };
}

function isCaptureMessage(message: unknown): message is CaptureMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:capture";
}

function isPairNowMessage(message: unknown): message is { type: "thread:pair-now" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:pair-now";
}

function isHealthMessage(message: unknown): message is HealthMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:health";
}

function isStatusQuery(message: unknown): message is { type: "thread:status" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:status";
}

function isAnnounceMessage(message: unknown): message is { type: "thread:announce" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:announce";
}

function isResumeCheckMessage(message: unknown): message is { type: "thread:resume-check" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:resume-check";
}

function isResumeDismissMessage(message: unknown): message is { type: "thread:resume-dismiss"; ideaId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thread:resume-dismiss" &&
    typeof (message as { ideaId?: unknown }).ideaId === "string"
  );
}

function isContinuePacketMessage(message: unknown): message is { type: "thread:continue-packet"; ideaId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thread:continue-packet" &&
    typeof (message as { ideaId?: unknown }).ideaId === "string"
  );
}
