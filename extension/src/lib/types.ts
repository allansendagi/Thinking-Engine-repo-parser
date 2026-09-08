export interface CapturedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export type Source = "chatgpt" | "claude" | "gemini" | "perplexity";

/** Message shape sent from a content script to the background worker. */
export interface CaptureMessage {
  type: "thread:capture";
  source: Source;
  conversationId: string;
  /** Canonical URL of the conversation (origin + path), or null when it can't be determined. */
  sourceUrl: string | null;
  messages: CapturedMessage[];
}

/** A capture pass's outcome, content script -> background, so health is known even when nothing
 *  new was sent (that's the case that hides a broken adapter). */
export interface HealthMessage {
  type: "thread:health";
  report: CaptureReport;
}

export interface Credentials {
  userId: string;
  token: string;
}

export interface Settings {
  apiBaseUrl: string;
  credentials: Credentials | null;
}

/**
 * How the extension currently stands with respect to an account. The Mac app is the account
 * authority (it creates and owns the Thread account); the extension only ever *adopts*
 * credentials from it -- never mints its own -- so capture and the app's recovery UI read and
 * write the same per-user store. See background.ts.
 */
export type PairingStatus =
  | "paired" // have credentials, last request was accepted
  | "unpaired" // no credentials yet -- waiting to adopt them from the Mac app
  | "rejected"; // had credentials, the backend returned 401 -- they're stale, re-pair needed

export interface PairingState {
  status: PairingStatus;
  userId: string | null;
  /** ISO timestamp of the last handshake attempt, successful or not. */
  lastAttemptAt: string | null;
  /** Human-readable reason for the current status, shown in the popup. */
  detail: string | null;
}

/** The account this browser is capturing into -- shown in the popup so a user can tell they're
 *  on the right one (the sign-out mess was invisible partly because nothing named the account). */
export interface AccountInfo {
  userId: string;
  email: string | null;
  plan: string;
  isPro: boolean;
  ideaCount: number;
  /** When we last fetched this (ISO). Stale is fine to show; it's identity, not live state. */
  fetchedAt: string;
}

/** One capture pass's outcome, reported by a content script to the background worker. */
export interface CaptureReport {
  source: Source;
  /** On a real conversation URL right now (vs. the new-chat landing screen). */
  onConversation: boolean;
  /** The site's conversation surface is in the DOM -- so `extracted: 0` means extraction broke,
   *  not "the page is still loading". */
  containerPresent: boolean;
  /** Messages the adapter returned this pass. */
  extracted: number;
  /** New messages actually sent to the backend this pass. */
  sent: number;
  /** ISO timestamp of this pass. */
  at: string;
  /** Failure detail, if the pass threw. */
  error?: string | null;
}

export type SourceHealthState =
  | "ok" // captured, or nothing new but extraction is working
  | "idle" // no conversation open on this source
  | "degraded" // conversation page is up but the adapter extracts nothing -- selectors likely drifted
  | "error"; // a capture pass threw (network, auth, backend)

export interface SourceHealth {
  source: Source;
  state: SourceHealthState;
  /** Last time a capture actually sent something (ISO), or null. */
  lastCaptureAt: string | null;
  /** Last report of any kind (ISO). */
  lastSeenAt: string | null;
  lastError: string | null;
  /** Consecutive "page up, extracted nothing" passes -- drives the `degraded` verdict. */
  emptyStreak: number;
  /** One human line for the popup. */
  detail: string;
}

export type CaptureHealth = Partial<Record<Source, SourceHealth>>;

/** Everything the popup needs in one round-trip. */
export interface ExtensionStatus {
  pairing: PairingState;
  account: AccountInfo | null;
  health: CaptureHealth;
  /** How many conversations are waiting on a retry (a transient ingest failure). */
  queued: number;
}

/** A capture that failed to reach the backend for a transient reason (offline, 5xx). The
 *  background worker owns retrying it from `chrome.storage.local`, so it survives the service
 *  worker being killed. One entry per conversation -- the newest full transcript wins. */
export interface QueuedCapture {
  conversationId: string;
  source: Source;
  sourceUrl: string | null;
  messages: CapturedMessage[];
  queuedAt: string;
  attempts: number;
}
