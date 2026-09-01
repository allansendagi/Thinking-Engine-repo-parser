import { getSettings, setCredentials } from "./lib/storage";
import { createUser, ingestConversation, ApiError } from "./lib/api";
import type { CaptureMessage } from "./lib/types";

/**
 * On first install, pair automatically by creating a fresh account against the configured API --
 * no manual login flow needed to get started. A user who already has an account (e.g. from
 * another browser) can overwrite these via the popup's "use existing credentials" field.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const { apiBaseUrl, credentials } = await getSettings();
  if (credentials) return;

  try {
    const created = await createUser(apiBaseUrl);
    await setCredentials(created);
    console.log("[Thread] paired with a new account:", created.userId);
  } catch (err) {
    console.error("[Thread] failed to auto-pair on install -- is the API server running?", err);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCaptureMessage(message)) return false;

  ingestConversation(message.conversationId, message.source, message.messages)
    .then((result) => {
      console.log(`[Thread] ingested ${message.conversationId}:`, result);
      sendResponse({ ok: true, result });
    })
    .catch((err) => {
      const detail = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
      console.error(`[Thread] ingest failed for ${message.conversationId}:`, detail);
      sendResponse({ ok: false, error: detail });
    });

  return true; // keep the message channel open for the async sendResponse above
});

function isCaptureMessage(message: unknown): message is CaptureMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "thread:capture"
  );
}
