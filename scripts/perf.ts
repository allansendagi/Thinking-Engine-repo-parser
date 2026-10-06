#!/usr/bin/env bun
/**
 * Load test: an account the size of a real heavy user's (default 500 conversations, ~9,000
 * messages), built through the real HTTP API the way the extension does it, then every read the Mac
 * app and extension make, timed. The AI is faked (instant, deterministic) so what's measured is
 * Thread's own cost -- storage, queries, matching -- not a model's latency.
 *
 *   bun scripts/perf.ts                 # 500 conversations
 *   PERF_CONVERSATIONS=100 bun scripts/perf.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../src/providers/types";
import { createRequestHandler } from "../src/api/handler";

const CONVERSATIONS = Number(process.env.PERF_CONVERSATIONS ?? 500);
const TURNS = Number(process.env.PERF_TURNS ?? 9); // user turns per conversation (each with a reply)

const extraction: CompletionProvider = {
  async complete(_system, user) {
    const events = [...user.matchAll(/\[NEW\] \[([^\]]+)\] \(user, [^)]*\): (.+)/g)].map(([, id, text]) => ({
      type: "new_idea",
      statement: text!.trim().split(/\s+/).slice(0, 12).join(" "),
      title: text!.trim().split(/\s+/).slice(0, 4).join(" "),
      confidence: 0.9,
      persistence: "high",
      source_event_id: id,
      evidence_quote: text!.trim().slice(0, 24),
    }));
    return JSON.stringify({ events });
  },
};
const reasoning: CompletionProvider = {
  async complete() {
    return JSON.stringify({ matched_idea_id: null, confidence: 0.1, reasoning: "unrelated", also_related_idea_id: null });
  },
};

const dir = mkdtempSync(join(tmpdir(), "thread-perf-"));
process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
process.env.THREAD_DATA_DIR = join(dir, "users");
process.env.THREAD_RATE_LIMIT = "off";
const server = Bun.serve({ port: 0, fetch: createRequestHandler({ extraction, reasoning }) });
const base = `http://localhost:${server.port}`;

const u = (await (await fetch(`${base}/v1/users`, { method: "POST" })).json()) as { userId: string; token: string };
const headers = { authorization: `Bearer ${u.userId}:${u.token}`, "content-type": "application/json" };

const WORDS = "pricing seat workspace onboarding email agent policy verification authority roadmap hiring launch migration schema billing retention privacy sync latency embedding cluster dashboard".split(" ");
const sentence = (seed: number, n = 14) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 3 + (i % 5) * seed) % WORDS.length]).join(" ");
const day = 86_400_000;
const start = Date.now() - 400 * day;

function transcript(c: number, turns: number) {
  const out: { id: string; role: string; text: string; createdAt: string }[] = [];
  for (let t = 0; t < turns; t++) {
    const at = new Date(start + c * 0.8 * day + t * 60_000).toISOString();
    out.push({ id: `c${c}_u${t}`, role: "user", text: `${sentence(c * 31 + t)} (thought ${c}.${t})`, createdAt: at });
    out.push({ id: `c${c}_a${t}`, role: "assistant", text: `${sentence(c * 17 + t, 24)}`, createdAt: at });
  }
  return out;
}
const send = async (c: number, turns: number) => {
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      conversationId: `conv_${c}`,
      source: "chatgpt",
      sourceUrl: `https://chatgpt.com/c/conv_${c}`,
      capture: { method: "browser_extension", fidelity: "high" },
      messages: transcript(c, turns),
    }),
  });
  if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`);
  await r.arrayBuffer();
  return performance.now() - t0;
};

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1)).padStart(7);

// ---- build the account, timing ingestion as it grows --------------------------------------
const slices: { upTo: number; ms: number[] }[] = [];
let bucket: number[] = [];
const bucketSize = Math.max(1, Math.floor(CONVERSATIONS / 5));
const buildStart = performance.now();
for (let c = 0; c < CONVERSATIONS; c++) {
  // The extension sends the transcript as it grows: halfway, then complete.
  bucket.push(await send(c, Math.ceil(TURNS / 2)));
  bucket.push(await send(c, TURNS));
  if ((c + 1) % bucketSize === 0) {
    slices.push({ upTo: c + 1, ms: bucket });
    // Progress as it happens: a slow build is the finding, not something to wait out silently.
    console.log(`  ${String(c + 1).padStart(5)} conversations: p50 ${fmt(pct(bucket, 0.5))} ms  p95 ${fmt(pct(bucket, 0.95))} ms  (${((performance.now() - buildStart) / 1000).toFixed(0)}s elapsed)`);
    bucket = [];
  }
}
const buildSec = (performance.now() - buildStart) / 1000;
console.log(`Built ${CONVERSATIONS} conversations (${CONVERSATIONS * TURNS * 2} messages) in ${buildSec.toFixed(1)}s\n`);
console.log("Ingest latency (one capture request) as the account grows:");
console.log("  conversations |  p50 ms |  p95 ms |  max ms");
for (const s of slices) console.log(`  ${String(s.upTo).padStart(13)} | ${fmt(pct(s.ms, 0.5))} | ${fmt(pct(s.ms, 0.95))} | ${fmt(Math.max(...s.ms))}`);

// ---- reads, on the full account -----------------------------------------------------------
const get = async (path: string) => {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { headers });
  const body = await r.arrayBuffer();
  return { ms: performance.now() - t0, status: r.status, bytes: body.byteLength };
};
const first = (await (await fetch(`${base}/v1/thinking-state`, { headers })).json()) as { currentIdeas: { id: string }[] };
const ideaId = encodeURIComponent(first.currentIdeas[0]?.id ?? "x");
const reads: [string, string][] = [
  ["GET /v1/health", "/v1/health"],
  ["GET /v1/thinking-state", "/v1/thinking-state"],
  ["GET /v1/conversations (Activity)", "/v1/conversations"],
  ["GET /v1/capture-health", "/v1/capture-health"],
  ["GET /v1/account", "/v1/account"],
  ["GET /v1/account/data-summary", "/v1/account/data-summary"],
  ["GET /v1/recent-changes", "/v1/recent-changes"],
  ["GET /v1/open-loops", "/v1/open-loops"],
  ["GET /v1/ideas/:id/trace", `/v1/ideas/${ideaId}/trace`],
  ["GET /v1/search?q=pricing", "/v1/search?q=pricing%20seat"],
  ["GET /v1/conversations/:id", "/v1/conversations/conv_250"],
];
console.log("\nReads on the full account (20 runs each):");
console.log("  endpoint                                  |  p50 ms |  p95 ms |  size");
const results: Record<string, number> = {};
for (const [label, path] of reads) {
  const runs = [];
  let last = { status: 0, bytes: 0 };
  for (let i = 0; i < 20; i++) {
    const r = await get(path);
    runs.push(r.ms);
    last = r;
  }
  results[label] = pct(runs, 0.5);
  console.log(`  ${label.padEnd(42)}| ${fmt(pct(runs, 0.5))} | ${fmt(pct(runs, 0.95))} | ${last.status} ${(last.bytes / 1024).toFixed(0)} KB`);
}
if (process.env.PERF_JSON) await Bun.write(process.env.PERF_JSON, JSON.stringify({ conversations: CONVERSATIONS, buildSec, slices: slices.map((s) => ({ upTo: s.upTo, p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95) })), reads: results }, null, 2));

server.stop(true);
rmSync(dir, { recursive: true, force: true });
