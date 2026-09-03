import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText } from "../common/domUtils";

/**
 * Verified against a real live chatgpt.com conversation (2026-09-01): `data-message-author-role`
 * is present and correctly valued ("user" | "assistant" | "system" | "tool"). ChatGPT also
 * exposes a parallel `data-turn` attribute with the same "user" | "assistant" values on the same
 * turns -- kept here as a fallback strategy (tried only if the primary attribute finds nothing),
 * same multi-selector-fallback pattern as the Claude adapter, so a future rename of one attribute
 * doesn't immediately break capture. See extension/README.md.
 */
const ROLE_ATTRS = ["data-message-author-role", "data-turn"];

function collect(root: ParentNode): HTMLElement[] {
  for (const attr of ROLE_ATTRS) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`));
    if (found.length > 0) return found;
  }
  return [];
}

export const chatGptAdapter: SiteAdapter = {
  source: "chatgpt",

  getConversationId(): string | null {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]!);
    // A brand-new chat's URL is briefly `/c/WEB:<uuid>` (a client-side provisional id) before
    // ChatGPT rewrites it to the permanent `/c/<uuid>` a few seconds later. Capturing during
    // that window files the first turn under a junk id ("WEB") that every new chat then collides
    // into. Skip provisional ids entirely -- the real capture still happens once the URL settles.
    if (id.includes(":")) return null;
    return id;
  },

  getConversationUrl(): string | null {
    // Only once getConversationId settles (permanent id, no provisional `WEB:` prefix).
    return this.getConversationId() ? location.origin + location.pathname : null;
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const nodes = collect(root);
    const messages: RawMessage[] = [];

    for (const node of nodes) {
      const role = node.getAttribute("data-message-author-role") ?? node.getAttribute("data-turn");
      if (role !== "user" && role !== "assistant") continue;
      // ChatGPT prefixes each turn's accessible text with a screen-reader label ("You said:",
      // "ChatGPT said:"). Strip it so the captured text is just what was actually said.
      const text = cleanText(node.textContent).replace(/^(You said:|ChatGPT said:)\s*/i, "");
      if (text.length === 0) continue;
      messages.push({ role, text });
    }

    if (messages.length === 0 && document.querySelector("main")) {
      console.warn(
        "[Thread] chatgpt adapter found a conversation page but zero messages -- selectors likely need updating",
      );
    }

    return messages;
  },
};
