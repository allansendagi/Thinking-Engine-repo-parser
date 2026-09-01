#!/usr/bin/env bun
import { createRequestHandler } from "./handler";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";

const port = Number(process.env.PORT ?? 8787);
const handler = createRequestHandler({
  extraction: createExtractionProvider(),
  reasoning: createReasoningProvider(),
});

Bun.serve({ port, fetch: handler });
console.log(`Thread API listening on http://localhost:${port}`);
