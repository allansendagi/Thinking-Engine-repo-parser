import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { startCapture } from "./capture";
import { textHash } from "./domUtils";
import type { SiteAdapter, RawMessage } from "./siteAdapter";
import type { CaptureMessage, CaptureReport, HealthMessage } from "../../lib/types";

type AnyMsg = CaptureMessage | HealthMessage;
const captures = (msgs: AnyMsg[]): CaptureMessage[] =>
  msgs.filter((m): m is CaptureMessage => m.type === "thread:capture");
const reports = (msgs: AnyMsg[]): CaptureReport[] =>
  msgs.filter((m): m is HealthMessage => m.type === "thread:health").map((m) => m.report);
const lastCapture = (msgs: AnyMsg[]): CaptureMessage["messages"] | undefined => captures(msgs).at(-1)?.messages;

/** Minimal in-memory fake of chrome.storage.local -- enough for storage.ts's get/set/remove. */
function installFakeChromeStorage(): void {
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of list) if (store.has(k)) result[k] = store.get(k);
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async (key: string) => {
          store.delete(key);
        },
      },
    },
  };
}

/** MutationObserver isn't a Bun/Node global -- shim it from the happy-dom window being used. */
function installMutationObserver(window: Window): void {
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = window.MutationObserver;
}

function makeAdapter(messagesPerCall: () => RawMessage[]): SiteAdapter {
  return {
    source: "chatgpt",
    getConversationId: () => "conv_1",
    extractMessages: () => messagesPerCall(),
  };
}

/** Nudge the MutationObserver so the next flush re-extracts. */
function poke(window: Window): void {
  window.document.body.appendChild(window.document.createElement("div"));
}

describe("startCapture (debounce + dedup, no real browser or network)", () => {
  beforeEach(() => installFakeChromeStorage());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("sends once after the debounce window; user id positional, assistant id content-derived", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter = makeAdapter(() => [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ]);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      assistantStableMs: 0, // don't hold the trailing assistant turn in this test
      sendMessage: async (m) => void sent.push(m),
      now: () => "2026-08-17T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(1);
    expect(lastCapture(sent)).toEqual([
      { id: "conv_1::0", role: "user", text: "Hello", createdAt: "2026-08-17T00:00:00.000Z" },
      { id: `conv_1::a${textHash("Hi")}`, role: "assistant", text: "Hi", createdAt: "2026-08-17T00:00:00.000Z" },
    ]);
    const r = reports(sent).at(-1);
    expect(r?.onConversation).toBe(true);
    expect(r?.extracted).toBe(2);
    expect(r?.sent).toBe(2);
  });

  test("does not re-send once messages have already been sent and nothing changed", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter = makeAdapter(() => [{ role: "user", text: "Hello" }]);

    const stop1 = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop1();
    expect(captures(sent)).toHaveLength(1);

    const stop2 = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop2();
    expect(captures(sent)).toHaveLength(1); // unchanged
  });

  test("sends again once a genuinely new message appears", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    let messages: RawMessage[] = [{ role: "user", text: "Hello" }];
    const adapter = makeAdapter(() => messages);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      assistantStableMs: 0,
      sendMessage: async (m) => void sent.push(m),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(captures(sent)).toHaveLength(1);

    messages = [...messages, { role: "assistant", text: "Hi there" }];
    poke(window);

    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(2);
    expect(lastCapture(sent)).toHaveLength(2);
  });

  test("a regenerated assistant answer -- same position, different text -- is captured", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    let messages: RawMessage[] = [
      { role: "user", text: "explain X" },
      { role: "assistant", text: "First take on X." },
    ];
    const adapter = makeAdapter(() => messages);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      assistantStableMs: 0,
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastCapture(sent)?.at(-1)?.text).toBe("First take on X.");

    // Regenerate: same slot, new words. A positional id would silently drop this.
    messages = [
      { role: "user", text: "explain X" },
      { role: "assistant", text: "Completely different second take on X." },
    ];
    poke(window);
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent).length).toBeGreaterThanOrEqual(2);
    expect(lastCapture(sent)?.at(-1)?.text).toBe("Completely different second take on X.");
    expect(lastCapture(sent)?.at(-1)?.id).toBe(`conv_1::a${textHash("Completely different second take on X.")}`);
  });

  test("a still-streaming trailing assistant turn is held until its text settles", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    let messages: RawMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "part" },
    ];
    const adapter = makeAdapter(() => messages);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      assistantStableMs: 60,
      sendMessage: async (m) => void sent.push(m),
    });

    // First flush: the assistant tail is fresh/unstable -> only the user turn goes.
    await new Promise((r) => setTimeout(r, 25));
    expect(lastCapture(sent)?.map((m) => m.role)).toEqual(["user"]);

    // Stream grows, then stops.
    messages = [
      { role: "user", text: "go" },
      { role: "assistant", text: "part two done" },
    ];
    poke(window);

    // After it's been byte-stable for assistantStableMs, the finished reply is sent.
    await new Promise((r) => setTimeout(r, 120));
    stop();

    const finalTexts = lastCapture(sent)?.map((m) => m.text);
    expect(finalTexts).toEqual(["go", "part two done"]);
  });

  test("an assistant turn that is no longer last is sent right away (a newer turn proves it's done)", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter = makeAdapter(() => [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
    ]);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      assistantStableMs: 9999, // even with a long hold window...
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();

    // ...the assistant turn isn't the tail, so nothing is held.
    expect(lastCapture(sent)?.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("no capture message when not on a conversation page -- but a health report saying so", async () => {
    const window = new Window({ url: "https://chatgpt.com/" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter: SiteAdapter = {
      source: "chatgpt",
      getConversationId: () => null,
      extractMessages: () => [{ role: "user", text: "Hello" }],
    };

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(0);
    expect(reports(sent).at(-1)?.onConversation).toBe(false);
  });

  test("on a conversation but the adapter extracts nothing -> a report the popup can call degraded", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter: SiteAdapter = {
      source: "chatgpt",
      getConversationId: () => "conv_1",
      extractMessages: () => [],
      conversationContainerPresent: () => true,
    };

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      sendMessage: async (m) => void sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(0);
    const r = reports(sent).at(-1);
    expect(r?.onConversation).toBe(true);
    expect(r?.containerPresent).toBe(true);
    expect(r?.extracted).toBe(0);
  });
});
