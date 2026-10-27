import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client";
import { storeThoughtVectors } from "../db/thoughts";
import { recordCorrection, recordKeep, loadTasteLabels } from "../mining/corrections";
import { buildLesson } from "./lesson";
import { createRequestHandler } from "../api/handler";
import { openUserDb } from "../db/tenancy";
import { FakeProvider } from "../providers/fake";

/** One idea per thought; vectors put "k*" thoughts near +x (kept-like) and "j*" near +y. */
function seed(rows: { id: string; at: string; vec?: number[] }[], db: Database = openDb(":memory:")) {
  const ev = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES (?, ?, 'chatgpt', 'user', 'x', ?, 0)");
  const cog = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES (?, 'new_idea', ?, 0.9, 'high', ?, 'x')");
  const idea = db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, ?, 'developing', ?, ?, ?)");
  const step = db.prepare("INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) {
    ev.run(`m_${r.id}`, `c_${r.id}`, r.at);
    cog.run(`t_${r.id}`, `statement ${r.id}`, `m_${r.id}`);
    idea.run(`i_${r.id}`, `Idea ${r.id}`, `statement ${r.id}`, r.at, r.at);
    step.run(`i_${r.id}`, `t_${r.id}`, `statement ${r.id}`, r.at, `m_${r.id}`);
  }
  const withVec = rows.filter((r) => r.vec);
  if (withVec.length) storeThoughtVectors(db, "voyage:voyage-4-large", withVec.map((r) => ({ id: `t_${r.id}`, vector: [...r.vec!, ...Array(14).fill(0)] })));
  return db;
}

describe("Teach Thread: which questions", () => {
  test("before Thread can judge: the newest unjudged ideas, newest first", () => {
    const db = seed([
      { id: "a", at: "2026-10-01T00:00:00Z" },
      { id: "b", at: "2026-10-03T00:00:00Z" },
      { id: "c", at: "2026-10-02T00:00:00Z" },
    ]);
    recordKeep(db, "i_c", ["t_c"]);
    const l = buildLesson(db);
    expect(l.ready).toBe(false);
    expect(l.questions.map((q) => (q.kind === "idea" ? `${q.ideaId}:${q.reason}` : "pair"))).toEqual(["i_b:new", "i_a:new"]);
  });

  test("once it can judge: the ideas it's least sure about come first", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, at: `2026-09-0${i + 1}T00:00:00Z`, vec: [1, 0.05 * i] })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `j${i}`, at: `2026-09-1${i}T00:00:00Z`, vec: [0.05 * i, 1] })),
      { id: "clear", at: "2026-10-05T00:00:00Z", vec: [1, 0.01] }, // obviously kept-like
      { id: "torn", at: "2026-10-04T00:00:00Z", vec: [1, 1] }, // halfway: the most informative
    ];
    const db = seed(rows);
    for (let i = 0; i < 6; i++) recordKeep(db, `i_k${i}`, [`t_k${i}`], "lesson");
    for (let i = 0; i < 6; i++) recordCorrection(db, { kind: "not_idea", ideaId: `i_j${i}`, thoughtIds: [`t_j${i}`], origin: "lesson" });
    db.exec("DELETE FROM evolution_steps WHERE idea_id LIKE 'i_j%'; DELETE FROM idea_nodes WHERE id LIKE 'i_j%'"); // children first
    const l = buildLesson(db);
    expect(l.ready).toBe(true);
    const first = l.questions[0]!;
    expect(first.kind === "idea" && first.ideaId).toBe("i_torn");
    expect(first.kind === "idea" && first.reason).toBe("unsure");
    // Lesson answers teach (ready, counted as learned) but never move the acceptance rate.
    expect(l.acceptanceRate).toBeNull();
    expect(l.learned).toBe(12);
    expect(loadTasteLabels(db).history).toEqual([]);
  });

  test("Same idea?: related ideas nearest the same-idea / same-subject line, never asked twice", () => {
    const db = seed([
      { id: "p", at: "2026-10-01T00:00:00Z", vec: [1, 0] },
      { id: "q", at: "2026-10-02T00:00:00Z", vec: [0.65, 0.76] }, // cosine 0.65 with p: on the line
      { id: "r", at: "2026-10-03T00:00:00Z", vec: [0.99, 0.14] }, // 0.99: obviously the same -- not asked
    ]);
    for (const [a, b] of [["p", "q"], ["p", "r"]]) {
      db.prepare("INSERT INTO related_ideas (idea_id, related_idea_id) VALUES (?, ?), (?, ?)").run(`i_${a}`, `i_${b}`, `i_${b}`, `i_${a}`);
    }
    for (const id of ["p", "q", "r"]) recordKeep(db, `i_${id}`, [`t_${id}`]); // judged: no idea questions
    const pairs = buildLesson(db).questions.filter((q) => q.kind === "pair");
    expect(pairs.map((q) => (q.kind === "pair" ? [q.a.ideaId, q.b.ideaId].sort().join("+") : ""))).toEqual(["i_p+i_q"]);
    db.prepare("INSERT INTO learn_pairs (pair_key, answer, answered_at) VALUES (?, 'different', ?)").run(["t_p", "t_q"].sort().join("|"), new Date().toISOString());
    expect(buildLesson(db).questions.filter((q) => q.kind === "pair")).toEqual([]);
  });
});

