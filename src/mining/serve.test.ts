import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { deleteConversation } from "../db/privacy";
import { loadIdeas } from "../db/queries";
import { tasteReport } from "../taste/taste";
import { consolidate, type MiningThought } from "./consolidate";
import { loadTasteLabels, recordThoughtReviews } from "./corrections";
import { hasV1Backup } from "./serve";
import { runShadowMining, syncServing } from "./shadow";

const USER = "user_test";
afterEach(() => delete process.env.THREAD_V2_SERVING_USERS);

/** Two thoughts about per-seat pricing that v1 split into two ideas (a duplicate), one resolved loop. */
function seed() {
  const db = openDb(":memory:");
  const ev = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES (?, ?, 'chatgpt', 'user', ?, ?, ?)");
  const cog = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote, why_it_matters) VALUES (?, ?, ?, 0.9, 'high', ?, ?, ?)");
  ev.run("m1", "c1", "Let's charge per seat.", "2026-09-01T00:00:00Z", 0);
  ev.run("m2", "c1", "Do guests count toward the per seat bill?", "2026-09-01T00:01:00Z", 1);
  cog.run("cog_m1_0", "new_idea", "Charge per seat.", "m1", "charge per seat", "Pricing decides who signs up.");
  cog.run("cog_m2_0", "question", "Do guests count toward the per seat bill?", "m2", "Do guests count", null);
  const idea = db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, ?, 'developing', ?, ?, ?)");
  const step = db.prepare("INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)");
  idea.run("idea_cog_m1_0", "Per-seat pricing", "Charge per seat.", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
  idea.run("idea_cog_m2_0", "Do guests count", "Do guests count toward the per seat bill?", "2026-09-01T00:01:00Z", "2026-09-01T00:01:00Z");
  step.run("idea_cog_m1_0", "cog_m1_0", "Charge per seat.", "2026-09-01T00:00:00Z", "m1");
  step.run("idea_cog_m2_0", "cog_m2_0", "Do guests count toward the per seat bill?", "2026-09-01T00:01:00Z", "m2");
  db.prepare("INSERT INTO open_loops (id, idea_id, statement, created_at, resolved) VALUES ('loop_cog_m2_0', 'idea_cog_m2_0', 'Do guests count?', '2026-09-01T00:01:00Z', 1)").run();
  return db;
}

const titles = (db: ReturnType<typeof seed>) => loadIdeas(db).map((i) => i.title).sort();

describe("serving v2", () => {
  test("off: v1 ideas are served untouched", () => {
    const db = seed();
    syncServing(USER, db, runShadowMining(db).ideas);
    expect(titles(db)).toEqual(["Do guests count", "Per-seat pricing"]);
    expect(hasV1Backup(db)).toBe(false);
  });

  test("on: the duplicate is regrouped into one idea that keeps its id, title, why, and answered question", () => {
    const db = seed();
    process.env.THREAD_V2_SERVING_USERS = USER;
    syncServing(USER, db, runShadowMining(db).ideas);
    const ideas = loadIdeas(db);
    expect(ideas.map((i) => i.id)).toEqual(["idea_cog_m1_0"]);
    expect(ideas[0]!.title).toBe("Per-seat pricing");
    expect(ideas[0]!.whyItMatters).toBe("Pricing decides who signs up.");
    expect(ideas[0]!.evolution.map((e) => e.cognitiveEventId)).toEqual(["cog_m1_0", "cog_m2_0"]);
    expect(ideas[0]!.openLoops).toEqual([expect.objectContaining({ id: "loop_cog_m2_0", resolved: true })]);
    expect(hasV1Backup(db)).toBe(true);
  });

  test("switching off again restores the v1 graph exactly", () => {
    const db = seed();
    const before = loadIdeas(db);
    process.env.THREAD_V2_SERVING_USERS = USER;
    syncServing(USER, db, runShadowMining(db).ideas);
    delete process.env.THREAD_V2_SERVING_USERS;
    syncServing(USER, db, runShadowMining(db).ideas);
    expect(loadIdeas(db)).toEqual(before);
    expect(hasV1Backup(db)).toBe(false);
  });

  test("deleting a conversation also drops the saved v1 copy of it", () => {
    const db = seed();
    process.env.THREAD_V2_SERVING_USERS = "*";
    syncServing(USER, db, runShadowMining(db).ideas);
    deleteConversation(db, "c1");
    expect(hasV1Backup(db)).toBe(false);
  });
});

describe("themes", () => {
  const t = (id: string, conv: string, statement: string): MiningThought => ({
    id, type: "new_idea", statement, persistence: "high", sourceEventId: `m_${id}`, conversationId: conv, position: 0, createdAt: `2026-09-0${id.length}T00:00:00Z`,
  });
  // Two different ideas about pricing (related, not the same) and one unrelated idea.
  const thoughts = [
    t("a", "c1", "Pricing per seat with annual billing discounts."),
    t("bb", "c2", "Pricing tiers for teams with usage billing."),
    t("ccc", "c3", "Onboarding should show value in five minutes."),
  ];
  const vectors = new Map<string, number[]>([["a", [1, 0.3, 0]], ["bb", [1, -0.3, 0]], ["ccc", [-1, 0, 1]]]);

  test("related ideas share a theme and list each other; ideas themselves are not merged", () => {
    const ideas = consolidate(thoughts, { vectors, anchorThreshold: 0.9, themeThreshold: 0.2 });
    expect(ideas).toHaveLength(3);
    const by = (id: string) => ideas.find((i) => i.thoughtIds[0] === id)!;
    expect(by("a").node.relatedIdeaIds).toEqual([by("bb").node.id]);
    expect(by("bb").node.relatedIdeaIds).toEqual([by("a").node.id]);
    expect(by("ccc").node.relatedIdeaIds).toEqual([]);
  });

  test("without a theme threshold nothing is related", () => {
    expect(consolidate(thoughts, { vectors, anchorThreshold: 0.9 }).every((i) => i.node.relatedIdeaIds.length === 0)).toBe(true);
  });
});

describe("thought reviews", () => {
  test("teach taste and grouping, replace an earlier review, and stay out of the acceptance rate", () => {
    const db = seed();
    expect(recordThoughtReviews(db, [{ thoughtId: "cog_m1_0", verdict: "keep" }, { thoughtId: "cog_m2_0", verdict: "keep" }, { thoughtId: "nope", verdict: "keep" }])).toBe(2);
    expect(recordThoughtReviews(db, [{ thoughtId: "cog_m2_0", verdict: "not_idea" }])).toBe(1);
    const labels = loadTasteLabels(db);
    expect([...labels.positives]).toEqual(["cog_m1_0"]);
    expect([...labels.negatives]).toEqual(["cog_m2_0"]);
    expect(labels.reviewed).toEqual({ keeps: 1, notIdeas: 1 });
    expect(labels.history).toEqual([]);
    const report = tasteReport(db);
    expect([report.keeps, report.notIdeas, report.acceptanceRate]).toEqual([1, 1, null]);
    // A reviewed thought teaches but doesn't confirm; the "no" thought is never mined again.
    expect(report.ideas.find((i) => i.ideaId === "idea_cog_m1_0")!.tier).not.toBe("confirmed");
    expect(runShadowMining(db).ideas.flatMap((i) => i.thoughtIds)).toEqual(["cog_m1_0"]);
  });
});
