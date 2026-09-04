import {
  clearCredentials,
  getPairingState,
  getResumeShown,
  getResumeSnooze,
  getSettings,
  noteResumeShown,
  setApiBaseUrl,
  setCredentials,
  setPairingState,
  setResumeSnooze,
} from "./lib/storage";
import { ApiError, getThinkingState, ingestConversation, isPaymentRequired, isUnauthorized, verifyCredentials } from "./lib/api";
import { fetchDesktopPairing, PAIRING_PORT } from "./lib/pairing";
import { suggestionFromState, type ResumeSuggestion } from "./lib/resume";
import type { CaptureMessage, PairingState } from "./lib/types";

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
      await markPaired(credentials.userId, `Verified (${trigger}).`);
      return true;
    } catch (err) {
      if (!isUnauthorized(err)) {
        // Network blip, backend down -- keep the credentials, stay optimistic.
        await setPairingState({ lastAttemptAt: nowIso, detail: "Backend unreachable; will retry." });
        return true;
      }
      await clearCredentials();
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
  return setPairingState({ status: "paired", userId, lastAttemptAt: new Date().toISOString(), detail });
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

  return false;
});

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

async function handleCapture(
  message: CaptureMessage,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const { credentials } = await getSettings();
  if (!credentials) {
    const paired = await ensurePaired("capture");
    if (!paired) return { ok: false, error: "Not paired -- open Thread for Mac." };
  }

  try {
    const result = await ingestConversation(message.conversationId, message.source, message.messages, message.sourceUrl);
    console.log(`[Thread] ingested ${message.conversationId}:`, result);
    await markPaired((await getSettings()).credentials!.userId, "Capturing.");
    return { ok: true, result };
  } catch (err) {
    if (isUnauthorized(err)) {
      await clearCredentials();
      await setPairingState({ status: "rejected", detail: "Credentials rejected mid-capture. Re-pairing…" });
      const repaired = await ensurePaired("capture-401");
      if (repaired) {
        const result = await ingestConversation(message.conversationId, message.source, message.messages, message.sourceUrl);
        return { ok: true, result };
      }
      return { ok: false, error: "Credentials expired -- reconnect Thread for Mac." };
    }
    if (isPaymentRequired(err)) {
      // Account is fine, just at the Free plan's idea cap -- keep credentials, surface it, stop hammering.
      await setPairingState({
        status: "paired",
        detail: "Free plan limit reached. Upgrade to Pro from your Thread account to keep capturing.",
      });
      await setBadge(true);
      return { ok: false, error: "Free plan limit reached -- upgrade to Pro from your Thread account." };
    }
    const detail = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
    console.error(`[Thread] ingest failed for ${message.conversationId}:`, detail);
    return { ok: false, error: detail };
  }
}

function isCaptureMessage(message: unknown): message is CaptureMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:capture";
}

function isPairNowMessage(message: unknown): message is { type: "thread:pair-now" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "thread:pair-now";
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
