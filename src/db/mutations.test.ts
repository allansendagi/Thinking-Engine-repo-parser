import { describe, expect, test } from "bun:test";
import { openDb } from "./client";
import { runPipeline, persistPipelineResult } from "../state/pipeline";
import { loadCanonicalEvents, loadCognitiveEvents, loadIdeas } from "./queries";
import {
  deleteIdea,
  mergeIdeas,
  renameIdea,
  setIdeaState,
  setOpenLoopResolved,
} from "./mutations";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";

async function seedDb() {
  const events: CanonicalEvent[] = [
    {
      id: "u1",
      conversationId: "c1",
      source: "fixture",
      role: "user",
      text: "Authority needs explicit boundaries.",
      createdAt: "2026-08-17T00:00:00.000Z",
      index: 0,
    },
    {
      id: "u2",
      conversationId: "c1",
      source: "fixture",
      role: "user",
      text: "Who enforces the boundaries though?",
      createdAt: "2026-08-18T00:00:00.000Z",
      index: 1,
    },
  ];
  // Both messages share conversationId "c1", so they're extracted together in one call.
  const extraction = new FakeProvider([
    JSON.stringify({
      events: [
        {
          type: "new_idea",
          statement: "Authority needs explicit boundaries.",
          confidence: 0.9,
          source_event_id: "u1",
          evidence_quote: "explicit boundaries",
        },
        {
          type: "open_loop",
          statement: "Who enforces the boundaries?",
          confidence: 0.8,
          source_event_id: "u2",
          evidence_quote: "Who enforces",
        },
      ],
    }),
  ]);
  // u1's cognitive event id is deterministic (cog_<sourceEventId>_<indexInThatExtractionCall>),
  // so its idea id (idea_<that event id>) is known ahead of time -- match u2's open_loop into it
  // so this fixture produces exactly one idea with both an evolution step and an open loop.
  const reasoning = new FakeProvider([
    JSON.stringify({
      matched_idea_id: "idea_cog_u1_0",
      confidence: 0.9,
      reasoning: "scripted",
      also_related_idea_id: null,
    }),
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
    expect(() =>
      setIdeaState(db, ideaId, "not_a_real_state" as never),
    ).toThrow();
  });

  test("renameIdea updates the title and rejects an empty one", async () => {
    const db = await seedDb();
    const ideaId = loadIdeas(db)[0]?.id as string;
    expect(renameIdea(db, ideaId, "Computable Authority")).toBe(true);
    expect(loadIdeas(db).find((i) => i.id === ideaId)?.title).toBe(
      "Computable Authority",
    );
    expect(() => renameIdea(db, ideaId, "   ")).toThrow();
  });

  test("setOpenLoopResolved marks a loop resolved and can be reversed", async () => {
    const db = await seedDb();
    const idea = loadIdeas(db).find(
      (i) => i.openLoops.length > 0,
    ) as ReturnType<typeof loadIdeas>[number];
    const loopId = idea.openLoops[0]?.id as string;

    expect(setOpenLoopResolved(db, loopId, true)).toBe(true);
    expect(
      loadIdeas(db).find((i) => i.id === idea.id)?.openLoops[0]?.resolved,
    ).toBe(true);

    expect(setOpenLoopResolved(db, loopId, false)).toBe(true);
    expect(
      loadIdeas(db).find((i) => i.id === idea.id)?.openLoops[0]?.resolved,
    ).toBe(false);
  });
});

/**
 * Two ideas from two conversations. Idea A (idea_cog_u1_0): new_idea then a decision (-> state
 * "established"), dated first. Idea B (idea_cog_u3_0): new_idea then a rejection (-> "rejected"),
 * dated after A. Reasoning is scripted to keep them separate so a test can merge them.
 */
async function seedTwoIdeas() {
  const events: CanonicalEvent[] = [
    {
      id: "u1",
      conversationId: "cA",
      source: "fixture",
      role: "user",
      text: "Authority needs explicit boundaries.",
      createdAt: "2026-08-01T00:00:00.000Z",
      index: 0,
    },
    {
      id: "u2",
      conversationId: "cA",
      source: "fixture",
      role: "user",
      text: "We will require explicit boundaries.",
      createdAt: "2026-08-02T00:00:00.000Z",
      index: 1,
    },
    {
      id: "u3",
      conversationId: "cB",
      source: "fixture",
      role: "user",
      text: "The boundary model is the right foundation for authority.",
      createdAt: "2026-08-03T00:00:00.000Z",
      index: 0,
    },
    {
      id: "u4",
      conversationId: "cB",
      source: "fixture",
      role: "user",
      text: "Boundaries are the wrong frame entirely.",
      createdAt: "2026-08-04T00:00:00.000Z",
      index: 1,
    },
  ];
  const extraction = new FakeProvider([
    JSON.stringify({
      events: [
        {
          type: "new_idea",
          statement: "Authority needs explicit boundaries.",
          confidence: 0.9,
          source_event_id: "u1",
          evidence_quote: "explicit boundaries",
        },
        {
          type: "decision",
          statement: "We will require explicit boundaries.",
          confidence: 0.9,
          source_event_id: "u2",
          evidence_quote: "require explicit boundaries",
        },
      ],
    }),
    JSON.stringify({
      events: [
        {
          type: "new_idea",
          statement:
            "The boundary model is the right foundation for authority.",
          confidence: 0.9,
          source_event_id: "u3",
          evidence_quote: "right foundation for authority",
        },
        {
          type: "rejection",
          statement: "Boundaries are the wrong frame entirely.",
          confidence: 0.9,
          source_event_id: "u4",
          evidence_quote: "wrong frame entirely",
        },
      ],
    }),
  ]);
  // resolveIdentity only calls the provider when there ARE candidates, so u1 (the first event,
  // no candidates yet) consumes nothing. Responses map to u2, u3, u4 in that order.
  const reasoning = new FakeProvider([
    JSON.stringify({
      matched_idea_id: "idea_cog_u1_0",
      confidence: 0.95,
      reasoning: "same as A",
      also_related_idea_id: null,
    }),
    JSON.stringify({
      matched_idea_id: null,
      confidence: 0,
      reasoning: "distinct from A",
      also_related_idea_id: null,
    }),
    JSON.stringify({
      matched_idea_id: "idea_cog_u3_0",
      confidence: 0.95,
      reasoning: "same as B",
      also_related_idea_id: null,
    }),
  ]);
  const result = await runPipeline(events, { extraction, reasoning });
  const db = openDb(":memory:");
  persistPipelineResult(db, events, result);
  return db;
}

