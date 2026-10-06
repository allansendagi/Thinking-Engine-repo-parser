#!/usr/bin/env bun
/**
 * The bench's captures, as JSON, for the on-device extraction run on a Mac
 * (macos-app BenchExtractionTests). For each scenario: the person's own messages in the order
 * they were written (earliest first, across conversations) -- what Thread for Mac would be handed
 * as they capture. `--held-out` exports seeds 4-11, the ones no threshold was tuned on.
 *
 *   bun src/bench/dumpConversations.ts --held-out > /tmp/bench-convs.json
 */
import { standardSuite } from "./generate";

const scenarios = process.argv.includes("--held-out") ? standardSuite([4, 5, 6, 7, 8, 9, 10, 11]) : standardSuite();
const out = scenarios.map((s) => ({
  scenario: s.name,
  captures: s.events
    .filter((e) => e.role === "user")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.index - b.index)
    .map((e) => ({ id: e.id, text: e.text })),
}));
console.log(JSON.stringify(out));
