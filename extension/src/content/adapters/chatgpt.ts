import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

/**
 * UNVERIFIED against the live site -- built from general knowledge of ChatGPT's DOM structure,
 * not a live inspection. ChatGPT has historically rendered each turn with a
 * `data-message-author-role` attribute (values "user" | "assistant" | "system" | "tool"), which
 * is the primary strategy here. If that stops matching, this needs to be updated against the
 * real, current page -- see extension/README.md.
 */
export const chatGptAdapter: SiteAdapter = {
  source: "chatgpt",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/\/c\/([a-zA-Z0-9-]+)/]);
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const nodes = root.querySelectorAll<HTMLElement>("[data-message-author-role]");
    const messages: RawMessage[] = [];

    for (const node of nodes) {
      const role = node.getAttribute("data-message-author-role");
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
