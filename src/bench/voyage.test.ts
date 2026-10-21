import { describe, expect, test } from "bun:test";
import { meaningWeightFor } from "../mining/consolidate";
import { standardSuite } from "./generate";
import { ALL_SEEDS, loadBenchVectors, loadVoyageBenchVectors, v2Miner } from "./miners";
import { runBench } from "./run";

/**
 * The quality floor for idea grouping, scored on the thinking bench with Voyage's stored vectors
 * (offline, free, identical every run). The floors sit just under today's measured numbers: a change
 * that makes grouping worse fails here instead of shipping. Raise them when quality improves.
 * Tuned seeds (1-3) are what the thresholds were chosen on; held-out seeds (4-11) are the honest score.
 */
const TUNED = standardSuite([1, 2, 3]);
const HELD_OUT = standardSuite([4, 5, 6, 7, 8, 9, 10, 11]);
const voyage = loadVoyageBenchVectors();

describe("idea grouping quality (Voyage, offline)", () => {
  test("the stored vectors cover every text on every seed -- nothing silently scores as words-only", () => {
    expect(voyage).not.toBeNull();
    const needed = new Set(standardSuite(ALL_SEEDS).flatMap((s) => s.thoughts.map((t) => t.said)));
    for (const t of needed) expect(voyage!.byText.has(t)).toBe(true);
  });

  test("held-out seeds hold the floor", async () => {
    const [r] = await runBench([v2Miner("voyage", voyage!.byText)], HELD_OUT);
    const m = r!.report;
    expect(m.groupingF1).toBeGreaterThanOrEqual(0.84); // 0.848 when set
    expect(m.groupingRecall).toBeGreaterThanOrEqual(0.76); // kept together what's one idea: 0.769
    expect(m.ideasSplitRate).toBeLessThanOrEqual(0.47); // split into duplicates: 0.458
    expect(m.wrongMerges).toBeLessThanOrEqual(19); // 18
    expect(m.criticalMerges).toBeLessThanOrEqual(2); // look-alike ideas joined: 2
    expect(m.noiseRate).toBe(0);
  });

  test("tuned seeds hold the floor", async () => {
    const [r] = await runBench([v2Miner("voyage", voyage!.byText)], TUNED);
    const m = r!.report;
    expect(m.groupingF1).toBeGreaterThanOrEqual(0.85); // 0.861
    expect(m.wrongMerges).toBeLessThanOrEqual(9); // 8
    expect(m.criticalMerges).toBeLessThanOrEqual(1);
  });

  test("whatever measures best wins: Voyage still beats words alone and the on-device model", async () => {
    const [words, cloud] = await runBench([v2Miner("words", null), v2Miner("voyage", voyage!.byText)], HELD_OUT);
    expect(cloud!.report.groupingF1).toBeGreaterThan(words!.report.groupingF1);
    const apple = loadBenchVectors();
    if (apple) {
      const [device] = await runBench([v2Miner("apple", apple.byText, { meaningWeight: meaningWeightFor(apple.model) })], HELD_OUT);
      // If this fails, the on-device model has caught up: raise meaningWeightFor for it (consolidate.ts)
      // so it can stand alone, and update the privacy page -- nothing would need to leave the Mac.
      expect(cloud!.report.groupingF1).toBeGreaterThan(device!.report.groupingF1);
    }
  });
});
