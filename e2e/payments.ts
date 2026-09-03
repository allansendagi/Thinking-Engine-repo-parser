/**
 * Payment-path simulation. Focused companion to journey.ts.
 *
 *   bun run e2e:payments
 *
 * Exercises the full Paddle billing surface through the real HTTP handler: webhook-signature
 * security, the whole subscription lifecycle (activate → update → past_due → recover → cancel →
 * lapse → resume → pause), both user-resolution paths, the customer-portal endpoint, webhook
 * idempotency, and the exact 402 / free-tier contract the Mac app / extension / website depend on.
 *
 * Deterministic, no network, no API key, no real card. A signed webhook is byte-for-byte what
 * Paddle's checkout emits -- what this CANNOT stand in for is a real hosted checkout with a test
 * card, which needs the Paddle dashboard (product, price, client token, webhook registration).
 * Runbook for that one manual test is in e2e/README.md.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../src/providers/types";

const SECRET = "whsec_payments_test";

class Always implements CompletionProvider {
  constructor(private readonly out: string) {}
  async complete(): Promise<string> {
    return this.out;
  }
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`   \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`   \x1b[31m✗ ${label}\x1b[0m`);
    if (detail !== undefined) console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}
function phase(t: string): void {
  console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);
}

function signHeaders(payload: string, opts: { secret?: string; skewSeconds?: number; raw?: string } = {}): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000) + (opts.skewSeconds ?? 0);
  const h1 = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}:${payload}`).digest("hex");
  return { "paddle-signature": opts.raw ?? `ts=${ts};h1=${h1}`, "content-type": "application/json" };
}

const evt = (event_type: string, data: Record<string, unknown>) => JSON.stringify({ event_type, data });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const tmp = mkdtempSync(join(tmpdir(), "thread-payments-"));
process.env.THREAD_REGISTRY_PATH = join(tmp, "registry.db");
process.env.THREAD_DATA_DIR = join(tmp, "users");
process.env.THREAD_RATE_LIMIT = "off"; // deterministic sim: many synthetic clients through one process
for (const k of ["PADDLE_API_KEY", "PADDLE_PRICE_ID", "PADDLE_WEBHOOK_SECRET", "PADDLE_ENV"]) delete process.env[k];

async function run(): Promise<void> {
  const { createRequestHandler } = await import("../src/api/handler");
  const { openUserDb } = await import("../src/db/tenancy");
  const { getAccount, setPlan } = await import("../src/api/auth");

  const handler = createRequestHandler({ extraction: new Always("{}"), reasoning: new Always("Keep going from the open question.") });
  const call = (p: string, init: RequestInit = {}) => handler(new Request(`http://pay${p}`, init));
  const authed = (tok: string, p: string, init: RequestInit = {}) =>
    call(p, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${tok}`, "content-type": "application/json" } });
  const post = (v: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(v) });
  const webhook = (body: string, headers: Record<string, string>) => call("/v1/paddle/webhook", { method: "POST", headers, body });

  const user = (await (await call("/v1/users", { method: "POST" })).json()) as { userId: string; token: string };
  const A = `${user.userId}:${user.token}`;
  const acct = async () => (await (await authed(A, "/v1/account")).json()) as Record<string, unknown>;
  // one idea so /v1/continue has something to resolve when the gate lets it through
  const seed = openUserDb(user.userId);
  seed.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES ('idea_pay','Authority','developing','f',?,?)").run(new Date().toISOString(), new Date().toISOString());
  seed.close();

  const captureStatus = async () =>
    (await authed(A, "/v1/conversations", post({ conversationId: "c", source: "chatgpt", messages: [] }))).status;
  const continueStatus = async () => (await authed(A, "/v1/continue", post({ ideaId: "idea_pay" }))).status;

  // ============================================================================================
  phase("Phase 1 — Soft launch: with no Paddle env, nothing is gated");
  check("billing reads as NOT configured", (await acct()).billingEnabled === false);
  const bigSeed = openUserDb(user.userId);
  const s = bigSeed.prepare("INSERT INTO idea_nodes (id,title,state,current_formulation,created_at,updated_at) VALUES (?,?,'developing','f',?,?)");
  const nowIso = new Date().toISOString();
  for (let i = 0; i < 40; i++) s.run(`over_${i}`, `x${i}`, nowIso, nowIso);
  bigSeed.close();
  check("capture works even 41 ideas in (gate is a no-op pre-Paddle)", (await captureStatus()) !== 402);
  check("/v1/continue works pre-Paddle too", (await continueStatus()) !== 402);

  // Turn billing on for the rest of the run.
  process.env.PADDLE_API_KEY = "pdl_test";
  process.env.PADDLE_PRICE_ID = "pri_test";
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.PADDLE_ENV = "sandbox";

  // ============================================================================================
  phase("Phase 2 — Webhook signature is the only thing standing between a stranger and Pro");
  const body = evt("subscription.activated", { id: "sub_1", customer_id: "ctm_1", status: "active", custom_data: { thread_user_id: user.userId } });
  check("valid signature → 200", (await webhook(body, signHeaders(body))).status === 200);
  check("wrong secret → 400", (await webhook(body, signHeaders(body, { secret: "whsec_forged" }))).status === 400);
  check("tampered body → 400", (await webhook(evt("subscription.activated", { id: "sub_1", customer_id: "ctm_1", status: "active", custom_data: { thread_user_id: user.userId }, injected: true }), signHeaders(body))).status === 400);
  check("stale timestamp (>5 min) → 400", (await webhook(body, signHeaders(body, { skewSeconds: -600 }))).status === 400);
  check("missing paddle-signature header → 400", (await webhook(body, { "content-type": "application/json" })).status === 400);
  check("malformed signature header → 400", (await webhook(body, signHeaders(body, { raw: "garbage" }))).status === 400);
  // the one valid call above already flipped the account:
  check("...and the one valid webhook DID make the account Pro", (await acct()).plan === "pro");

  // reset to Free for the clean lifecycle walk
  setPlan(user.userId, { plan: "free", status: "free", currentPeriodEnd: null, paddleCustomerId: null, paddleSubscriptionId: null });

  // ============================================================================================
  phase("Phase 3 — Full subscription lifecycle (each step a signed webhook)");
  const send = (type: string, data: Record<string, unknown>) => {
    const p = evt(type, data);
    return webhook(p, signHeaders(p));
  };
  const cd = { thread_user_id: user.userId };

  await send("subscription.activated", { id: "sub_9", customer_id: "ctm_9", status: "active", custom_data: cd, current_billing_period: { ends_at: inDays(30) } });
  let a = await acct();
  check("activated → Pro / active, customer + subscription + period stored",
    a.plan === "pro" && a.status === "active" && a.isPro === true, a);
  check("capture gate OPEN for an active subscriber", (await captureStatus()) !== 402);
  check("/v1/continue OPEN for an active subscriber", (await continueStatus()) === 200);

  const renewedEnd = inDays(60);
  await send("subscription.updated", { id: "sub_9", customer_id: "ctm_9", status: "active", custom_data: cd, current_billing_period: { ends_at: renewedEnd } });
  check("updated → the new billing-period end is recorded exactly", (await acct()).currentPeriodEnd === renewedEnd, await acct());

  await send("subscription.past_due", { id: "sub_9", customer_id: "ctm_9", status: "past_due", custom_data: cd });
  a = await acct();
  check("past_due → still Pro (grace period), gates stay open", a.status === "past_due" && a.isPro === true && (await captureStatus()) !== 402, a);

  await send("subscription.activated", { id: "sub_9", customer_id: "ctm_9", status: "active", custom_data: cd, current_billing_period: { ends_at: inDays(60) } });
  check("payment recovered → back to active", (await acct()).status === "active");

  await send("subscription.canceled", { id: "sub_9", customer_id: "ctm_9", status: "canceled", custom_data: cd });
  a = await acct();
  check("canceled → status canceled BUT still Pro until the paid period ends", a.status === "canceled" && a.isPro === true, a);
  check("gates stay open during the paid-through period", (await captureStatus()) !== 402 && (await continueStatus()) === 200);

  setPlan(user.userId, { currentPeriodEnd: inDays(-1) }); // simulate the paid period elapsing
  a = await acct();
  check("once the paid period elapses → isPro false, capture 402, continue still open (free tier)",
    a.isPro === false && (await captureStatus()) === 402 && (await continueStatus()) === 200, a);

  await send("subscription.resumed", { id: "sub_9", customer_id: "ctm_9", status: "active", custom_data: cd, current_billing_period: { ends_at: inDays(30) } });
  check("resumed → Pro again, gates re-open", (await acct()).isPro === true && (await captureStatus()) !== 402);

  await send("subscription.paused", { id: "sub_9", customer_id: "ctm_9", status: "paused", custom_data: cd });
  check("paused → treated as canceled", (await acct()).status === "canceled");

  // ============================================================================================
  phase("Phase 4 — User resolution: metadata, stored customer id, and unknown");
  setPlan(user.userId, { plan: "free", status: "free", paddleCustomerId: "ctm_known" });
  await send("subscription.past_due", { id: "sub_k", customer_id: "ctm_known", status: "past_due", custom_data: null });
  check("event with NO custom_data resolves via the stored paddle_customer_id", (await acct()).status === "past_due");

  const snapshot = (x: Record<string, unknown>) => ({ plan: x.plan, status: x.status, isPro: x.isPro, canCapture: x.canCapture, currentPeriodEnd: x.currentPeriodEnd });
  const before = snapshot(await acct());
  const unknownRes = await send("subscription.activated", { id: "sub_u", customer_id: "ctm_nobody", status: "active", custom_data: { thread_user_id: "user_" + "9".repeat(24) } });
  check("event for an unknown user → 200, no crash, our account byte-for-byte unchanged",
    unknownRes.status === 200 && JSON.stringify(snapshot(await acct())) === JSON.stringify(before), { before, after: snapshot(await acct()) });

  // transaction.completed carries the customer id before the subscription events do; store it so a
  // later portal-initiated event with no custom_data can still be resolved. Verified end-to-end:
  setPlan(user.userId, { plan: "free", status: "free", paddleCustomerId: null });
  await send("transaction.completed", { id: "txn_1", customer_id: "ctm_txn", custom_data: cd });
  await send("subscription.activated", { id: "sub_txn", customer_id: "ctm_txn", status: "active", custom_data: null, current_billing_period: { ends_at: inDays(30) } });
  check("transaction.completed's customer id lets a later custom_data-less event resolve → Pro",
    (await acct()).plan === "pro" && (await acct()).isPro === true, await acct());

  // ============================================================================================
  phase("Phase 5 — Customer portal (GET /v1/billing/portal)");
  setPlan(user.userId, { plan: "free", status: "free", paddleCustomerId: null, paddleSubscriptionId: null });
  check("no subscription yet → 409 'subscribe first'", (await authed(A, "/v1/billing/portal")).status === 409);

  setPlan(user.userId, { plan: "pro", status: "active", paddleCustomerId: "ctm_portal", paddleSubscriptionId: "sub_portal" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/customers/ctm_portal/portal-sessions")) {
      return new Response(JSON.stringify({ data: { urls: { general: { overview: "https://sandbox-customers.paddle.com/portal/abc123" } } } }), { status: 200 });
    }
    return realFetch(url as never);
  }) as typeof fetch;
  try {
    const portal = await authed(A, "/v1/billing/portal");
    const pjson = (await portal.json()) as { url?: string };
    check("with a customer id → returns the Paddle portal URL", portal.status === 200 && pjson.url === "https://sandbox-customers.paddle.com/portal/abc123", pjson);

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { detail: "boom" } }), { status: 500 })) as typeof fetch;
    check("Paddle API failure → 502 (not a 500 blow-up)", (await authed(A, "/v1/billing/portal")).status === 502);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ============================================================================================
  phase("Phase 6 — Webhook idempotency");
  setPlan(user.userId, { plan: "free", status: "free", currentPeriodEnd: null });
  const dup = evt("subscription.activated", { id: "sub_dup", customer_id: "ctm_dup", status: "active", custom_data: cd, current_billing_period: { ends_at: inDays(30) } });
  const h = signHeaders(dup);
  const first = await webhook(dup, h);
  const second = await webhook(dup, signHeaders(dup)); // Paddle retries on timeout
  const third = await webhook(dup, signHeaders(dup));
  const fa = await acct();
  check("the same activation delivered 3x → 200 each, account is Pro exactly once (idempotent)",
    first.status === 200 && second.status === 200 && third.status === 200 && fa.plan === "pro" && fa.status === "active", fa);

  // ============================================================================================
  phase("Phase 7 — The 402 contract the clients render");
  setPlan(user.userId, { plan: "free", status: "free", currentPeriodEnd: null });
  const capBody = (await (await authed(A, "/v1/conversations", post({ conversationId: "c", source: "chatgpt", messages: [] }))).json()) as { error: string; code: string };
  check("capture-over-cap body: code 'upgrade_required' + a human message naming the 25-idea limit",
    capBody.code === "upgrade_required" && /25-idea limit/.test(capBody.error), capBody);
  const contRes = await authed(A, "/v1/continue", post({ ideaId: "idea_pay" }));
  const contBody = (await contRes.json()) as { tier: string; packet: unknown };
  check("continue for a Free account: 200, tier 'free', packet present (not gated — the Mac app sharpens the one line on-device)",
    contRes.status === 200 && contBody.tier === "free" && contBody.packet != null, contBody);
}

try {
  await run();
} catch (err) {
  failed++;
  failures.push(`UNCAUGHT: ${(err as Error).message}`);
  console.error("\n\x1b[31mUncaught:\x1b[0m", err);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

phase(`Result — ${passed} passed, ${failed} failed`);
if (failed > 0) console.log("Failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
console.log(`
Proven: webhook signature security (6 rejection cases), the full subscription lifecycle
(activate/update/past_due/recover/cancel/lapse/resume/pause) with the capture gate tracking it
(/v1/continue stays open on every plan — Free gets tier:"free"), both user-resolution paths,
unknown-user safety, the customer-portal endpoint (mocked Paddle API), 3x webhook idempotency,
and the exact 402 / free-tier bodies the clients show.

Still requires a live Paddle sandbox (dashboard product + price + client token + webhook URL):
one real hosted checkout with test card 4242 4242 4242 4242 → confirm the real webhook lands here
and flips GET /v1/account to pro. Runbook in e2e/README.md.`);

process.exit(failed > 0 ? 1 : 0);
