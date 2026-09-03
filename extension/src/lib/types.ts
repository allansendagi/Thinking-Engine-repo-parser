export interface CapturedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export type Source = "chatgpt" | "claude" | "gemini";

/** Message shape sent from a content script to the background worker. */
export interface CaptureMessage {
  type: "thread:capture";
  source: Source;
  conversationId: string;
  /** Canonical URL of the conversation (origin + path), or null when it can't be determined. */
  sourceUrl: string | null;
  messages: CapturedMessage[];
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
