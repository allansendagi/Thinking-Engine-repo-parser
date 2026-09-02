import type { Source } from "../../lib/types";

export interface RawMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SiteAdapter {
  source: Source;
  /** Null when not currently on a conversation page (e.g. the new-chat landing screen). */
  getConversationId(): string | null;
  /**
   * Canonical URL of the current conversation -- origin + path only, no query or hash -- or null
   * when not on a conversation page. Sent with each capture so a resumed thought can link back to
   * the exact chat it came from. Optional: an adapter without it just yields no source links.
   */
  getConversationUrl?(): string | null;
  /** All currently-rendered messages, in conversation order. Empty array if none found. */
  extractMessages(root: ParentNode): RawMessage[];
}
