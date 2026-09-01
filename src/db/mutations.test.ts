import { describe, expect, test } from "bun:test";
import { openDb } from "./client";
import { runPipeline, persistPipelineResult } from "../state/pipeline";
import { loadCanonicalEvents, loadCognitiveEvents, loadIdeas } from "./queries";
import { deleteIdea, renameIdea, setIdeaState, setOpenLoopResolved } from "./mutations";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";

async function seedDb() {
  const events: CanonicalEvent[] = [
    { id: "u1", conversationId: "c1", source: "fixture", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
    { id: "u2", conversationId: "c1", source: "fixture", role: "user", text: "Who enforces the boundaries though?", createdAt: "2026-08-18T00:00:00.000Z", index: 1 },
  ];
  // Both messages share conversationId "c1", so they're extracted together in one call.
  const extraction = new FakeProvider([
    JSON.stringify({
      events: [
        { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "u1", evidence_quote: "explicit boundaries" },
        { type: "open_loop", statement: "Who enforces the boundaries?", confidence: 0.8, source_event_id: "u2", evidence_quote: "Who enforces" },
      ],
    }),
  ]);
  // u1's cognitive event id is deterministic (cog_<sourceEventId>_<indexInThatExtractionCall>),
  // so its idea id (idea_<that event id>) is known ahead of time -- match u2's open_loop into it
  // so this fixture produces exactly one idea with both an evolution step and an open loop.
  const reasoning = new FakeProvider([
    JSON.stringify({ matched_idea_id: "idea_cog_u1_0", confidence: 0.9, reasoning: "scripted", also_related_idea_id: null }),
  ]);
  const result = await runPipeline(events, { extraction, reasoning });
  const db = openDb(":memory:");
  persistPipelineResult(db, events, result);
  return db;
}

describe("db/mutations (idea corrections)", () => {
  test("deleteIdea removes the idea and its dependents but preserves canonical/cognitive events", async () => {
    const db = await seedDb();
    const ideaId = loadIdeas(db)[0]?.id as string;
    const canonicalCountBefore = loadCanonicalEvents(db).length;
    const cognitiveCountBefore = loadCognitiveEvents(db).length;

    expect(deleteIdea(db, ideaId)).toBe(true);

    expect(loadIdeas(db)).toHaveLength(0);
    expect(loadCanonicalEvents(db)).toHaveLength(canonicalCountBefore); // untouched
    expect(loadCognitiveEvents(db)).toHaveLength(cognitiveCountBefore); // untouched
  });

  test("deleteIdea on an unknown id returns false rather than throwing", async () => {
    const db = await seedDb();
    expect(deleteIdea(db, "idea_does_not_exist")).toBe(false);
  });

  test("setIdeaState rejects an idea (soft) without deleting it", async () => {
    const db = await seedDb();
    const ideaId = loadIdeas(db)[0]?.id as string;
    expect(setIdeaState(db, ideaId, "rejected")).toBe(true);
    const idea = loadIdeas(db).find((i) => i.id === ideaId);
    expect(idea?.state).toBe("rejected");
    expect(idea?.evolution.length).toBeGreaterThan(0); // history preserved
  });

  test("setIdeaState throws on an invalid state instead of silently accepting it", async () => {
    const db = await seedDb();
    const ideaId = loadIdeas(db)[0]?.id as string;
    expect(() => setIdeaState(db, ideaId, "not_a_real_state" as never)).toThrow();
  });

  test("renameIdea updates the title and rejects an empty one", async () => {
    const db = await seedDb();
    const ideaId = loadIdeas(db)[0]?.id as string;
    expect(renameIdea(db, ideaId, "Computable Authority")).toBe(true);
    expect(loadIdeas(db).find((i) => i.id === ideaId)?.title).toBe("Computable Authority");
    expect(() => renameIdea(db, ideaId, "   ")).toThrow();
  });

  test("setOpenLoopResolved marks a loop resolved and can be reversed", async () => {
    const db = await seedDb();
    const idea = loadIdeas(db).find((i) => i.openLoops.length > 0) as ReturnType<typeof loadIdeas>[number];
    const loopId = idea.openLoops[0]?.id as string;

    expect(setOpenLoopResolved(db, loopId, true)).toBe(true);
    expect(loadIdeas(db).find((i) => i.id === idea.id)?.openLoops[0]?.resolved).toBe(true);

    expect(setOpenLoopResolved(db, loopId, false)).toBe(true);
    expect(loadIdeas(db).find((i) => i.id === idea.id)?.openLoops[0]?.resolved).toBe(false);
  });
});
