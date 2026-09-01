import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { claudeAdapter } from "./claude";

describe("claudeAdapter", () => {
  test("extracts conversation id from the URL", () => {
    setupDom("https://claude.ai/chat/xyz-789", "<main></main>");
    expect(claudeAdapter.getConversationId()).toBe("xyz-789");
  });

  test("extracts and orders turns by DOM position, not selector-group order", () => {
    // Assistant markup appears first in source, but user's turn is visually/logically first --
    // extraction must sort by actual document position, not by which selector matched it.
    const window = setupDom(
      "https://claude.ai/chat/xyz-789",
      `
      <main>
        <div data-testid="user-message" id="u1">First user message</div>
        <div data-testid="assistant-message" id="a1">First reply</div>
        <div data-testid="user-message" id="u2">Second user message</div>
      </main>
      `,
    );
    const messages = claudeAdapter.extractMessages(window.document as unknown as ParentNode);
    expect(messages).toEqual([
      { role: "user", text: "First user message" },
      { role: "assistant", text: "First reply" },
      { role: "user", text: "Second user message" },
    ]);
  });

  test("falls back to the secondary selector set if the primary one matches nothing", () => {
    const window = setupDom(
      "https://claude.ai/chat/xyz-789",
      `<main><div data-testid="human-turn">Fallback user turn</div></main>`,
    );
    const messages = claudeAdapter.extractMessages(window.document as unknown as ParentNode);
    expect(messages).toEqual([{ role: "user", text: "Fallback user turn" }]);
  });

  test("returns an empty array when nothing matches any known selector", () => {
    const window = setupDom("https://claude.ai/chat/xyz-789", "<main><div>unrelated content</div></main>");
    expect(claudeAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([]);
  });
});
