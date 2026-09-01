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

  test("ignores the provisional WEB: id a new chat briefly gets before its real UUID", () => {
    setupDom("https://chatgpt.com/c/WEB:e53ad3fb-c398-4d27-bce1-066d08a84aa8", "<main></main>");
    expect(chatGptAdapter.getConversationId()).toBeNull();
  });

  test("reads the real id once the URL settles, ignoring query/hash", () => {
    setupDom("https://chatgpt.com/c/6a971195-9a84-83eb-9f5f-348310970f3a?foo=1", "<main></main>");
    expect(chatGptAdapter.getConversationId()).toBe("6a971195-9a84-83eb-9f5f-348310970f3a");
  });

  test("strips ChatGPT's screen-reader turn labels from captured text", () => {
    const window = setupDom(
      "https://chatgpt.com/c/abc-123",
      `<main>
        <div data-message-author-role="user">You said:tell me everything</div>
        <div data-message-author-role="assistant">ChatGPT said:Here is everything</div>
      </main>`,
    );
    expect(chatGptAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([
      { role: "user", text: "tell me everything" },
      { role: "assistant", text: "Here is everything" },
    ]);
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
