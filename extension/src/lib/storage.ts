import type { Credentials, PairingState, Settings } from "./types";

const DEFAULT_API_BASE_URL = "https://thinking-engine-repo-parser-production.up.railway.app";

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
