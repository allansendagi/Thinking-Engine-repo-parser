import { describe, expect, test } from "bun:test";
import { runPipeline } from "./pipeline";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}
function identityResponse(matchedIdeaId: string | null): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence: 0.9, reasoning: "scripted", also_related_idea_id: null });
}

const msg1: CanonicalEvent = {
  id: "m1",
  conversationId: "conv_1",
  source: "fixture",
  role: "user",
  text: "Authority needs explicit boundaries.",
  createdAt: "2026-08-17T00:00:00.000Z",
  index: 0,
};
const msg2: CanonicalEvent = {
  id: "m2",
  conversationId: "conv_1",
  source: "fixture",
  role: "user",
  text: "Those boundaries need to be executable, not just written policy.",
  createdAt: "2026-08-19T00:00:00.000Z",
  index: 1,
};

describe("incremental capture (a live conversation growing across multiple API calls)", () => {
  test("a second call for the same conversation extends the idea instead of duplicating it", async () => {
    // Call 1: only msg1 exists yet.
    const extraction1 = new FakeProvider([
      extractionResponse([
        { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
      ]),
    ]);
    const reasoning1 = new FakeProvider([]); // no candidates yet -- must not be called
    const result1 = await runPipeline([msg1], { extraction: extraction1, reasoning: reasoning1 });
    expect(result1.ideas.size).toBe(1);
    const ideaId = [...result1.ideas.keys()][0] as string;

    // Call 2: msg2 just arrived. msg1 is sent again for CONTEXT ONLY (newEventIds = {m2}).
    const extraction2 = new FakeProvider([
      extractionResponse([
        {
          type: "refinement",
          statement: "Boundaries need to be executable.",
          confidence: 0.9,
          source_event_id: "m2",
          evidence_quote: "need to be executable",
        },
      ]),
    ]);
    const reasoning2 = new FakeProvider([identityResponse(ideaId)]);

    const result2 = await runPipeline([msg1, msg2], { extraction: extraction2, reasoning: reasoning2 }, {
      existingIdeas: result1.ideas,
      newEventIds: new Set(["m2"]),
    });

    expect(result2.ideas.size).toBe(1); // extended, not duplicated
    const idea = result2.ideas.get(ideaId);
    expect(idea?.evolution).toHaveLength(2);
    expect(idea?.currentFormulation).toBe("Boundaries need to be executable.");
  });

  test("a model that ignores the [ALREADY PROCESSED] marking and re-extracts msg1 is blocked deterministically", async () => {
    const result1Ideas = new Map();
    const seedExtraction = new FakeProvider([
      extractionResponse([
        { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
      ]),
    ]);
    const result1 = await runPipeline([msg1], { extraction: seedExtraction, reasoning: new FakeProvider([]) }, { existingIdeas: result1Ideas });

    // The (fake) model misbehaves: it returns an event for m1 (already processed) alongside m2.
    const misbehavingExtraction = new FakeProvider([
      extractionResponse([
        { type: "claim", statement: "Re-derived from m1 again.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
        { type: "refinement", statement: "Boundaries need to be executable.", confidence: 0.9, source_event_id: "m2", evidence_quote: "need to be executable" },
      ]),
    ]);
    const ideaId = [...result1.ideas.keys()][0] as string;
    const reasoning = new FakeProvider([identityResponse(ideaId)]);

    const result2 = await runPipeline([msg1, msg2], { extraction: misbehavingExtraction, reasoning }, {
      existingIdeas: result1.ideas,
      newEventIds: new Set(["m2"]),
    });

    // Only the legitimate m2 event survived; the m1 re-extraction was rejected, not silently kept.
    expect(result2.cognitiveEvents).toHaveLength(1);
    expect(result2.cognitiveEvents[0]?.sourceEventId).toBe("m2");
    expect(result2.rejectedExtractions).toHaveLength(1);
    expect(result2.rejectedExtractions[0]?.reason).toContain("already-processed");
  });
});
