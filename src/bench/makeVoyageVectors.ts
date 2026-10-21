#!/usr/bin/env bun
/**
 * Embed every text the bench's scenarios contain (seeds 1-11: the tuned set and the held-out set)
 * with Voyage once, and store them in vectors.voyage.json. After this the Voyage row of the bench
 * runs offline, for free and identically every time -- and CI can guard its quality.
 *
 *   railway run -- sh -c 'cd <checkout> && bun src/bench/makeVoyageVectors.ts'
 *
 * Needs VOYAGE_API_KEY. A few hundred short texts: well under a cent.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VoyageEmbeddingProvider, voyageConfigured } from "../providers/voyage";
import { standardSuite } from "./generate";

if (!voyageConfigured()) throw new Error("VOYAGE_API_KEY is not set");
const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const texts = [...new Set(standardSuite(seeds).flatMap((s) => s.thoughts.map((t) => t.said)))];
const voyage = new VoyageEmbeddingProvider();
const vectors: Record<string, number[]> = {};
for (let i = 0; i < texts.length; i += 100) {
  const batch = texts.slice(i, i + 100);
  const out = await voyage.embedMany(batch);
  batch.forEach((t, j) => {
    // 4 decimals: far below what cosine similarity can tell apart, and keeps the file small.
    vectors[t] = out[j]!.map((x) => Math.round(x * 1e4) / 1e4);
  });
}
const dims = Object.values(vectors)[0]!.length;
writeFileSync(join(import.meta.dir, "vectors.voyage.json"), JSON.stringify({ model: voyage.modelId, dims, seeds, vectors }));
console.log(`${texts.length} texts, ${dims} dims, model ${voyage.modelId}`);
