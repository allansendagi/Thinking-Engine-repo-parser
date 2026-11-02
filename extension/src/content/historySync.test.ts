import { describe, expect, test } from "bun:test";
import { runHistorySync, splitRecent } from "./historySync";
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

describe("checking for new after a full import", () => {
  // Newest first by update time, like ChatGPT's order=updated.
  function dated(rows: [string, string][], pageSize = 2): HistoryReader & { pages: number } {
    const r = {
      format: "chatgpt" as const,
      pages: 0,
      async listPage(page: number) {
        r.pages++;
        const items = rows.slice(page * pageSize, page * pageSize + pageSize).map(([id, updatedAt]) => ({ id, updatedAt }));
        return { items, done: (page + 1) * pageSize >= rows.length };
      },
      async fetchForImport(id: string) {
        return { id };
      },
      async fetchMessages() {
        return [];
      },
    };
    return r;
  }
  const rows: [string, string][] = [["new", "2026-10-19"], ["b", "2026-10-10"], ["c", "2026-10-09"], ["d", "2026-10-08"], ["e", "2026-10-01"], ["f", "2026-09-01"]];
  const synced = { b: "2026-10-10", c: "2026-10-09", d: "2026-10-08", e: "2026-10-01", f: "2026-09-01" };

  test("stops listing at the first page that's all already in, and imports only what's new", async () => {
    const reader = dated(rows);
    const sent: unknown[] = [];
    const p = await runHistorySync({
      reader, synced: { ...synced }, previouslyComplete: true, delayMs: 0,
      sendBatch: async (b) => { sent.push(...b); return {}; },
      markSynced: async () => {},
    });
    expect(p.state).toBe("done");
    expect(sent).toEqual([{ id: "new" }]);
    expect(reader.pages).toBe(2); // page 0 has "new"; page 1 is all known -> stop; page 2 never fetched
  });

  test("without a finished earlier import, or if the list isn't newest-first, it walks everything", async () => {
    const a = dated(rows);
    await runHistorySync({ reader: a, synced: { ...synced }, delayMs: 0, sendBatch: async () => ({}), markSynced: async () => {} });
    expect(a.pages).toBe(3);
    const shuffled = dated([rows[0]!, rows[1]!, rows[5]!, rows[2]!, rows[3]!, rows[4]!]);
    await runHistorySync({ reader: shuffled, synced: { ...synced }, previouslyComplete: true, delayMs: 0, sendBatch: async () => ({}), markSynced: async () => {} });
    expect(shuffled.pages).toBe(3);
  });
});

describe("what a recovery brings in by default (same rule as Thread for Mac)", () => {
  const NOW = Date.parse("2026-11-02T00:00:00Z");
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  // A reader over dated conversations, listed newest first like the real sites.
  function datedReader(n: number, spacingDays: number): HistoryReader & { fetched: string[] } {
    const items = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, updatedAt: daysAgo(i * spacingDays) }));
    const fetched: string[] = [];
    return {
      format: "chatgpt",
      fetched,
      async listPage(page) {
        const slice = items.slice(page * 50, page * 50 + 50);
        return { items: slice, done: page * 50 + 50 >= items.length };
      },
      async fetchForImport(id) { fetched.push(id); return { id }; },
      async fetchMessages() { return []; },
    };
  }

  test("the newest 100 when little is recent, the rest counted as older and not fetched", async () => {
    const reader = datedReader(150, 3); // ~30 within 90 days
    const batches: number[] = [];
    const p = await runHistorySync({
      reader, synced: {}, delayMs: 0, now: NOW,
      sendBatch: async (b) => { batches.push(b.length); return {}; }, markSynced: async () => {},
    });
    expect(p.state).toBe("done");
    expect(reader.fetched.length).toBe(100);
    expect(reader.fetched[0]).toBe("c0");
    expect(p.older).toBe(50);
    expect(batches[0]).toBe(5); // first ideas fast
    expect(batches.slice(1).every((n) => n <= 15)).toBe(true);
  });

  test("everything from the last 90 days when that's more than 100", async () => {
    const reader = datedReader(400, 0.5); // 181 within 90 days
    const p = await runHistorySync({
      reader, synced: {}, delayMs: 0, now: NOW,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(reader.fetched.length).toBe(181);
    expect(p.older).toBe(219);
  });

  test("asking for older brings in everything, newest first", async () => {
    const reader = datedReader(150, 3);
    const p = await runHistorySync({
      reader, synced: {}, delayMs: 0, now: NOW, includeOlder: true,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(reader.fetched.length).toBe(150);
    expect(p.older).toBe(0);
  });

  test("what's already in counts toward the 100", async () => {
    const reader = datedReader(150, 3);
    const synced = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, daysAgo(i * 3)]));
    await runHistorySync({
      reader, synced, delayMs: 0, now: NOW,
      sendBatch: async () => ({}), markSynced: async () => {},
    });
    expect(reader.fetched).toEqual(Array.from({ length: 40 }, (_, i) => `c${60 + i}`));
  });

  test("splitRecent keeps undated conversations last", () => {
    const { recent } = splitRecent([{ id: "x", updatedAt: "?" }, { id: "y", updatedAt: daysAgo(1) }], NOW);
    expect(recent.map((c) => c.id)).toEqual(["y", "x"]);
  });
});
