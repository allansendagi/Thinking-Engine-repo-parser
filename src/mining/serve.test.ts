import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { deleteConversation } from "../db/privacy";
import { loadIdeas } from "../db/queries";
import { tasteReport } from "../taste/taste";
import { consolidate, type MiningThought } from "./consolidate";
import { loadTasteLabels, recordThoughtReviews } from "./corrections";
import { setOpenLoopResolved, UPSERT_OPEN_LOOP_SQL } from "../db/mutations";
import { hasV1Backup, headlineThoughtIds, restoreV1 } from "./serve";
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

  test("a click on a v2 idea judges its founding and current thoughts only, not the whole group", () => {
    const db = seed();
    db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('m3', 'c1', 'chatgpt', 'user', 'x', '2026-09-01T00:02:00Z', 2)").run();
    db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES ('cog_m3_0', 'claim', 'Per seat pricing should exclude guests.', 0.9, 'high', 'm3', 'x')").run();
    process.env.THREAD_V2_SERVING_USERS = USER;
    syncServing(USER, db, runShadowMining(db).ideas);
    expect(loadIdeas(db)[0]!.evolution).toHaveLength(3);
    expect(headlineThoughtIds(db, "idea_cog_m1_0")).toEqual(["cog_m1_0", "cog_m3_0"]); // the question isn't judged
  });

  test("a lone new thought is served at once (a spark), so it can be found right after capture", () => {
    const db = seed();
    db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('m9', 'c9', 'chatgpt', 'user', 'x', '2026-09-05T00:00:00Z', 0)").run();
    db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES ('cog_m9_0', 'claim', 'Onboarding should show value within five minutes.', 0.9, 'medium', 'm9', 'x')").run();
    process.env.THREAD_V2_SERVING_USERS = USER;
    syncServing(USER, db, runShadowMining(db).ideas);
    expect(titles(db)).toContain("Onboarding should show value within five minutes");
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

describe("who decides whether a question is closed", () => {
  const loopState = (db: ReturnType<typeof seed>) => (db.query("SELECT resolved FROM open_loops WHERE id = 'loop_cog_m2_0'").get() as { resolved: number } | null)?.resolved;

  /** The seed's question, plus an answer that names it, served by v2. Starts with the loop open. */
  function answered() {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = seed();
    db.prepare("UPDATE open_loops SET resolved = 0").run();
    db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('m3', 'c1', 'chatgpt', 'user', 'Guests count after the first five.', '2026-09-01T00:02:00Z', 2)").run();
    db.prepare(
      "INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote, answers_event_id) VALUES ('cog_m3_0', 'decision', 'Guests count after the first five.', 0.9, 'high', 'm3', 'Guests count', 'm2')",
    ).run();
    return db;
  }
  const regroup = (db: ReturnType<typeof seed>) => syncServing(USER, db, runShadowMining(db).ideas);

  test("Thread closes the question the answer names", () => {
    const db = answered();
    regroup(db);
    expect(loopState(db)).toBe(1);
  });

  test("a question the person reopens stays open through the next regroup", () => {
    const db = answered();
    regroup(db);
    expect(loopState(db)).toBe(1);
    setOpenLoopResolved(db, "loop_cog_m2_0", false); // the person says: that is not answered
    regroup(db); // every capture triggers one of these
    expect(loopState(db)).toBe(0);
  });

  test("a question the person closes stays closed even if the analysis never would", () => {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = seed();
    db.prepare("UPDATE open_loops SET resolved = 0").run();
    regroup(db);
    expect(loopState(db)).toBe(0);
    setOpenLoopResolved(db, "loop_cog_m2_0", true);
    regroup(db);
    expect(loopState(db)).toBe(1);
  });

  test("a closure Thread made heals when the evidence for it goes away", () => {
    const db = answered();
    regroup(db);
    expect(loopState(db)).toBe(1);
    // Re-extraction decides that "answer" never was one: the link is gone, so the evidence is too.
    db.prepare("UPDATE cognitive_events SET answers_event_id = NULL WHERE id = 'cog_m3_0'").run();
    regroup(db);
    expect(loopState(db)).toBe(0);
  });

  test("the older v1 write never overwrites a question the person decided", () => {
    const db = seed();
    const write = (resolved: number) => db.prepare(UPSERT_OPEN_LOOP_SQL).run("loop_cog_m2_0", "idea_cog_m2_0", "Do guests count?", "2026-09-01T00:01:00Z", resolved);
    const row = () => db.query("SELECT resolved, set_by FROM open_loops WHERE id = 'loop_cog_m2_0'").get() as { resolved: number; set_by: string | null };
    setOpenLoopResolved(db, "loop_cog_m2_0", false); // the person: still open
    write(1); // v1's analysis says answered
    expect(row()).toEqual({ resolved: 0, set_by: "user" });
    setOpenLoopResolved(db, "loop_cog_m2_0", true); // the person: answered
    write(0);
    expect(row()).toEqual({ resolved: 1, set_by: "user" });
    db.prepare("UPDATE open_loops SET set_by = NULL, resolved = 0").run(); // nobody has decided: the analysis rules
    write(1);
    expect(row().resolved).toBe(1);
  });

  test("rolling back to v1 still works for an account whose backup was made before set_by existed", () => {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = seed();
    syncServing(USER, db, runShadowMining(db).ideas); // v2 takes over; v1 is saved
    expect(hasV1Backup(db)).toBe(true);
    // Make the saved copy look like one taken by an older build: no set_by column.
    db.exec("DROP TABLE v1_backup_open_loops");
    db.exec("CREATE TABLE v1_backup_open_loops AS SELECT id, idea_id, statement, created_at, resolved FROM open_loops");
    expect(() => restoreV1(db)).not.toThrow(); // a positional copy would fail on the extra column
    expect(hasV1Backup(db)).toBe(false);
    expect((db.query("SELECT COUNT(*) AS n FROM idea_nodes").get() as { n: number }).n).toBeGreaterThan(0);
  });

  const loopOf = (db: ReturnType<typeof seed>) => loadIdeas(db).flatMap((i) => i.openLoops).find((l) => l.id === "loop_cog_m2_0")!;

  test("a question Thread closed says which answer closed it", () => {
    const db = answered();
    regroup(db);
    const loop = loopOf(db);
    expect(loop.resolved).toBe(true);
    expect(loop.answeredBy).toBe("Guests count after the first five.");
  });

  test("an answer labelled resolution, with no link, is named too", () => {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = seed();
    db.prepare("UPDATE open_loops SET resolved = 0").run();
    db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('m3', 'c1', 'chatgpt', 'user', 'Guests count after the first five.', '2026-09-01T00:02:00Z', 2)").run();
    db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES ('cog_m3_0', 'resolution', 'Guests count after the first five.', 0.9, 'high', 'm3', 'Guests count')").run();
    regroup(db);
    expect(loopOf(db).answeredBy).toBe("Guests count after the first five.");
  });

  test("a question the person closed or reopened has no 'answered by' -- it is their word, not Thread's", () => {
    const db = answered();
    regroup(db);
    setOpenLoopResolved(db, "loop_cog_m2_0", false);
    regroup(db);
    expect(loopOf(db).resolved).toBe(false);
    expect(loopOf(db).answeredBy).toBeUndefined();
    setOpenLoopResolved(db, "loop_cog_m2_0", true);
    regroup(db);
    expect(loopOf(db).resolved).toBe(true);
    expect(loopOf(db).answeredBy).toBeUndefined();
  });

  test("a question closed before this was recorded just shows as answered, with no invented reason", () => {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = seed(); // its question is already resolved, origin unknown
    regroup(db);
    const loop = loopOf(db);
    expect(loop.resolved).toBe(true);
    expect(loop.answeredBy).toBeUndefined();
  });

  test("if the answer later disappears, the note goes with it", () => {
    const db = answered();
    regroup(db);
    db.prepare("UPDATE cognitive_events SET answers_event_id = NULL WHERE id = 'cog_m3_0'").run();
    regroup(db);
    expect(loopOf(db).resolved).toBe(false);
    expect(loopOf(db).answeredBy).toBeUndefined();
  });
});


describe("how a served idea is named", () => {
  const fresh = (statement: string, title: string | null) => {
    process.env.THREAD_V2_SERVING_USERS = "*";
    const db = openDb(":memory:");
    db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES ('n1', 'cn', 'chatgpt', 'user', ?, '2026-09-01T00:00:00Z', 0)").run(statement);
    db.prepare(
      "INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote, title) VALUES ('cog_n1_0', 'new_idea', ?, 0.9, 'high', 'n1', ?, ?)",
    ).run(statement, statement.slice(0, 12), title);
    syncServing(USER, db, runShadowMining(db).ideas);
    return loadIdeas(db)[0]!.title;
  };

  test("the extractor's short name is used instead of a sentence cut at eight words", () => {
    expect(fresh("I think institutional authority should be independently verifiable by anyone who relies on it.", "Verifiable authority")).toBe("Verifiable authority");
  });

  test("without one, the title is carved from the statement, without narration", () => {
    expect(fresh("They are naming 'computable Authority'", null)).toBe("Computable Authority");
  });
});
