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
  /**
   * Is the site's conversation surface actually rendered? Lets capture health tell "the page is
   * still loading" (container absent, `extractMessages` empty -> stay quiet) from "the page is up
   * but extraction found nothing" (container present, empty -> the selectors have drifted, say
   * so). Optional: without it, health falls back to "is there a <main>".
   */
  conversationContainerPresent?(root: ParentNode): boolean;
  /**
   * Put `text` into this tool's message composer -- caret at the end, NOT submitted. Returns
   * false when the composer element can't be found (selectors drifted, or this isn't a chat
   * surface). Optional: an adapter without it just can't offer "continue here", only the
   * hand-off-to-the-Mac-app fallback.
   */
  insertIntoComposer?(text: string, root?: ParentNode): boolean;
}
