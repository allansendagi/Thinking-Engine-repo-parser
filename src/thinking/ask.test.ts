import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { storeThoughtVectors } from "../db/thoughts";
import { buildThinkingState } from "../state/thinkingState";
import type { IdeaNode } from "../types";
import { askMyThinking } from "./ask";

function seed() {
  const db = openDb(":memory:");
  const ev = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx, source_url) VALUES (?, ?, ?, 'user', 'x', ?, 0, ?)");
  const cog = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES (?, ?, ?, 0.9, 'high', ?, 'x')");
  const idea = db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, ?, 'developing', ?, '2026-09-01', '2026-09-20')");
  const step = db.prepare("INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)");
  ev.run("m1", "c1", "chatgpt", "2026-09-01T00:00:00Z", "https://chatgpt.com/c/1");
  ev.run("m2", "c2", "claude", "2026-09-20T00:00:00Z", "https://claude.ai/chat/2");
  ev.run("m3", "c3", "chatgpt", "2026-09-05T00:00:00Z", null);
  cog.run("t1", "new_idea", "Charge a flat fee.", "m1");
  cog.run("t2", "refinement", "Charge per seat, not a flat fee.", "m2");
  cog.run("t3", "new_idea", "Onboarding should take five minutes.", "m3");
  idea.run("i1", "Pricing", "Charge per seat, not a flat fee.");
  idea.run("i2", "Onboarding", "Onboarding should take five minutes.");
  step.run("i1", "t1", "Charge a flat fee.", "2026-09-01T00:00:00Z", "m1");
  step.run("i1", "t2", "Charge per seat, not a flat fee.", "2026-09-20T00:00:00Z", "m2");
  step.run("i2", "t3", "Onboarding should take five minutes.", "2026-09-05T00:00:00Z", "m3");
  db.prepare("INSERT INTO open_loops (id, idea_id, statement, created_at, resolved) VALUES ('loop_q', 'i1', 'Do guests count?', '2026-09-20T00:00:00Z', 0)").run();
  return db;
}

describe("what do I think about X", () => {
  test("by words: where I stand, how I got there, what's open -- each with its source", async () => {
    const a = await askMyThinking(seed(), "pricing per seat");
    expect(a.method).toBe("words");
    expect(a.ideas.map((i) => i.title)).toEqual(["Pricing"]);
    const p = a.ideas[0]!;
    expect(p.stance).toBe("Charge per seat, not a flat fee.");
    expect(p.path).toEqual([{ statement: "Charge a flat fee.", at: "2026-09-01T00:00:00Z", source: "chatgpt", sourceUrl: "https://chatgpt.com/c/1", conversationId: "c1" }]);
    expect(p.openQuestions).toEqual([{ statement: "Do guests count?", raisedAt: "2026-09-20T00:00:00Z" }]);
    expect([a.conversations, a.tools]).toEqual([2, ["chatgpt", "claude"]]);
  });

  test("by meaning when the account has Voyage vectors; a failed embed falls back to words", async () => {
    const db = seed();
    const v = (a: number, b: number, c: number) => [a, b, c, ...Array(13).fill(0)];
    storeThoughtVectors(db, "voyage:voyage-4-large", [
      { id: "t1", vector: v(1, 0, 0) }, { id: "t2", vector: v(0.9, 0.1, 0) }, { id: "t3", vector: v(0, 0, 1) },
    ]);
    const a = await askMyThinking(db, "what do I charge?", async () => v(0, 0.05, 1));
    expect(a.method).toBe("meaning");
    expect(a.ideas[0]!.title).toBe("Onboarding");
    const b = await askMyThinking(db, "pricing", async () => { throw new Error("down"); });
    expect([b.method, b.ideas[0]!.title]).toEqual(["words", "Pricing"]);
  });
});

describe("you never answered this", () => {
  const idea = (id: string, steps: [string, string][], loops: IdeaNode["openLoops"] = [], related: string[] = []): IdeaNode => ({
    id, title: id, state: "developing", currentFormulation: id, openLoops: loops, decisions: [], relatedIdeaIds: related,
    evolution: steps.map(([t, at]) => ({ cognitiveEventId: t, formulation: t, createdAt: at, sourceEventId: `m_${t}` })),
    createdAt: steps[0]![1], updatedAt: steps.at(-1)![1],
  });
  const now = new Date("2026-10-19T12:00:00Z");
  const old = { id: "loop_q", statement: "Do guests count?", createdAt: "2026-10-01T00:00:00Z", resolved: false };

  test("an old open question resurfaces when its idea -- or one in its theme -- moved in the last days", () => {
    const back = idea("pricing", [["q", "2026-10-01T00:00:00Z"], ["new", "2026-10-18T00:00:00Z"]], [old]);
    expect(buildThinkingState([back], [], { now }).revisit).toEqual([
      { ideaId: "pricing", ideaTitle: "pricing", loopId: "loop_q", statement: "Do guests count?", raisedAt: old.createdAt, backOnTopicAt: "2026-10-18T00:00:00Z", via: null },
    ]);
    const viaTheme = [idea("pricing", [["q", "2026-10-01T00:00:00Z"]], [old], ["seats"]), idea("seats", [["s", "2026-10-19T00:00:00Z"]])];
    expect(buildThinkingState(viaTheme, [], { now }).revisit[0]!.via).toBe("seats");
  });

  test("not when the person isn't back on it, the question is recent, or it's answered", () => {
    const quiet = idea("pricing", [["q", "2026-10-01T00:00:00Z"], ["x", "2026-10-10T00:00:00Z"]], [old]);
    const recentQ = idea("pricing", [["q", "2026-10-17T00:00:00Z"], ["new", "2026-10-18T00:00:00Z"]], [{ ...old, createdAt: "2026-10-17T00:00:00Z" }]);
    const answered = idea("pricing", [["q", "2026-10-01T00:00:00Z"], ["new", "2026-10-18T00:00:00Z"]], [{ ...old, resolved: true }]);
    for (const i of [quiet, recentQ, answered]) expect(buildThinkingState([i], [], { now }).revisit).toEqual([]);
  });
});
