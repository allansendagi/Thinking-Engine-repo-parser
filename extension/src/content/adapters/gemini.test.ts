import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { geminiAdapter } from "./gemini";

describe("geminiAdapter", () => {
  test("extracts conversation id from the URL", () => {
    setupDom("https://gemini.google.com/app/conv-456", "<main></main>");
    expect(geminiAdapter.getConversationId()).toBe("conv-456");
  });

  test("extracts turns from user-query / model-response custom elements in DOM order", () => {
    const window = setupDom(
      "https://gemini.google.com/app/conv-456",
      `
      <main>
        <user-query>What's the weather like?</user-query>
        <model-response>I don't have real-time access to weather data.</model-response>
      </main>
      `,
    );
    const messages = geminiAdapter.extractMessages(window.document as unknown as ParentNode);
    expect(messages).toEqual([
      { role: "user", text: "What's the weather like?" },
      { role: "assistant", text: "I don't have real-time access to weather data." },
    ]);
  });

  test("returns an empty array when the custom elements aren't present", () => {
    const window = setupDom("https://gemini.google.com/app/conv-456", "<main><div>obfuscated angular markup</div></main>");
    expect(geminiAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([]);
  });

  test("prefers *-content elements, strips labels, and collapses the duplicated prompt text", () => {
    const window = setupDom(
      "https://gemini.google.com/app/conv-456",
      `<main>
        <user-query><user-query-content>You said what is a continuity layer? what is a continuity layer?</user-query-content></user-query>
        <model-response><message-content>A persistent representation of your evolving ideas.</message-content></model-response>
      </main>`,
    );
    expect(geminiAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([
      { role: "user", text: "what is a continuity layer?" },
      { role: "assistant", text: "A persistent representation of your evolving ideas." },
    ]);
  });
});
