import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { chatGptAdapter } from "./chatgpt";

describe("chatGptAdapter", () => {
  test("extracts conversation id from the URL", () => {
    setupDom("https://chatgpt.com/c/abc-123-def", "<main></main>");
    expect(chatGptAdapter.getConversationId()).toBe("abc-123-def");
  });

  test("returns null when not on a conversation page", () => {
    setupDom("https://chatgpt.com/", "<main></main>");
    expect(chatGptAdapter.getConversationId()).toBeNull();
  });

  test("extracts user/assistant turns via data-message-author-role, in DOM order", () => {
    const window = setupDom(
      "https://chatgpt.com/c/abc-123",
      `
      <main>
        <div data-message-author-role="user">Hello there</div>
        <div data-message-author-role="assistant">Hi! How can I help?</div>
        <div data-message-author-role="system">hidden system prompt</div>
        <div data-message-author-role="user">Second question</div>
      </main>
      `,
    );
    const messages = chatGptAdapter.extractMessages(window.document as unknown as ParentNode);
    expect(messages).toEqual([
      { role: "user", text: "Hello there" },
      { role: "assistant", text: "Hi! How can I help?" },
      { role: "user", text: "Second question" },
    ]);
  });

  test("returns an empty array when no messages are found", () => {
    const window = setupDom("https://chatgpt.com/c/abc-123", "<main></main>");
    expect(chatGptAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([]);
  });
});
