import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../types";
import type { CompletionProvider } from "../providers/types";
import { EXTRACTION_CHAR_BUDGET, extractCognitiveEvents, planExtractionCalls } from "./extract";
import { buildTranscriptPrompt, MAX_PROMPT_MESSAGE_CHARS } from "./prompt";

const msg = (i: number, len: number, role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant"): CanonicalEvent => ({
  id: `m${i}`,
  conversationId: "c1",
  source: "fixture",
  role,
  text: `msg ${i} `.padEnd(len, "x"),
  createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  index: i,
});

describe("planExtractionCalls", () => {
  test("a transcript under budget stays a single call with the original arguments", () => {
    const events = [msg(0, 200), msg(1, 200)];
    const ids = new Set(["m1"]);
    const calls = planExtractionCalls(events, ids);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context).toBe(events);
    expect(calls[0]!.newIds).toBe(ids);
  });

  test("a long live transcript with one new turn sends only recent context, within budget", () => {
    const events = Array.from({ length: 400 }, (_, i) => msg(i, 1_000));
    const calls = planExtractionCalls(events, new Set(["m399"]));
    expect(calls).toHaveLength(1);
    const ctx = calls[0]!.context;
    expect(ctx[ctx.length - 1]!.id).toBe("m399");
    expect([...calls[0]!.newIds!]).toEqual(["m399"]);
    expect(ctx.length).toBeLessThan(events.length);
    // Context is the contiguous run just before the new message, in order.
    expect(ctx.map((e) => e.index)).toEqual(ctx.map((_, k) => 400 - ctx.length + k));
    expect(ctx.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(EXTRACTION_CHAR_BUDGET);
  });

  test("a long first capture is chunked so every new message is extracted exactly once", () => {
    const events = Array.from({ length: 300 }, (_, i) => msg(i, 1_500));
    const calls = planExtractionCalls(events);
    expect(calls.length).toBeGreaterThan(1);
    const covered = calls.flatMap((c) => [...c.newIds!]);
    expect(covered).toEqual(events.map((e) => e.id));
    for (const c of calls) {
      expect(c.context.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(EXTRACTION_CHAR_BUDGET);
    }
  });

  test("one enormous message is capped in the prompt, so it doesn't force chunking", () => {
    const events = [msg(0, 200), msg(1, 500_000), msg(2, 200)];
    const calls = planExtractionCalls(events);
    expect(calls).toHaveLength(1);
    expect(buildTranscriptPrompt(calls[0]!.context).length).toBeLessThan(EXTRACTION_CHAR_BUDGET);
  });
});

describe("buildTranscriptPrompt", () => {
  test("truncates a huge message in the prompt", () => {
    const prompt = buildTranscriptPrompt([msg(0, MAX_PROMPT_MESSAGE_CHARS * 3)]);
    expect(prompt.length).toBeLessThan(MAX_PROMPT_MESSAGE_CHARS + 500);
    expect(prompt).toContain("[…message truncated]");
  });
});

describe("extractCognitiveEvents over a long transcript", () => {
  test("merges grounded events from every chunk and never exceeds the budget per call", async () => {
    const events = Array.from({ length: 200 }, (_, i) => msg(i, 1_500, i % 2 === 0 ? "user" : "assistant"));
    const promptSizes: number[] = [];
    const provider: CompletionProvider = {
      async complete(_system, user) {
        promptSizes.push(user.length);
        // Extract one event from the first [NEW] user message in this call's prompt.
        const m = user.match(/\[NEW\] \[(m\d+)\] \(user,/);
        const id = m?.[1];
        return JSON.stringify({
          events: id
            ? [{
                type: "new_idea",
                statement: `idea from ${id}`,
                title: null,
                confidence: 0.9,
                persistence: "high",
                persistence_reason: null,
                source_event_id: id,
                evidence_quote: `msg ${id.slice(1)}`,
                why_it_matters: null,
                additional_source_event_ids: [],
              }]
            : [],
        });
      },
    };
    const outcome = await extractCognitiveEvents(events, provider);
    expect(promptSizes.length).toBeGreaterThan(1);
    for (const size of promptSizes) expect(size).toBeLessThan(EXTRACTION_CHAR_BUDGET * 1.2);
    expect(outcome.events.length).toBe(promptSizes.length);
    expect(new Set(outcome.events.map((e) => e.sourceEventId)).size).toBe(outcome.events.length);
  });
});
