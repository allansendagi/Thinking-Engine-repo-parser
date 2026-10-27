#!/usr/bin/env bun
import { createRequestHandler } from "./handler";
import { createExtractionProvider, createReasoningProvider } from "../providers/anthropic";
import { dataDir, openUserDb } from "../db/tenancy";
import { openRegistry } from "./auth";
import { regroupStaleAccounts } from "../mining/shadow";
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

// A change to how ideas are grouped reaches every account now, not at its next capture. In the
// background, a minute after boot, so serving is never held up.
setTimeout(() => {
  try {
    const reg = openRegistry();
    const ids = (reg.query("SELECT id FROM users").all() as { id: string }[]).map((r) => r.id);
    reg.close();
    void regroupStaleAccounts(ids, openUserDb).catch((e) => console.error("[Thread] boot regroup failed:", e));
  } catch (e) {
    console.error("[Thread] boot regroup could not list accounts:", e);
  }
}, 60_000).unref?.();
console.log(`[Thread] storage: ${storageMode()} -- data dir ${dataDir()}`);
