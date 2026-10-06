#!/usr/bin/env bun
/**
 * The thinking bench. `bun run bench` scores every miner on the synthetic suite, offline and
 * free. `bun run bench --live` also runs today's pipeline with the real models (needs
 * ANTHROPIC_API_KEY; costs tokens). Writes eval/out/bench.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";
import { standardSuite } from "./generate";
import { loadBenchVectors, v1Miner, v1Offline, v2Miner, type Miner } from "./miners";
import { formatTable, runBench } from "./run";
import { meaningWeightFor } from "../mining/consolidate";
import { VoyageEmbeddingProvider, voyageConfigured } from "../providers/voyage";

const live = process.argv.includes("--live");
const apple = loadBenchVectors();
const miners: Miner[] = [
  v1Offline,
  v2Miner("v2 (words + context, no roles)", null, { roles: false }),
  v2Miner("v2 (words + context + roles)", null),
];
// Each meaning model is used at the weight the bench earned it (meaningWeightFor): a native
// model that doesn't separate ideas scores the same as words alone, by design.
if (apple) {
  miners.push(v2Miner(`v2 + Apple on-device meaning (${apple.model})`, apple.byText, { meaningWeight: meaningWeightFor(apple.model) }));
}
// The cloud fallback, measured the same way when a key is present (a few hundred short texts, ~free).
if (voyageConfigured()) {
  const texts = [...new Set(standardSuite().flatMap((s) => s.thoughts.map((t) => t.said)))];
  const voyage = new VoyageEmbeddingProvider();
  const vectors = await voyage.embedMany(texts);
  miners.push(v2Miner(`v2 + Voyage fallback (${voyage.modelId})`, new Map(texts.map((t, i) => [t, vectors[i]!]))));
}
if (live) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("--live needs ANTHROPIC_API_KEY");
  miners.push(v1Miner("v1 (live models)", () => ({ extraction: createExtractionProvider(), reasoning: createReasoningProvider() })));
}

// --held-out scores seeds the thresholds were NOT tuned on.
const scenarios = process.argv.includes("--held-out") ? standardSuite([4, 5, 6, 7, 8, 9, 10, 11]) : standardSuite();
const results = await runBench(miners, scenarios);
console.log(`Thinking bench — ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.thoughts.length, 0)} gold thoughts\n`);
console.log(formatTable(results));
mkdirSync("eval/out", { recursive: true });
writeFileSync("eval/out/bench.json", JSON.stringify(results, null, 2));
