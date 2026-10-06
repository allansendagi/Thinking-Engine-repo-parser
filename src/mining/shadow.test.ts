import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { storeThoughtVectors } from "../db/thoughts";
import { loadShadowIdeas, runShadowMining } from "./shadow";

function seed() {
  const db = openDb(":memory:");
  const ev = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES (?, ?, 'chatgpt', 'user', ?, ?, ?)");
  const cog = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES (?, ?, ?, 0.9, ?, ?, ?)");
  ev.run("m1", "c1", "Let's charge per seat.", "2026-09-01T00:00:00Z", 0);
  ev.run("m2", "c1", "Do guests count toward the bill?", "2026-09-01T00:01:00Z", 2);
  ev.run("m3", "c2", "Can you make that a table?", "2026-09-03T00:00:00Z", 0);
  cog.run("cog_m1_0", "new_idea", "Charge per seat.", "high", "m1", "charge per seat");
  cog.run("cog_m2_0", "question", "Do guests count toward the bill?", "high", "m2", "Do guests count");
  db.prepare("INSERT INTO discarded_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote, gate_reason, gate_version, discarded_at) VALUES (?, 'claim', ?, 0.9, 'low', ?, ?, 'low', 2, '2026-09-03')")
    .run("cog_m3_0", "Format it as a table.", "m3", "make that a table");
  return db;
}

describe("shadow v2 mining", () => {
  test("recomputes ideas from stored thoughts into the shadow view, leaving serving untouched", () => {
    const db = seed();
    const { run } = runShadowMining(db);
    expect(run.thoughts).toBe(2); // the low-persistence formatting ask never joins an idea
    expect(run.vectorModel).toBeNull();
    const shadow = loadShadowIdeas(db);
    const idea = shadow.find((i) => !i.isSpark)!;
    expect(idea.thoughtIds).toEqual(["cog_m1_0", "cog_m2_0"]);
    expect(idea.node.openLoops[0]!.statement).toBe("Do guests count toward the bill?");
    expect((db.query("SELECT COUNT(*) AS n FROM idea_nodes").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM mining_runs").get() as { n: number }).n).toBe(1);
  });

  test("uses on-device Apple vectors when the Mac has uploaded them, never a cloud model", () => {
    const db = seed();
    storeThoughtVectors(db, "voyage:voyage-3.5-lite", [{ id: "cog_m1_0", vector: Array(16).fill(1) }]);
    storeThoughtVectors(db, "apple:nlcontextual.r1", [
      { id: "cog_m1_0", vector: Array.from({ length: 16 }, (_, i) => i) },
      { id: "cog_m2_0", vector: Array.from({ length: 16 }, (_, i) => i + 1) },
    ]);
    expect(runShadowMining(db).run.vectorModel).toBe("apple:nlcontextual.r1");
  });
});
