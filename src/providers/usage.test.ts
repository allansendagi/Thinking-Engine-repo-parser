import { describe, expect, test } from "bun:test";
import { aiUsageTotals, recordUsage } from "./anthropic";

describe("recordUsage", () => {
  test("accumulates per model and tolerates missing fields", () => {
    const before = aiUsageTotals()["m-test"] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    recordUsage("m-test", { input_tokens: 100, output_tokens: 20 });
    recordUsage("m-test", { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 40 });
    const after = aiUsageTotals()["m-test"]!;
    expect(after.calls - before.calls).toBe(2);
    expect(after.input - before.input).toBe(150);
    expect(after.output - before.output).toBe(25);
    expect(after.cacheRead - before.cacheRead).toBe(40);
  });

  test("never throws, even on a missing usage object", () => {
    expect(() => recordUsage("m-test", undefined)).not.toThrow();
  });
});