describe("Teach Thread over HTTP", () => {
  let dir = "";
  const saved = { reg: process.env.THREAD_REGISTRY_PATH, data: process.env.THREAD_DATA_DIR, rate: process.env.THREAD_RATE_LIMIT };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lesson-"));
    process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
    process.env.THREAD_DATA_DIR = join(dir, "users");
    process.env.THREAD_RATE_LIMIT = "off";
  });
  afterAll(() => {
    for (const [k, v] of [["THREAD_REGISTRY_PATH", saved.reg], ["THREAD_DATA_DIR", saved.data], ["THREAD_RATE_LIMIT", saved.rate]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("answers reach the existing learning: keep, not an idea, skip rests, same/different become constraints", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const { userId, token } = (await (await handler(new Request("http://x/v1/users", { method: "POST" }))).json()) as { userId: string; token: string };
    const headers = { authorization: `Bearer ${userId}:${token}`, "content-type": "application/json" };
    const db = openUserDb(userId);
    try {
      seed([{ id: "a", at: "2026-10-01T00:00:00Z" }, { id: "b", at: "2026-10-02T00:00:00Z" }, { id: "c", at: "2026-10-03T00:00:00Z" }, { id: "d", at: "2026-10-04T00:00:00Z" }], db);
    } finally {
      db.close();
    }
    const answer = (body: object) => handler(new Request("http://x/v1/learn/answer", { method: "POST", headers, body: JSON.stringify(body) }));
    expect((await answer({ kind: "idea", ideaId: "i_d", answer: "maybe" })).status).toBe(400);
    expect((await answer({ kind: "idea", ideaId: "nope", answer: "keep" })).status).toBe(404);
    expect((await answer({ kind: "idea", ideaId: "i_d", answer: "keep" })).status).toBe(200);
    expect((await answer({ kind: "idea", ideaId: "i_c", answer: "not_idea" })).status).toBe(200);
    const after = (await (await answer({ kind: "idea", ideaId: "i_b", answer: "skip" })).json()) as { questions: { kind: string; ideaId?: string }[]; learned: number; acceptanceRate: number | null };
    expect(after.questions.map((q) => q.ideaId)).toEqual(["i_a"]); // d kept, c gone, b resting
    expect(after.learned).toBe(2);
    expect(after.acceptanceRate).toBeNull();
    expect((await answer({ kind: "pair", a: "i_a", b: "i_b", answer: "different" })).status).toBe(200);
    const check = openUserDb(userId);
    try {
      const corr = check.query("SELECT kind, origin FROM idea_corrections ORDER BY id").all();
      expect(corr).toEqual([{ kind: "not_idea", origin: "lesson" }, { kind: "split", origin: "lesson" }]);
      expect(check.query("SELECT answer FROM learn_pairs").all()).toEqual([{ answer: "different" }]);
    } finally {
      check.close();
    }
  });
});
