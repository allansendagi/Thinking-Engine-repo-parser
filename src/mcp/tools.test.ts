import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { persistPipelineResult, runPipeline } from "../state/pipeline";
import { FakeProvider } from "../providers/fake";
import { getIdea, getOpenLoops, getRecentChanges, getThreadState, searchIdeas, traceIdea } from "./tools";
import type { CanonicalEvent } from "../types";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}
function identityResponse(matchedIdeaId: string | null): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence: 0.9, reasoning: "scripted", also_related_idea_id: null });
}

async function seedDb() {
  const events: CanonicalEvent[] = [
    { id: "u1", conversationId: "conv_1", source: "fixture", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
    { id: "u2", conversationId: "conv_2", source: "fixture", role: "user", text: "Authority boundaries need to be executable, per-agent.", createdAt: "2026-08-19T00:00:00.000Z", index: 0 },
  ];

  const extraction = new FakeProvider([
    extractionResponse([{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "u1", evidence_quote: "explicit boundaries" }]),
    extractionResponse([
      { type: "open_loop", statement: "Who enforces the boundaries?", confidence: 0.8, source_event_id: "u2", evidence_quote: "boundaries need to be executable" },
    ]),
  ]);
  const reasoning = new FakeProvider([identityResponse("idea_cog_u1_0")]);

  const result = await runPipeline(events, { extraction, reasoning });
  const db = openDb(":memory:");
  persistPipelineResult(db, events, result);
  return db;
}

describe("mcp/tools against a real persisted db", () => {
  test("searchIdeas finds the idea by keyword", async () => {
    const db = await seedDb();
    const results = searchIdeas(db, "authority boundaries");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toContain("Authority");
  });

  test("getIdea returns the full node with its open loop", async () => {
    const db = await seedDb();
    const idea = getIdea(db, "idea_cog_u1_0");
    expect(idea).not.toBeNull();
    expect(idea?.openLoops).toHaveLength(1);
    expect(idea?.openLoops[0]?.statement).toBe("Who enforces the boundaries?");
  });

  test("traceIdea attaches the original source text to each evolution step", async () => {
    const db = await seedDb();
    const trace = traceIdea(db, "idea_cog_u1_0");
    expect(trace).not.toBeNull();
    // Two steps: the founding new_idea event, and the open_loop event (which also updates the
    // idea's articulation, per buildIdeaNode -- every confident match appends an evolution step
    // regardless of type, not just refinements).
    expect(trace?.provenance).toHaveLength(2);
    expect(trace?.provenance[0]?.sourceText).toBe("Authority needs explicit boundaries.");
    expect(trace?.provenance[1]?.sourceText).toBe("Authority boundaries need to be executable, per-agent.");
    // Each step carries the tool it was captured from.
    expect(trace?.provenance[0]?.source).toBe("fixture");
    expect(trace?.provenance[1]?.source).toBe("fixture");
  });

  test("getThreadState and getOpenLoops/getRecentChanges are consistent with each other", async () => {
    const db = await seedDb();
    const state = getThreadState(db);
    const openLoops = getOpenLoops(db);
    const recent = getRecentChanges(db, 365);

    expect(state.currentIdeas).toHaveLength(1);
    expect(openLoops).toHaveLength(1);
    expect(recent.length).toBeGreaterThan(0);
  });

  test("getIdea returns null for an unknown id rather than throwing", async () => {
    const db = await seedDb();
    expect(getIdea(db, "idea_does_not_exist")).toBeNull();
  });
});
