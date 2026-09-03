#!/usr/bin/env bun
import { createRequestHandler } from "./handler";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";
import { dataDir } from "../db/tenancy";
import { assertDurableStorage, storageMode } from "../db/durability";

// Fail the boot -- rather than come up and lose every account's session on the redeploy after
// this one -- if we're on a container host writing to ephemeral local disk. No-op locally and
// when a volume is attached. THREAD_ALLOW_EPHEMERAL=1 opts out.
assertDurableStorage();

const port = Number(process.env.PORT ?? 8787);
const handler = createRequestHandler({
  extraction: createExtractionProvider(),
  reasoning: createReasoningProvider(),
});

Bun.serve({ port, fetch: handler });
console.log(`Thread API listening on http://localhost:${port}`);
console.log(`[Thread] storage: ${storageMode()} -- data dir ${dataDir()}`);
