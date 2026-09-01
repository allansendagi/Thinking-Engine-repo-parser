import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

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
    return matchFirst(location.pathname, [/\/c\/([a-zA-Z0-9-]+)/]);
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const nodes = collect(root);
    const messages: RawMessage[] = [];

    for (const node of nodes) {
      const role = node.getAttribute("data-message-author-role") ?? node.getAttribute("data-turn");
      if (role !== "user" && role !== "assistant") continue;
      const text = cleanText(node.textContent);
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
