import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CAPTURE_QUEUE_MAX, enqueueCapture, getCaptureQueue, setCaptureQueue } from "./storage";
import type { CapturedMessage } from "./types";

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
