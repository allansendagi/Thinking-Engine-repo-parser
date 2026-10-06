import { describe, expect, test } from "bun:test";
import { standardSuite } from "./generate";
import { checkCoverage, latencySummary, onDeviceMiner, type OnDeviceResults } from "./onDevice";
import { runBench } from "./run";

/** What a perfect on-device model would write for a scenario: one idea per gold idea, no ideas from noise. */
function perfectResults(): { results: OnDeviceResults; scenarios: ReturnType<typeof standardSuite> } {
  const scenarios = standardSuite([4]);
  const results: OnDeviceResults = {
    model: "test-model",
    scenarios: scenarios.map((s) => {
      const goldByMessage = new Map(s.thoughts.map((t) => [t.messageId, t]));
      return {
        scenario: s.name,
        captures: s.events
          .filter((e) => e.role === "user")
          .map((e) => {
            const g = goldByMessage.get(e.id);
            return {
              id: e.id,
              ideaId: g ? `idea_${g.idea}` : null,
              title: g ? g.statement.split(/\s+/).slice(0, 5).join(" ") : null,
              formulation: g ? g.said : null,
              state: g ? "developing" : null,
              openQuestion: null,
              ms: 100,
            };
          }),
      };
    }),
  };
  return { results, scenarios };
}

describe("on-device bench results", () => {
  test("a perfect run scores perfectly on capture and noise, through the same scorer as the cloud", async () => {
    const { results, scenarios } = perfectResults();
    expect(checkCoverage(results, scenarios)).toBeNull();
    const [r] = await runBench([onDeviceMiner(results)], scenarios);
    expect(r!.report.thoughtRecall).toBe(1);
    expect(r!.report.noiseRate).toBe(0);
    // The on-device model records no decisions: that row must not be generously filled in.
    expect(r!.report.decisionRecall).toBe(0);
  });

  test("results from another corpus or a partial run are refused, not scored", () => {
    const { results, scenarios } = perfectResults();
    const partial: OnDeviceResults = { ...results, scenarios: results.scenarios.slice(1) };
    expect(checkCoverage(partial, scenarios)).toContain("no on-device results for scenario");
    const stale: OnDeviceResults = {
      ...results,
      scenarios: results.scenarios.map((s, i) => (i === 0 ? { ...s, captures: s.captures.map((c) => ({ ...c, id: `old_${c.id}` })) } : s)),
    };
    expect(checkCoverage(stale, scenarios)).toContain("don't belong to this corpus");
    const short: OnDeviceResults = {
      ...results,
      scenarios: results.scenarios.map((s, i) => (i === 0 ? { ...s, captures: s.captures.slice(1) } : s)),
    };
    expect(checkCoverage(short, scenarios)).toContain("cover");
  });

  test("a capture the model gave no answer for is simply not captured", async () => {
    const { results, scenarios } = perfectResults();
    const first = results.scenarios[0]!;
    const answered = first.captures.find((c) => c.ideaId)!;
    answered.ideaId = null;
    const out = await onDeviceMiner(results).mine(scenarios[0]!);
    expect(out.ideas.flatMap((i) => i.messageIds)).not.toContain(answered.id);
    expect(latencySummary(results).answered).toBeLessThan(latencySummary(results).total);
  });
});
