import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";
import { extractCognitiveEvents } from "./extract";

const ev = (index: number, role: "user" | "assistant", text: string, conversationId = "c1"): CanonicalEvent => ({
  id: `${conversationId}_m${index}`,
  conversationId,
  source: "chatgpt",
  role,
  text,
  createdAt: `2026-09-01T00:0${index}:00.000Z`,
  index,
});

const convo: CanonicalEvent[] = [
  ev(0, "user", "How should we price this?"),
  ev(1, "assistant", "You could bill per active member, so price tracks real usage."),
  ev(2, "user", "Yes, let's do that -- per active member it is."),
  ev(3, "assistant", "Another idea: a flat fee for small teams."),
  ev(4, "user", "Unrelated: what's a good font for slides?"),
  ev(5, "user", "And go with annual plans only."),
];

const event = (over: Record<string, unknown>) => ({
  type: "decision",
  statement: "Bill per active member.",
  confidence: 0.9,
  source_event_id: "c1_m2",
  evidence_quote: "per active member it is",
  ...over,
});

async function run(...events: Record<string, unknown>[]) {
  return extractCognitiveEvents(convo, new FakeProvider([JSON.stringify({ events })]));
}

describe("adoption grounding", () => {
  test("accepts an AI proposal quoted verbatim from the message right before the acceptance", async () => {
    const out = await run(event({ adopted_from_event_id: "c1_m1", adopted_quote: "bill per active member" }));
    expect(out.rejected).toEqual([]);
    expect(out.events[0]!.adoptedFrom).toEqual({ sourceEventId: "c1_m1", quote: "bill per active member" });
  });

  test("rejects a quote the AI never said", async () => {
    const out = await run(event({ adopted_from_event_id: "c1_m1", adopted_quote: "charge per seat" }));
    expect(out.events).toEqual([]);
    expect(out.rejected[0]!.reason).toContain("verbatim");
  });

  test("rejects an AI message that isn't right before the acceptance", async () => {
    const out = await run(
      event({ source_event_id: "c1_m5", evidence_quote: "annual plans only", adopted_from_event_id: "c1_m1", adopted_quote: "bill per active member" }),
    );
    expect(out.events).toEqual([]);
    expect(out.rejected[0]!.reason).toContain("right before");
  });

  test("rejects pointing at the person's own message, or an AI message after it", async () => {
    const own = await run(event({ adopted_from_event_id: "c1_m0", adopted_quote: "price this" }));
    expect(own.rejected[0]!.reason).toContain("assistant message");
    const later = await run(event({ adopted_from_event_id: "c1_m3", adopted_quote: "a flat fee" }));
    expect(later.rejected[0]!.reason).toContain("right before");
  });

  test("roles are kept on claims only", async () => {
    const out = await run(
      event({ type: "claim", statement: "Per-member billing is one option.", role: "option" }),
      event({ type: "decision", role: "option" }),
    );
    expect(out.events.map((e) => e.role)).toEqual(["option", undefined]);
  });

  test("an odd field or one malformed event never sinks the capture", async () => {
    const out = await run(
      event({ type: "question", statement: "Do guests count?", evidence_quote: "per active member it is", role: "question" }),
      event({ title: "x".repeat(200), why_it_matters: "" }),
      { type: "claim" }, // missing everything -- dropped on its own
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[0]!.role).toBeUndefined();
    expect(out.events[1]!.title).toBeUndefined();
  });
});
