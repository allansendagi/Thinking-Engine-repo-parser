import { describe, expect, test } from "bun:test";
import { openDb } from "./client";
import { listConversations } from "./queries";

function seed(db: ReturnType<typeof openDb>, rows: { cid: string; idx: number; role: "user" | "assistant"; text: string; at: string; removed?: boolean }[]) {
  const ins = db.prepare(
    "INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx, text_removed_at) VALUES (?, ?, 'claude_code', ?, ?, ?, ?, ?)",
  );
  for (const r of rows) ins.run(`${r.cid}-${r.idx}`, r.cid, r.role, r.text, r.at, r.idx, r.removed ? "2026-10-01T00:00:00Z" : null);
}

describe("Activity rows say where a conversation is now", () => {
  test("preview is how it began; latest is the newest thing the user said (not the assistant's reply)", () => {
    const db = openDb(":memory:");
    seed(db, [
      { cid: "c1", idx: 0, role: "user", text: "am ready to set up app store and pay", at: "2026-10-01T09:00:00Z" },
      { cid: "c1", idx: 1, role: "assistant", text: "Great, here is the process...", at: "2026-10-01T09:00:05Z" },
      { cid: "c1", idx: 2, role: "user", text: "ok now  make the\nwidget work", at: "2026-10-19T17:45:00Z" },
      { cid: "c1", idx: 3, role: "assistant", text: "Working on it", at: "2026-10-19T17:45:05Z" },
    ]);
    const [c] = listConversations(db);
    expect(c!.preview).toBe("am ready to set up app store and pay");
    expect(c!.latest).toBe("ok now make the widget work"); // whitespace collapsed
  });

  test("a one-message conversation has the same preview and latest", () => {
    const db = openDb(":memory:");
    seed(db, [{ cid: "c2", idx: 0, role: "user", text: "just one thought", at: "2026-10-02T09:00:00Z" }]);
    const [c] = listConversations(db);
    expect(c!.latest).toBe(c!.preview);
  });

  test("a message whose text was removed by retention is skipped, and the row never goes blank", () => {
    const db = openDb(":memory:");
    seed(db, [
      { cid: "c3", idx: 0, role: "user", text: "first", at: "2026-10-03T09:00:00Z" },
      { cid: "c3", idx: 1, role: "user", text: "removed later", at: "2026-10-03T09:01:00Z", removed: true },
    ]);
    const [c] = listConversations(db);
    expect(c!.latest).toBe("first");
    const gone = openDb(":memory:");
    seed(gone, [{ cid: "c4", idx: 0, role: "user", text: "x", at: "2026-10-04T09:00:00Z", removed: true }]);
    expect(listConversations(gone)[0]!.latest).toBe("Raw text removed by your retention setting");
  });

  test("the latest line is capped like the preview", () => {
    const db = openDb(":memory:");
    seed(db, [
      { cid: "c5", idx: 0, role: "user", text: "start", at: "2026-10-05T09:00:00Z" },
      { cid: "c5", idx: 1, role: "user", text: "word ".repeat(100), at: "2026-10-05T09:05:00Z" },
    ]);
    expect(listConversations(db)[0]!.latest.length).toBeLessThanOrEqual(140);
  });
});
