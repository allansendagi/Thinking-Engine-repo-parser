#!/usr/bin/env bun
/**
 * Regenerate starterVectors.json from STARTER_EXAMPLES (see starter.ts). Run after changing the
 * examples or the Voyage model; needs VOYAGE_API_KEY (~400 tokens):
 *   railway run -- bun src/taste/buildStarterVectors.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOYAGE_MODEL, VoyageEmbeddingProvider } from "../providers/voyage";
import { STARTER_EXAMPLES, type StarterVectors } from "./starter";

const voyage = new VoyageEmbeddingProvider();
const all = await voyage.embedMany([...STARTER_EXAMPLES.notIdea, ...STARTER_EXAMPLES.idea], "document");
const round = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4);
const out: StarterVectors = {
  model: `voyage:${VOYAGE_MODEL}`,
  notIdea: all.slice(0, STARTER_EXAMPLES.notIdea.length).map(round),
  idea: all.slice(STARTER_EXAMPLES.notIdea.length).map(round),
};
writeFileSync(join(import.meta.dir, "starterVectors.json"), JSON.stringify(out));
console.log(`wrote ${out.notIdea.length} + ${out.idea.length} vectors for ${out.model}`);
