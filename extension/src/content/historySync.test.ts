import { describe, expect, test } from "bun:test";
import { runHistorySync } from "./historySync";
import type { HistoryReader } from "./structured";

function fakeReader(ids: string[], opts: { pageSize?: number; failOn?: string; ignoreOffset?: boolean } = {}): HistoryReader & { fetched: string[] } {
  const pageSize = opts.pageSize ?? 3;
  const fetched: string[] = [];
  return {
    format: "chatgpt",
    fetched,
    async listPage(page) {
      const start = opts.ignoreOffset ? 0 : page * pageSize;
      const items = ids.slice(start, start + pageSize).map((id) => ({ id, updatedAt: `t-${id}` }));
      return { items, done: start + pageSize >= ids.length && !opts.ignoreOffset };
    },
    async fetchForImport(id) {
      if (id === opts.failOn) throw new Error("boom");
      fetched.push(id);
      return { id };
    },
    async fetchMessages() {
      return [];
    },
  };
}

describe("runHistorySync", () => {
  test("imports everything in batches and records what was synced", async () => {
    const reader = fakeReader(["a", "b", "c", "d", "e"]);
    const batches: unknown[][] = [];
    const synced: Record<string, string> = {};
    const p = await runHistorySync({
      reader, synced, delayMs: 0, batchSize: 2,
      sendBatch: async (b) => { batches.push(b); return { ideaCount: batches.length }; },
      markSynced: async (e) => { Object.assign(synced, e); },
    });
    expect(p.state).toBe("done");
    expect(p.imported).toBe(5);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(Object.keys(synced).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(p.ideaCount).toBe(3);
  });

  test("resumes: skips conversations already imported at the same version", async () => {
    const reader = fakeReader(["a", "b", "c"]);
    const p = await runHistorySync({
      reader, synced: { a: "t-a", b: "stale" }, delayMs: 0,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(reader.fetched).toEqual(["b", "c"]);
    expect(p.skipped).toBe(1);
  });

  test("stops cleanly at the Free cap without marking that batch synced", async () => {
    const reader = fakeReader(["a", "b", "c", "d"]);
    const synced: Record<string, string> = {};
    let n = 0;
    const p = await runHistorySync({
      reader, synced, delayMs: 0, batchSize: 2,
      sendBatch: async () => (++n === 2 ? { capped: true } : {}),
      markSynced: async (e) => { Object.assign(synced, e); },
    });
    expect(p.state).toBe("capped");
    expect(Object.keys(synced)).toEqual(["a", "b"]);
  });

  test("one unreadable conversation doesn't sink the run", async () => {
    const p = await runHistorySync({
      reader: fakeReader(["a", "b", "c"], { failOn: "b" }), synced: {}, delayMs: 0,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(p.state).toBe("done");
    expect(p.failed).toBe(1);
    expect(p.imported).toBe(2);
  });

  test("an endpoint that ignores paging can't loop forever", async () => {
    const p = await runHistorySync({
      reader: fakeReader(["a", "b", "c"], { ignoreOffset: true }), synced: {}, delayMs: 0,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(p.found).toBe(3);
    expect(p.state).toBe("done");
  });

  test("a listing failure is reported, not thrown", async () => {
    const reader = fakeReader([]);
    reader.listPage = async () => { throw new Error("401"); };
    const p = await runHistorySync({ reader, synced: {}, delayMs: 0, sendBatch: async () => ({}), markSynced: async () => {} });
    expect(p.state).toBe("error");
    expect(p.error).toContain("401");
  });
});
