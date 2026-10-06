import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CAPTURE_QUEUE_MAX, enqueueCapture, getCaptureQueue, retryDecision, retryDelayMs, setCaptureQueue } from "./storage";
import type { CapturedMessage, QueuedCapture } from "./types";

function installFakeChromeStorage(): void {
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async (key: string) => void store.delete(key),
      },
    },
  };
}

const msg = (id: string): CapturedMessage => ({ id, role: "user", text: id, createdAt: "2026-09-08T00:00:00.000Z" });
const entry = (conversationId: string, ids: string[]) => ({
  conversationId,
  source: "chatgpt" as const,
  sourceUrl: null,
  messages: ids.map(msg),
});

describe("capture retry queue", () => {
  beforeEach(installFakeChromeStorage);
  afterEach(() => void delete (globalThis as { chrome?: unknown }).chrome);

  test("starts empty", async () => {
    expect(await getCaptureQueue()).toEqual([]);
  });

  test("re-queuing the same conversation replaces its transcript and keeps attempts/queuedAt", async () => {
    await enqueueCapture(entry("c1", ["m1"]));
    let q = await getCaptureQueue();
    q[0]!.attempts = 3; // simulate a couple of failed drains
    await setCaptureQueue(q);

    await enqueueCapture(entry("c1", ["m1", "m2", "m3"])); // the growing transcript
    q = await getCaptureQueue();
    expect(q).toHaveLength(1);
    expect(q[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(q[0]!.attempts).toBe(3); // carried over, not reset
  });

  test("distinct conversations each get an entry, oldest evicted past the cap", async () => {
    for (let i = 0; i < CAPTURE_QUEUE_MAX + 5; i++) await enqueueCapture(entry(`c${i}`, ["m"]));
    const q = await getCaptureQueue();
    expect(q).toHaveLength(CAPTURE_QUEUE_MAX);
    expect(q[0]!.conversationId).toBe("c5"); // c0..c4 evicted
    expect(q.at(-1)!.conversationId).toBe(`c${CAPTURE_QUEUE_MAX + 4}`);
  });
});

describe("capture retry backoff", () => {
  const entry = (over: Partial<QueuedCapture> = {}): QueuedCapture => ({
    conversationId: "c", source: "claude", sourceUrl: null, messages: [], queuedAt: "2026-10-06T08:00:00.000Z", attempts: 0, ...over,
  });
  const at = (iso: string) => new Date(iso).getTime();

  test("keeps retrying for a week instead of giving up after a few minutes", () => {
    expect(retryDecision(entry({ attempts: 50 }), at("2026-10-06T09:00:00.000Z"))).toBe("send");
    expect(retryDecision(entry(), at("2026-10-12T07:59:00.000Z"))).toBe("send");
    expect(retryDecision(entry(), at("2026-10-13T08:01:00.000Z"))).toBe("expire");
  });

  test("waits out its backoff, which doubles up to an hour", () => {
    expect(retryDecision(entry({ nextAttemptAt: "2026-10-06T08:10:00.000Z" }), at("2026-10-06T08:05:00.000Z"))).toBe("wait");
    expect([1, 2, 3, 7, 20].map((n) => retryDelayMs(n) / 60_000)).toEqual([1, 2, 4, 60, 60]);
  });
});
