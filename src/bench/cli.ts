#!/usr/bin/env bun
/**
 * The thinking bench. `bun run bench` scores every miner on the synthetic suite, offline and
 * free. `bun run bench --live` also runs today's pipeline with the real models (needs
 * ANTHROPIC_API_KEY; costs tokens). Writes eval/out/bench.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";
import { standardSuite } from "./generate";
import { v1Miner, v1Offline, type Miner } from "./miners";
import { formatTable, runBench } from "./run";

const live = process.argv.includes("--live");
const miners: Miner[] = [v1Offline];
if (live) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("--live needs ANTHROPIC_API_KEY");
  miners.push(v1Miner("v1 (live models)", () => ({ extraction: createExtractionProvider(), reasoning: createReasoningProvider() })));
}

const scenarios = standardSuite();
const results = await runBench(miners, scenarios);
console.log(`Thinking bench — ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.thoughts.length, 0)} gold thoughts\n`);
console.log(formatTable(results));
mkdirSync("eval/out", { recursive: true });
writeFileSync("eval/out/bench.json", JSON.stringify(results, null, 2));
