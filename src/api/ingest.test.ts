import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { loadIdeas } from "../db/queries";
import { ingestConversation } from "./ingest";
import { FakeProvider } from "../providers/fake";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}
function identityResponse(matchedIdeaId: string | null): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence: 0.9, reasoning: "scripted", also_related_idea_id: null });
}

describe("ingestConversation against a real DB (simulates repeated HTTP calls as a chat grows)", () => {
  test("re-sending the same transcript twice is a no-op the second time", async () => {
    const db = openDb(":memory:");
    const providers = {
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    };

    const input = {
      conversationId: "conv_1",
      source: "fixture" as const,
      messages: [{ id: "m1", role: "user" as const, text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
    };

    const first = await ingestConversation(db, input, providers);
    expect(first.newCanonicalEvents).toBe(1);
    expect(first.ideaCount).toBe(1);

    // Same exact call again -- extraction/reasoning providers have nothing left scripted, so if
    // ingestConversation tried to call either, this would throw. It shouldn't: no new messages.
    const second = await ingestConversation(db, input, providers);
    expect(second.newCanonicalEvents).toBe(0);
    expect(second.newCognitiveEvents).toBe(0);
    expect(loadIdeas(db)).toHaveLength(1); // still exactly one idea, not duplicated
  });

  test("a medium claim discarded for lack of a match is replayed once its idea arrives on a later call", async () => {
    const db = openDb(":memory:");

    // Call 1: a medium-persistence claim arrives BEFORE the idea it belongs to. Nothing to attach
    // to, so the signal gate discards it. newEventIds guarantees extraction never re-emits m1, so
    // without the replay pass this would be a permanent loss.
    const call1 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [{ id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" }],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "claim", statement: "Authority boundaries should be enforced at runtime.", confidence: 0.9, persistence: "medium", source_event_id: "m1", evidence_quote: "enforced at runtime" },
          ]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );
    expect(call1.ideaCount).toBe(0);
    expect(call1.discardedEvents).toBe(1);
    expect(loadIdeas(db)).toHaveLength(0);

    // Call 2: the founding idea arrives. The replay pass reconsiders the m1 discard against the
    // now-current idea set, finds a strong match, and promotes it.
    const call2 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user", text: "Authority boundaries must be explicit and enforced.", createdAt: "2026-08-18T00:00:00.000Z" },
        ],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "new_idea", statement: "Authority boundaries must be explicit and enforced.", confidence: 0.95, source_event_id: "m2", evidence_quote: "Authority boundaries" },
          ]),
        ]),
        // Exactly one identity call: the replay pass resolving the promoted m1 claim. The m2
        // new_idea has no candidates yet, so identity is skipped for it.
        reasoning: new FakeProvider([identityResponse("idea_cog_m2_0")]),
      },
    );

    expect(call2.promotedFromDiscard).toBe(1);
    expect(call2.ideaCount).toBe(1);
    const ideas = loadIdeas(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.evolution.map((e) => e.sourceEventId).sort()).toEqual(["m1", "m2"]);
  });

  test("a growing conversation extends the same idea across three separate calls", async () => {
    const db = openDb(":memory:");

    const call1 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [{ id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" }]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );
    expect(call1.ideaCount).toBe(1);
    const ideaId = loadIdeas(db)[0]?.id as string;

    const call2 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user", text: "Those boundaries need to be executable.", createdAt: "2026-08-19T00:00:00.000Z" },
        ],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([{ type: "refinement", statement: "Boundaries need to be executable.", confidence: 0.9, source_event_id: "m2", evidence_quote: "need to be executable" }]),
        ]),
        reasoning: new FakeProvider([identityResponse(ideaId)]),
      },
    );
    expect(call2.newCanonicalEvents).toBe(1); // only m2 was new
    expect(call2.ideaCount).toBe(1); // still one idea, extended

    const finalIdeas = loadIdeas(db);
    expect(finalIdeas).toHaveLength(1);
    expect(finalIdeas[0]?.evolution).toHaveLength(2);
    expect(finalIdeas[0]?.currentFormulation).toBe("Boundaries need to be executable.");
  });
});
