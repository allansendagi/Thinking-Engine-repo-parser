#!/usr/bin/env bun
import { createRequestHandler } from "./handler";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";
import { dataDir } from "../db/tenancy";

const port = Number(process.env.PORT ?? 8787);
const handler = createRequestHandler({
  extraction: createExtractionProvider(),
  reasoning: createReasoningProvider(),
});

Bun.serve({ port, fetch: handler });
console.log(`Thread API listening on http://localhost:${port}`);

// Loud warning if storage is ephemeral: on a container host (Railway) without a mounted volume,
// every user DB and the token registry vanish on the next redeploy -- accounts silently 401.
const persistent = !!process.env.THREAD_DATA_DIR || !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!persistent && process.env.RAILWAY_ENVIRONMENT) {
  console.warn(
    "[Thread] WARNING: no persistent volume detected (RAILWAY_VOLUME_MOUNT_PATH unset). " +
      "Data in " +
      dataDir() +
      " will be WIPED on the next deploy. Attach a Railway volume to fix.",
  );
} else {
  console.log(`[Thread] data dir: ${dataDir()}${persistent ? " (persistent)" : " (local)"}`);
}