describe("db/mutations · mergeIdeas", () => {
  const A = "idea_cog_u1_0";
  const B = "idea_cog_u3_0";

  test("the fixture produces two separate ideas with the expected states", async () => {
    const db = await seedTwoIdeas();
    const ideas = loadIdeas(db);
    expect(ideas.map((i) => i.id).sort()).toEqual([A, B].sort());
    expect(ideas.find((i) => i.id === A)?.state).toBe("established"); // new_idea + decision
    expect(ideas.find((i) => i.id === B)?.state).toBe("rejected"); // new_idea + rejection
  });

  test("merges B into A: B is gone, every evolution step is on A, source events untouched", async () => {
    const db = await seedTwoIdeas();
    const canonicalBefore = loadCanonicalEvents(db).length;
    const cognitiveBefore = loadCognitiveEvents(db).length;

    const r = mergeIdeas(db, A, B);
    expect(r.movedEvolutionSteps).toBe(2);
    expect(r.sharedEvolutionSteps).toBe(0);

    const ideas = loadIdeas(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.id).toBe(A);
    expect(ideas[0]?.evolution).toHaveLength(4);
    expect(loadCanonicalEvents(db)).toHaveLength(canonicalBefore); // §30: source evidence untouched
    expect(loadCognitiveEvents(db)).toHaveLength(cognitiveBefore);
  });

  test("state is replayed over the merged sequence, not taken from the kept idea", async () => {
    const db = await seedTwoIdeas();
    // A is 'established'. B's rejection is the latest step in the merged timeline, so the merged
    // idea must end 'rejected' -- proof the state machine is replayed, not that 'keep' wins.
    mergeIdeas(db, A, B);
    const merged = loadIdeas(db)[0];
    expect(merged?.state).toBe("rejected");
    expect(merged?.currentFormulation).toBe(
      "Boundaries are the wrong frame entirely.",
    );
    expect(merged?.createdAt).toBe("2026-08-01T00:00:00.000Z"); // earliest step
    expect(merged?.updatedAt).toBe("2026-08-04T00:00:00.000Z"); // latest step
  });

  test("a cognitive event that already backs the kept idea is not moved or lost", async () => {
    const db = await seedTwoIdeas();
    // Force a shared step: make cog_u1_0 (already on A) also back B.
    db.prepare(
      "INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)",
    ).run(B, "cog_u1_0", "shared step", "2026-08-03T12:00:00.000Z", "u1");

    const r = mergeIdeas(db, A, B);
    expect(r.sharedEvolutionSteps).toBe(1);
    expect(r.movedEvolutionSteps).toBe(2); // u3, u4 -- not the shared u1

    const merged = loadIdeas(db)[0];
    expect(merged?.evolution).toHaveLength(4); // u1, u2, u3, u4 -- one copy of u1
    expect(
      merged?.evolution.filter((e) => e.cognitiveEventId === "cog_u1_0"),
    ).toHaveLength(1);
  });

  test("collapses a duplicated open loop carried by both twins", async () => {
    const db = await seedTwoIdeas();
    db.prepare(
      "INSERT INTO open_loops (id, idea_id, statement, created_at, resolved) VALUES (?, ?, ?, ?, 0)",
    ).run(
      "loop_a",
      A,
      "Who enforces the boundary?",
      "2026-08-01T06:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO open_loops (id, idea_id, statement, created_at, resolved) VALUES (?, ?, ?, ?, 0)",
    ).run(
      "loop_b",
      B,
      "who enforces the boundary?",
      "2026-08-03T06:00:00.000Z",
    );

    const r = mergeIdeas(db, A, B);
    expect(r.movedOpenLoops).toBe(1);
    expect(r.dedupedOpenLoops).toBe(1);
    expect(loadIdeas(db)[0]?.openLoops).toHaveLength(1);
  });

  test("rejects a no-op or unknown merge instead of corrupting state", async () => {
    const db = await seedTwoIdeas();
    expect(() => mergeIdeas(db, A, A)).toThrow();
    expect(() => mergeIdeas(db, A, "idea_missing")).toThrow();
    expect(() => mergeIdeas(db, "idea_missing", B)).toThrow();
    expect(loadIdeas(db)).toHaveLength(2); // nothing changed
  });
});
