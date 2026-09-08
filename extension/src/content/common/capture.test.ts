import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { startCapture } from "./capture";
import type { SiteAdapter, RawMessage } from "./siteAdapter";
import type { CaptureMessage, CaptureReport, HealthMessage } from "../../lib/types";

type AnyMsg = CaptureMessage | HealthMessage;
const captures = (msgs: AnyMsg[]): CaptureMessage[] =>
  msgs.filter((m): m is CaptureMessage => m.type === "thread:capture");
const reports = (msgs: AnyMsg[]): CaptureReport[] =>
  msgs.filter((m): m is HealthMessage => m.type === "thread:health").map((m) => m.report);

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

describe("startCapture (debounce + dedup, no real browser or network)", () => {
  beforeEach(() => installFakeChromeStorage());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("sends once after the debounce window, with position-based ids", async () => {
    const window = new Window({ url: "https://chatgpt.com/c/conv_1" });
    installMutationObserver(window);
    const sent: AnyMsg[] = [];
    const adapter = makeAdapter(() => [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ]);

    const stop = startCapture(adapter, window.document as unknown as ParentNode, {
      debounceMs: 10,
      sendMessage: async (m) => {
        sent.push(m);
      },
      now: () => "2026-08-17T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(1);
    expect(captures(sent)[0]?.messages).toEqual([
      { id: "conv_1::0", role: "user", text: "Hello", createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "conv_1::1", role: "assistant", text: "Hi", createdAt: "2026-08-17T00:00:00.000Z" },
    ]);
    // A health report rides along, saying it's on a conversation and extraction is working.
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

    // A second capture pass over the SAME unchanged conversation (e.g. a fresh content-script
    // instance after navigation) should not re-send what's already recorded as sent.
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
      sendMessage: async (m) => void sent.push(m),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(captures(sent)).toHaveLength(1);

    messages = [...messages, { role: "assistant", text: "Hi there" }];
    // MutationObserver only fires on a real DOM mutation -- this is what triggers re-extraction.
    window.document.body.appendChild(window.document.createElement("div"));

    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(captures(sent)).toHaveLength(2);
    expect(captures(sent)[1]?.messages).toHaveLength(2);
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
