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

  test("uses the live selectors and strips the thinking pill + a11y label prefixes", () => {
    const window = setupDom(
      "https://claude.ai/chat/xyz-789",
      `<main>
        <div data-testid="user-message">You said: Why do agents need a policy?</div>
        <div class="font-claude-response">Thought for 3sThought for 3sBecause they act autonomously.</div>
      </main>`,
    );
    expect(claudeAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([
      { role: "user", text: "Why do agents need a policy?" },
      { role: "assistant", text: "Because they act autonomously." },
    ]);
  });

  test("insertIntoComposer writes into the ProseMirror composer", () => {
    const window = setupDom(
      "https://claude.ai/",
      `<div contenteditable="true" class="ProseMirror"></div>`,
    );
    const ok = claudeAdapter.insertIntoComposer!(
      "Where you left off: authority must be independently verifiable",
      window.document as unknown as ParentNode,
    );
    expect(ok).toBe(true);
    expect(window.document.querySelector(".ProseMirror")!.textContent).toContain("independently verifiable");
  });

  test("insertIntoComposer returns false with no composer present", () => {
    const window = setupDom("https://claude.ai/", "<main></main>");
    expect(claudeAdapter.insertIntoComposer!("x", window.document as unknown as ParentNode)).toBe(false);
  });
});
