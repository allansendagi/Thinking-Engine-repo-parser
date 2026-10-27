import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/client";
import type { CompletionProvider } from "../providers/types";
import { acceptableRewrite, registryBudget, tidyAccount } from "./tidy";

/** Answers each call with the next canned reply and reports a fixed token use. */
function fake(replies: string[], usage = { input: 1000, output: 200 }): CompletionProvider & { calls: number } {
  const p = {
    calls: 0,
    async complete(_s: string, _u: string, _m: number, o?: { onUsage?: (u: { input: number; output: number }) => void }) {
      o?.onUsage?.(usage);
      return replies[p.calls++] ?? '{"items":[]}';
    },
  };
  return p;
}

function account() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('m1','c','chatgpt','user','x','2026-09-01T00:00:00Z',0)").run();
  const q = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES (?, ?, ?, 0.9, 'high', 'm1', 'x')");
  q.run("q1", "question", "The user is asking whether authority should be checked per act.");
  q.run("q2", "question", "What is the user's opinion on the mind-stream-continuity project?");
  q.run("q3", "question", "Should guests count toward the bill?");
  q.run("c1", "claim", "Authority should be checked per act, not per agent.");
  db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES ('i1','Authority should be checked per act, not…','developing','Authority should be checked per act, not per agent.','2026-09-01','2026-09-01')").run();
  db.prepare("INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES ('i1','c1','x','2026-09-01','m1')").run();
  return db;
}
const budget = (cap: number) => registryBudget(new Database(":memory:"), cap);
const row = (db: Database, id: string) => db.query("SELECT statement, statement_original, persistence, tidied FROM cognitive_events WHERE id = ?").get(id) as Record<string, unknown>;

describe("tidy pass", () => {
  test("rewrites narration in the person's voice, sets aside requests for information, keeps the rest, names the idea", async () => {
    const db = account();
    const p = fake([
      JSON.stringify({ items: [
        { id: "q1", keep: true, text: "Should authority be checked per act?" },
        { id: "q2", keep: false },
        { id: "q3", keep: true },
      ] }),
      JSON.stringify({ items: [{ id: "i1", name: "Per-act authority" }] }),
    ]);
    const r = await tidyAccount(db, p, budget(1));
    expect(r).toEqual({ reviewed: 3, rewritten: 1, setAside: 1, named: 1, stoppedByBudget: false });
    expect(row(db, "q1")).toMatchObject({ statement: "Should authority be checked per act?", statement_original: "The user is asking whether authority should be checked per act.", tidied: 1 });
    expect(row(db, "q2")).toMatchObject({ persistence: "low", tidied: 1 });
    expect(row(db, "q3")).toMatchObject({ statement: "Should guests count toward the bill?", persistence: "high", tidied: 1 });
    expect((db.query("SELECT title FROM idea_nodes").get() as { title: string }).title).toBe("Per-act authority");
    expect((db.query("SELECT name FROM idea_names WHERE founder_thought_id = 'c1'").get() as { name: string }).name).toBe("Per-act authority");
    // a second run has nothing left to do and makes no call
    const again = fake([]);
    expect(await tidyAccount(db, again, budget(1))).toEqual({ reviewed: 0, rewritten: 0, setAside: 0, named: 0, stoppedByBudget: false });
    expect(again.calls).toBe(0);
  });

  test("a rewrite that changes the thought is refused; the question is kept as it was", async () => {
    const db = account();
    await tidyAccount(db, fake([JSON.stringify({ items: [{ id: "q1", keep: true, text: "How should we price the workshop?" }] })]), budget(1));
    expect(row(db, "q1")).toMatchObject({ statement: "The user is asking whether authority should be checked per act.", statement_original: null });
  });

  test("never spends past the cap: with nothing left it makes no call", async () => {
    const db = account();
    const p = fake([]);
    const r = await tidyAccount(db, p, budget(0));
    expect(r.stoppedByBudget).toBe(true);
    expect(p.calls).toBe(0);
    expect(row(db, "q1")).toMatchObject({ tidied: 0 }); // reviewed next time, when there is budget
  });

  test("the cap is shared and remembered: charges accumulate across accounts", async () => {
    const reg = new Database(":memory:");
    const b = registryBudget(reg, 0.01);
    await tidyAccount(account(), fake([JSON.stringify({ items: [] })], { input: 2000, output: 400 }), b); // ~$0.004 per call
    expect(b.remaining()).toBeLessThan(0.01);
    expect(registryBudget(reg, 0.01).remaining()).toBeCloseTo(b.remaining());
  });

  test("acceptableRewrite", () => {
    expect(acceptableRewrite("The user is asking whether authority should be checked per act.", "Should authority be checked per act?")).toBe(true);
    expect(acceptableRewrite("The user is asking whether authority should be checked per act.", "The user wants to know about pricing")).toBe(false);
  });
});

describe("a reply that is cut off", () => {
  test("every whole item in it is used, the rest are tried once and never paid for again", async () => {
    const db = account();
    const cut = '{"items":[{"id":"q2","keep":false},{"id":"q3","keep":true},{"id":"q1","keep":true,"text":"Should auth';
    const r = await tidyAccount(db, fake([cut, '{"items":[]}']), budget(1));
    expect(r.setAside).toBe(1);
    expect(row(db, "q3")).toMatchObject({ tidied: 1 });
    expect(row(db, "q1")).toMatchObject({ tidied: -1, statement: "The user is asking whether authority should be checked per act." });
    const again = fake([]);
    await tidyAccount(db, again, budget(1));
    expect(again.calls).toBe(0); // nothing left: no question and no name is retried
  });
});
