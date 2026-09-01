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
