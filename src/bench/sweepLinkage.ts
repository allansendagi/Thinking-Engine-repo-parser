#!/usr/bin/env bun
// Does comparing groups by more than their average fix split ideas without joining different ones?
// Pick on the TUNED seeds (1-3); confirm on the HELD-OUT seeds (4-11) the choice never saw.
import { standardSuite } from "./generate";
import { loadVoyageBenchVectors, v2Miner } from "./miners";
import { runBench } from "./run";

const voy = loadVoyageBenchVectors()!;
const tuned = standardSuite([1, 2, 3]);
const held = standardSuite([4, 5, 6, 7, 8, 9, 10, 11]);
const pct = (x: number) => (x * 100).toFixed(1).padStart(5);
const mixes = [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0];
const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55];

console.log("mix  thr | TUNED  F1  recall split wrong crit | HELD-OUT  F1  recall split wrong crit");
for (const mix of mixes) {
  for (const thr of thresholds) {
    const miner = v2Miner("x", voy.byText, { anchorLinkage: mix, anchorThreshold: thr });
    const [t] = await runBench([miner], tuned);
    const [h] = await runBench([miner], held);
    const f = (r: typeof t) => `${pct(r!.report.groupingF1)} ${pct(r!.report.groupingRecall)} ${pct(r!.report.ideasSplitRate)} ${String(r!.report.wrongMerges).padStart(4)} ${String(r!.report.criticalMerges).padStart(4)}`;
    console.log(`${mix.toFixed(1)}  ${thr.toFixed(2)} | ${f(t)} | ${f(h)}`);
  }
}
