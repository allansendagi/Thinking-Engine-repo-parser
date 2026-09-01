import type { Source } from "../../lib/types";

export interface RawMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SiteAdapter {
  source: Source;
  /** Null when not currently on a conversation page (e.g. the new-chat landing screen). */
  getConversationId(): string | null;
  /** All currently-rendered messages, in conversation order. Empty array if none found. */
  extractMessages(root: ParentNode): RawMessage[];
}
