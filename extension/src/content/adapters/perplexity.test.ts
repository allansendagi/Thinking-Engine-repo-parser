import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { perplexityAdapter } from "./perplexity";

describe("perplexityAdapter", () => {
  test("extracts the conversation id from a /search/ URL", () => {
    setupDom("https://www.perplexity.ai/search/what-is-a-continuity-la-abc123", "<main></main>");
    expect(perplexityAdapter.getConversationId()).toBe("what-is-a-continuity-la-abc123");
  });

  test("no id on the home page", () => {
    setupDom("https://www.perplexity.ai/", "<main></main>");
    expect(perplexityAdapter.getConversationId()).toBeNull();
  });

  test("collects query + answer blocks in DOM order", () => {
    const window = setupDom(
      "https://www.perplexity.ai/search/x-abc123",
      `<main>
        <div><div data-testid="query-text">what is computable authority?</div></div>
        <div><div data-testid="answer-text">Authority made machine-executable and independently verifiable.</div></div>
        <textarea placeholder="Ask a follow-up"></textarea>
      </main>`,
    );
    expect(perplexityAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([
      { role: "user", text: "what is computable authority?" },
      { role: "assistant", text: "Authority made machine-executable and independently verifiable." },
    ]);
  });

  test("empty array when the block selectors match nothing", () => {
    const window = setupDom("https://www.perplexity.ai/search/x-abc123", "<main><div>opaque markup</div></main>");
    expect(perplexityAdapter.extractMessages(window.document as unknown as ParentNode)).toEqual([]);
  });

  test("conversationContainerPresent needs both a main and a composer", () => {
    const withComposer = setupDom(
      "https://www.perplexity.ai/search/x-abc123",
      `<main><textarea placeholder="Ask a follow-up"></textarea></main>`,
    );
    expect(perplexityAdapter.conversationContainerPresent!(withComposer.document as unknown as ParentNode)).toBe(true);

    const bare = setupDom("https://www.perplexity.ai/search/x-abc123", "<main></main>");
    expect(perplexityAdapter.conversationContainerPresent!(bare.document as unknown as ParentNode)).toBe(false);
  });

  test("insertIntoComposer writes into the follow-up textarea", () => {
    const window = setupDom(
      "https://www.perplexity.ai/search/x-abc123",
      `<main><textarea placeholder="Ask a follow-up"></textarea></main>`,
    );
    const ok = perplexityAdapter.insertIntoComposer!("continue from the verifier question", window.document as unknown as ParentNode);
    expect(ok).toBe(true);
    const ta = window.document.querySelector("textarea") as unknown as { value: string };
    expect(ta.value).toContain("verifier question");
  });
});
