import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { completeJson, extractJson } from "./json";
import type { CompletionProvider } from "./types";

const schema = z.object({ events: z.array(z.string()) });

function scripted(replies: string[]): CompletionProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(_s, user) {
      prompts.push(user);
      const r = replies.shift();
      if (r === undefined) throw new Error("out of replies");
      return r;
    },
  };
}

describe("extractJson", () => {
  test("reads a fenced block, a bare object, or an object wrapped in prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} -- hope that helps')).toEqual({ a: 1 });
  });
});

describe("completeJson", () => {
  test("valid first reply: one call", async () => {
    const p = scripted(['{"events":["x"]}']);
    expect(await completeJson(p, "s", "u", 100, schema)).toEqual({ events: ["x"] });
    expect(p.prompts).toHaveLength(1);
  });

  test("malformed first reply gets one corrective retry", async () => {
    const p = scripted(['{"events": [unterminated', '{"events":[]}']);
    expect(await completeJson(p, "s", "u", 100, schema)).toEqual({ events: [] });
    expect(p.prompts[1]).toContain("could not be used");
  });

  test("a second bad reply still throws, so the caller's retry path takes over", async () => {
    const p = scripted(["nope", "still nope"]);
    await expect(completeJson(p, "s", "u", 100, schema)).rejects.toThrow();
  });
});
