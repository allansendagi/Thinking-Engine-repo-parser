import { describe, expect, test } from "bun:test";
import { MIN_CACHEABLE_PREFIX_CHARS, buildTranscriptPromptParts } from "./prompt";
import { extractCognitiveEvents } from "./extract";
import { AnthropicProvider } from "../providers/anthropic";
import type { CompleteOptions, CompletionProvider } from "../providers/types";
import type { CanonicalEvent } from "../types";

const ev = (i: number, text = `message number ${i} with some words in it`): CanonicalEvent => ({
  id: `c1_m${i}`, conversationId: "c1", source: "chatgpt", role: i % 2 ? "assistant" : "user", text,
  createdAt: `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`, index: i,
});
const long = (i: number) => ev(i, "word ".repeat(1500)); // ~7.5K chars each

describe("a growing conversation shares its prefix (so it can be cached)", () => {
  const convo = (n: number) => Array.from({ length: n }, (_, i) => long(i));
  const call = (n: number) => buildTranscriptPromptParts(convo(n), new Set([`c1_m${n - 1}`]));

  test("the next call's prefix begins with this call's prefix byte-for-byte", () => {
    const a = call(4), b = call(5);
    expect(b.prefix.startsWith(a.prefix)).toBe(true);
    expect(b.prefix.length).toBeGreaterThan(a.prefix.length);
  });

  test("what changes every call (the new message, the count, the valid ids) comes last", () => {
    const p = call(4);
    expect(p.prefix).not.toContain("exactly");
    expect(p.rest).toContain("exactly 4 message(s)");
    expect(p.rest).toContain("c1_m3");
    expect(p.rest).toContain("[NEW] [c1_m3]");
  });

  test("a breakpoint is only asked for when there is enough stable prefix to pay for itself", () => {
    expect(call(4).cachePrefixChars).toBeGreaterThanOrEqual(MIN_CACHEABLE_PREFIX_CHARS);
    const small = buildTranscriptPromptParts([ev(0), ev(1), ev(2)], new Set(["c1_m2"]));
    expect(small.cachePrefixChars).toBe(0); // a cache write costs 1.25x; not worth it for a short prefix
    const firstSight = buildTranscriptPromptParts(convo(4)); // everything new: nothing stable to cache
    expect(firstSight.cachePrefixChars).toBe(0);
  });

  test("the whole prompt still contains every message, in order, with the right markers", () => {
    const p = call(3);
    const text = p.prefix + p.rest;
    expect(text.indexOf("[ALREADY PROCESSED] [c1_m0]")).toBeLessThan(text.indexOf("[ALREADY PROCESSED] [c1_m1]"));
    expect(text.indexOf("[ALREADY PROCESSED] [c1_m1]")).toBeLessThan(text.indexOf("[NEW] [c1_m2]"));
  });
});

describe("extraction asks for the cache only when it can pay", () => {
  const recording = () => {
    const seen: (CompleteOptions | undefined)[] = [];
    const provider: CompletionProvider = {
      async complete(_s, _u, _m, options) {
        seen.push(options);
        return JSON.stringify({ events: [] });
      },
    };
    return { provider, seen };
  };
  test("an incremental call on a long session passes the prefix length; a first-sight call does not", async () => {
    const convo = Array.from({ length: 4 }, (_, i) => long(i));
    const inc = recording();
    await extractCognitiveEvents(convo, inc.provider, new Set(["c1_m3"]));
    expect(inc.seen[0]?.cachePrefixChars).toBeGreaterThanOrEqual(MIN_CACHEABLE_PREFIX_CHARS);
    const first = recording();
    await extractCognitiveEvents(convo, first.provider);
    expect(first.seen[0]).toBeUndefined();
  });
});

describe("the Anthropic request", () => {
  const fakeClient = () => {
    const calls: any[] = [];
    const client = { messages: { create: async (args: any) => { calls.push(args); return { content: [{ type: "text", text: "{}" }], usage: {} }; } } };
    return { calls, provider: new AnthropicProvider("m", client as never) };
  };
  test("with a cache prefix: two text blocks, the stable one marked ephemeral", async () => {
    const { calls, provider } = fakeClient();
    await provider.complete("sys", "AAAAABBBBB", 100, { cachePrefixChars: 5 });
    expect(calls[0].messages[0].content).toEqual([
      { type: "text", text: "AAAAA", cache_control: { type: "ephemeral" } },
      { type: "text", text: "BBBBB" },
    ]);
  });
  test("without one (or one that is the whole message): the plain string, as before", async () => {
    const { calls, provider } = fakeClient();
    await provider.complete("sys", "hello", 100);
    await provider.complete("sys", "hello", 100, { cachePrefixChars: 5 });
    expect(calls[0].messages[0].content).toBe("hello");
    expect(calls[1].messages[0].content).toBe("hello");
  });
});
