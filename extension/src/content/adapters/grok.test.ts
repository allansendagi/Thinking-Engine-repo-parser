import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { grokAdapter } from "./grok";

/** The shape read from the live grok.com page: label + timing in the bubble, text in the markdown body. */
const conversation = `
  <div data-testid="chat-transcript-scroller">
    <div id="response-1"><div data-testid="user-message"><div class="message-bubble"><span>You</span>
      <div class="response-content-markdown"><p>Should authority be checked per act?</p></div></div></div></div>
    <div id="response-2"><div data-testid="assistant-message"><div class="message-bubble"><span>Grok</span><span>Worked for 20s</span>
      <div class="response-content-markdown"><p>Yes. Authorize the act, not the agent.</p></div></div></div></div>
    <div id="response-3"><div data-testid="assistant-message"><div class="message-bubble"><span>Grok</span></div></div></div>
  </div>
  <div data-testid="chat-input"><div contenteditable="true" role="textbox" aria-label="Ask Grok anything"></div></div>`;

describe("grokAdapter", () => {
  test("the conversation id comes from /c/<id>", () => {
    setupDom("https://grok.com/c/66c0b3e3-2488-4f47-b2cb-b6430a41a2e7?rid=abc", "<main></main>");
    expect(grokAdapter.getConversationId()).toBe("66c0b3e3-2488-4f47-b2cb-b6430a41a2e7");
    expect(grokAdapter.getConversationUrl!()).toBe("https://grok.com/c/66c0b3e3-2488-4f47-b2cb-b6430a41a2e7");
  });

  test("no id on the start page", () => {
    setupDom("https://grok.com/", "<main></main>");
    expect(grokAdapter.getConversationId()).toBeNull();
  });

  test("reads each turn's text without the You / Grok labels or the timing, and skips an unrendered turn", () => {
    const w = setupDom("https://grok.com/c/66c0b3e3-2488-4f47-b2cb-b6430a41a2e7", conversation);
    expect(grokAdapter.extractMessages(w.document as unknown as ParentNode)).toEqual([
      { role: "user", text: "Should authority be checked per act?" },
      { role: "assistant", text: "Yes. Authorize the act, not the agent." },
    ]);
  });

  test("recognises a conversation page by its transcript or composer", () => {
    const w = setupDom("https://grok.com/c/x1234567", conversation);
    expect(grokAdapter.conversationContainerPresent!(w.document as unknown as ParentNode)).toBe(true);
    const bare = setupDom("https://grok.com/c/x1234567", "<main></main>");
    expect(grokAdapter.conversationContainerPresent!(bare.document as unknown as ParentNode)).toBe(false);
  });
});
