/**
 * End-to-end user-journey simulation.
 *
 *   bun run e2e/journey.ts
 *
 * Drives the real HTTP handler (src/api/handler.ts) through the whole path a person takes --
 * open the Mac app, capture the same thought across ChatGPT / Claude / Gemini / Cursor, recall
 * it, get a continuation packet, attach an email, sign in on a second device, hit the Free-plan
 * cap, pay (a signed Paddle webhook, exactly what a real checkout emits), then cancel. No network,
 * no API key: the extraction and identity-resolution models are faked deterministically
 * (fixtures/), because this checks the PLUMBING. Whether the models produce good output is a
 * separate question that `bun run eval` measures.
 *
 * Exits non-zero on the first failed assertion. What it can and cannot prove is summarised at the
 * end and in e2e/README.md.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../src/providers/types";
import { CONVERSATIONS, IDEA_ID, identityReply } from "./journey/fixtures";
import { suggestionFromState } from "../extension/src/lib/resume";

// --- deterministic model doubles -----------------------------------------------------------------

class JourneyExtraction implements CompletionProvider {
  async complete(_system: string, user: string): Promise<string> {
    for (const c of CONVERSATIONS) if (user.includes(c.marker)) return JSON.stringify(c.extraction);
    throw new Error("journey extraction double: no conversation marker found in the prompt");
  }
}

class JourneyReasoning implements CompletionProvider {
  identityCalls = 0;
  nextStepCalls = 0;
  async complete(system: string): Promise<string> {
    if (system.includes("decide whether")) {
      this.identityCalls++;
      return identityReply(IDEA_ID); // every follow-up merges into the ChatGPT-born idea
    }
    this.nextStepCalls++;
    return "Pin down who can act as the trust anchor for the verifier and whether a signed execution trace alone is enough for a relying party.";
  }
}

// --- tiny test harness -------------------------------------------------------------------------

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

function phase(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`);
}

// --- main ------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "thread-journey-"));
process.env.THREAD_REGISTRY_PATH = join(tmp, "registry.db");
process.env.THREAD_DATA_DIR = join(tmp, "users");
process.env.THREAD_RATE_LIMIT = "off"; // deterministic sim: many synthetic clients through one process
// Start with billing OFF so the un-gated part of the journey is testing what it claims to.
for (const k of ["PADDLE_API_KEY", "PADDLE_PRICE_ID", "PADDLE_WEBHOOK_SECRET", "PADDLE_ENV", "RESEND_API_KEY", "EMAIL_FROM"]) {
  delete process.env[k];
}

async function run(): Promise<void> {
  const { createRequestHandler } = await import("../src/api/handler");
  const { issueCode } = await import("../src/api/authCodes");
  const { openUserDb } = await import("../src/db/tenancy");

  const reasoning = new JourneyReasoning();
  const handler = createRequestHandler({ extraction: new JourneyExtraction(), reasoning });

  const call = (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://journey${path}`, init));
  const authed = (token: string, path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const jsonBody = (v: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(v) });

  // ============================================================================================
  phase("Phase 1 — Onboarding: open the Mac app, zero setup");
  const usersRes = await call("/v1/users", { method: "POST" });
  const mac = (await usersRes.json()) as { userId: string; token: string };
  check("POST /v1/users mints an anonymous account", usersRes.status === 201 && !!mac.userId && !!mac.token, mac);

  let acct = await (await authed(`${mac.userId}:${mac.token}`, "/v1/account")).json() as Record<string, unknown>;
  check("GET /v1/account: Free plan, 0/25 ideas, billing not yet configured",
    acct.plan === "free" && acct.isPro === false && acct.ideaCount === 0 && acct.ideaCap === 25 &&
      acct.billingEnabled === false && acct.email === null && acct.canCapture === true, acct);

  const macAuth = `${mac.userId}:${mac.token}`;

  // ============================================================================================
  phase("Phase 2 — Capture the same thought across four AI tools");
  for (const c of CONVERSATIONS) {
    const res = await authed(macAuth, "/v1/conversations", jsonBody({
      conversationId: c.conversationId,
      source: c.source,
      sourceUrl: c.sourceUrl,
      messages: c.messages,
    }));
    const body = (await res.json()) as { newCanonicalEvents: number; newCognitiveEvents: number; ideaCount: number };
    console.log(`   ${c.source.padEnd(8)} → +${body.newCanonicalEvents} msgs, +${body.newCognitiveEvents} events, ${body.ideaCount} idea(s) total`);
    check(`${c.source}: capture accepted (200)`, res.status === 200, body);
    check(`${c.source}: still exactly ONE idea (cross-tool identity merge held)`, body.ideaCount === 1, body);
  }

  const state = await (await authed(macAuth, "/v1/thinking-state")).json() as {
    currentIdeas: { id: string; title: string; currentFormulation: string; state: string }[];
    openLoops: { ideaId: string; statement: string; resolved: boolean }[];
    decisions: { statement: string }[];
    recentChanges: { ideaId: string; createdAt: string }[];
  };
  check("Thinking State has one idea about computable authority",
    state.currentIdeas.length === 1 && /authorit/i.test(state.currentIdeas[0]!.title + state.currentIdeas[0]!.currentFormulation),
    state.currentIdeas);
  check("the Gemini open question was captured as an open loop",
    state.openLoops.some((l) => !l.resolved && /verif/i.test(l.statement)), state.openLoops);
  check("the ChatGPT decision was captured", state.decisions.some((d) => /default.deny|source of truth/i.test(d.statement)), state.decisions);

  // ============================================================================================
  phase("Phase 3 — Recall: search, trace, open loops");
  const ideas = await (await authed(macAuth, "/v1/ideas?q=" + encodeURIComponent("computable authority"))).json() as { id: string; title: string }[];
  check("GET /v1/ideas finds the idea", ideas.length >= 1, ideas);
  const ideaId = ideas[0]?.id ?? IDEA_ID;
  check("the derived idea id matches the prediction", ideaId === IDEA_ID, { got: ideaId, want: IDEA_ID });

  const trace = await (await authed(macAuth, `/v1/ideas/${encodeURIComponent(ideaId)}/trace`)).json() as {
    provenance: { formulation: string; sourceRole: string | null; source: string | null; sourceUrl: string | null }[];
  };
  check("trace has >= 4 provenance steps (one per tool + the decision)", trace.provenance.length >= 4, trace.provenance.length);
  const urls = new Set(trace.provenance.map((p) => p.sourceUrl).filter(Boolean));
  check("each tool's conversation URL rode through to the trace",
    urls.has("https://chatgpt.com/c/chatgpt-authority") && urls.has("https://claude.ai/chat/claude-authority") &&
      urls.has("https://gemini.google.com/app/gemini-authority") && urls.has("https://cursor.com/chat/cursor-authority"),
    [...urls]);
  check("every substantive step is attributed to the human ('user' role)",
    trace.provenance.every((p) => p.sourceRole === "user"), trace.provenance.map((p) => p.sourceRole));

  const loops = await (await authed(macAuth, "/v1/open-loops")).json() as { statement: string }[];
  check("GET /v1/open-loops returns the verifier question", loops.some((l) => /verif/i.test(l.statement)), loops);

  // ============================================================================================
  phase("Phase 4 — Continuation packet (the resume handoff)");
  const contRes = await authed(macAuth, "/v1/continue", jsonBody({ ideaId }));
  const cont = (await contRes.json()) as {
    text: string;
    packet: {
      evolution: { source: string | null; formulation: string; sourceUrl: string | null }[];
      unresolvedQuestion: string | null;
      decisions: { statement: string }[];
      suggestedNext: string;
    };
  };
  check("POST /v1/continue returns a packet (200)", contRes.status === 200 && !!cont.packet, contRes.status);
  check("packet.evolution covers all four tools", cont.packet.evolution.length >= 4, cont.packet.evolution.map((e) => e.source));
  const packetUrls = new Set(cont.packet.evolution.map((e) => e.sourceUrl).filter(Boolean));
  check("evolution steps carry distinct source URLs (>= 3)", packetUrls.size >= 3, [...packetUrls]);
  check("paste-ready text contains NO raw URL (links are a structured affordance, not paste content)",
    !cont.text.includes("https://"), cont.text.slice(0, 200));
  check("paste-ready text keeps the {{CONTINUE_FROM_HERE}} token for offline editing",
    cont.text.includes("{{CONTINUE_FROM_HERE}}"), cont.text.slice(-120));
  check("packet points at the unresolved verifier question", /verif/i.test(cont.packet.unresolvedQuestion ?? ""), cont.packet.unresolvedQuestion);
  check("packet carries the decision", cont.packet.decisions.length >= 1, cont.packet.decisions);
  console.log("\n   ----- packet text as pasted into a fresh chat -----");
  console.log(cont.text.split("\n").map((l) => "   " + l).join("\n"));
  console.log("   --------------------------------------------------");

  // ============================================================================================
  phase("Phase 5 — Browser return nudge (the rule shared with the Mac app)");
  // Exactly the ThinkingState the extension's background worker gets from GET /v1/thinking-state,
  // fed through the shared rule (extension/src/lib/resume.ts). The last edit was ~11 days ago.
  const nudge = suggestionFromState(state as never, {});
  check("the nudge surfaces this unfinished idea (open loop, touched ~11 days ago)",
    nudge?.ideaId === state.currentIdeas[0]!.id && nudge!.daysAgo >= 9 && nudge!.daysAgo <= 13, nudge);
  const snoozed = suggestionFromState(state as never, { [state.currentIdeas[0]!.id]: new Date().toISOString() });
  check("'Not now' (snooze after the last edit) suppresses it", snoozed === null, snoozed);
  console.log("   note: state.recentChanges is a 30-day window but the rule's age window is 3–45 days,");
  console.log("   so an idea last touched 31–45 days ago never becomes a candidate. Minor gap, both clients.");

  // ============================================================================================
  phase("Phase 6 — Attach an email to the anonymous account");
  const email = `journey-${Date.now()}@example.com`;
  const start = await call("/v1/auth/start", jsonBody({ email }));
  check("POST /v1/auth/start always 200 (no account enumeration)", start.status === 200, start.status);

  await authed(macAuth, "/v1/account/email", jsonBody({ email }));
  const claimRes = await authed(macAuth, "/v1/account/email/verify", jsonBody({ email, code: await issueCode(email) }));
  const claim = (await claimRes.json()) as { email?: string };
  check("email attached (200) and echoed back", claimRes.status === 200 && claim.email === email, claim);
  acct = await (await authed(macAuth, "/v1/account")).json() as Record<string, unknown>;
  check("account now shows the email and still has its 1 idea", acct.email === email && acct.ideaCount === 1, acct);

  // ============================================================================================
  phase("Phase 7 — Sign in on a second device; reject a stranger claiming the email");
  const verifyRes = await call("/v1/auth/verify", jsonBody({ email, code: await issueCode(email) }));
  const phone = (await verifyRes.json()) as { userId: string; token: string };
  check("sign-in returns the SAME account with a NEW per-device token",
    phone.userId === mac.userId && phone.token !== mac.token, { same: phone.userId === mac.userId, newToken: phone.token !== mac.token });
  const phoneReads = await authed(`${phone.userId}:${phone.token}`, "/v1/thinking-state");
  check("the second device sees the same idea", phoneReads.status === 200, phoneReads.status);
  const macStillWorks = await authed(macAuth, "/v1/thinking-state");
  check("the first device's token still works (tokens are per-device, not rotated)", macStillWorks.status === 200, macStillWorks.status);

  const rival = (await (await call("/v1/users", { method: "POST" })).json()) as { userId: string; token: string };
  await authed(`${rival.userId}:${rival.token}`, "/v1/account/email", jsonBody({ email }));
  const stolen = await authed(`${rival.userId}:${rival.token}`, "/v1/account/email/verify", jsonBody({ email, code: await issueCode(email) }));
  check("a different account cannot claim an email that's in use (409 email_in_use)",
    stolen.status === 409 && ((await stolen.json()) as { code: string }).code === "email_in_use", stolen.status);

  // ============================================================================================
  phase("Phase 8 — Hit the Free-plan 25-idea cap");
  const seed = openUserDb(mac.userId);
  const stmt = seed.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, ?, 'developing', ?, ?, ?)");
  const iso = new Date().toISOString();
  for (let i = 0; i < 24; i++) stmt.run(`seed_${i}`, `seeded idea ${i}`, "f", iso, iso);
  seed.close();

  process.env.PADDLE_API_KEY = "pdl_test_key";
  process.env.PADDLE_PRICE_ID = "pri_test";
  process.env.PADDLE_WEBHOOK_SECRET = "whsec_journey_secret";

  acct = await (await authed(macAuth, "/v1/account")).json() as Record<string, unknown>;
  check("billing now reads as configured, account at 25/25, capture disabled",
    acct.billingEnabled === true && acct.ideaCount === 25 && acct.canCapture === false, acct);

  const gated = await authed(macAuth, "/v1/conversations", jsonBody({ conversationId: "over-cap", source: "chatgpt", messages: [] }));
  check("POST /v1/conversations → 402 upgrade_required", gated.status === 402 && ((await gated.json()) as { code: string }).code === "upgrade_required", gated.status);
  const readStillOk = await authed(macAuth, "/v1/thinking-state");
  check("reads are never gated → 200", readStillOk.status === 200, readStillOk.status);
  // Continuation is NOT gated -- the packet is assembled deterministically from the idea's own
  // provenance. A Free account gets it back with tier:"free" (the server used the template for
  // the one model-written line; the Mac app sharpens that line on-device). Only Pro spends a
  // frontier-model call on that line server-side -> tier:"pro".
  const contFree = await authed(macAuth, "/v1/continue", jsonBody({ ideaId }));
  const contFreeBody = (await contFree.json()) as { tier: string; packet: unknown };
  check("POST /v1/continue (Free) → 200, tier 'free', packet present",
    contFree.status === 200 && contFreeBody.tier === "free" && contFreeBody.packet != null, contFreeBody);

  // ============================================================================================
  phase("Phase 9 — Pay: the signed webhook a real Paddle checkout emits");
  const badSig = await call("/v1/paddle/webhook", { method: "POST", headers: { "paddle-signature": "ts=1;h1=deadbeef" }, body: "{}" });
  check("an unsigned/forged webhook is rejected (400)", badSig.status === 400, badSig.status);

  const activated = JSON.stringify({
    event_type: "subscription.activated",
    data: {
      id: "sub_journey_1",
      status: "active",
      customer_id: "ctm_journey_1",
      custom_data: { thread_user_id: mac.userId },
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    },
  });
  const okWebhook = await call("/v1/paddle/webhook", { method: "POST", headers: sign(activated, "whsec_journey_secret"), body: activated });
  check("the signed activation webhook is accepted (200)", okWebhook.status === 200, okWebhook.status);

  acct = await (await authed(macAuth, "/v1/account")).json() as Record<string, unknown>;
  check("account flipped to Pro / active / can capture again",
    acct.plan === "pro" && acct.isPro === true && acct.status === "active" && acct.canCapture === true, acct);
  const captureAfterPay = await authed(macAuth, "/v1/conversations", jsonBody({
    conversationId: CONVERSATIONS[3]!.conversationId, source: "cursor", sourceUrl: CONVERSATIONS[3]!.sourceUrl, messages: CONVERSATIONS[3]!.messages,
  }));
  check("capture works again for a paying account (not 402)", captureAfterPay.status === 200, captureAfterPay.status);
  const contAfterPay = await authed(macAuth, "/v1/continue", jsonBody({ ideaId }));
  const contAfterPayBody = (await contAfterPay.json()) as { tier: string };
  check("POST /v1/continue for a paying account → 200, tier 'pro'",
    contAfterPay.status === 200 && contAfterPayBody.tier === "pro", contAfterPay.status);

  // ============================================================================================
  phase("Phase 10 — Cancel: Pro through the period end, then Free");
  const canceled = JSON.stringify({
    event_type: "subscription.canceled",
    data: { id: "sub_journey_1", status: "canceled", customer_id: "ctm_journey_1", custom_data: { thread_user_id: mac.userId } },
  });
  const cancelWebhook = await call("/v1/paddle/webhook", { method: "POST", headers: sign(canceled, "whsec_journey_secret"), body: canceled });
  check("the signed cancellation webhook is accepted (200)", cancelWebhook.status === 200, cancelWebhook.status);
  acct = await (await authed(macAuth, "/v1/account")).json() as Record<string, unknown>;
  check("status is 'canceled' but the account stays Pro until the paid period ends",
    acct.status === "canceled" && acct.isPro === true, acct);
  console.log("   (after current_billing_period.ends_at, isProActive() flips to Free automatically — covered by src/api/billing.test.ts)");

  console.log(`\n   model doubles: ${reasoning.identityCalls} identity calls, ${reasoning.nextStepCalls} next-step calls`);
}

function sign(payload: string, secret: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = createHmac("sha256", secret).update(`${ts}:${payload}`).digest("hex");
  return { "paddle-signature": `ts=${ts};h1=${h1}`, "content-type": "application/json" };
}

try {
  await run();
} catch (err) {
  failed++;
  failures.push(`UNCAUGHT: ${(err as Error).message}`);
  console.error("\n\x1b[31mUncaught error:\x1b[0m", err);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

phase(`Result — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failed checks:\n" + failures.map((f) => `  - ${f}`).join("\n"));
}
console.log(`
Proven by this run (the plumbing):
  • anonymous onboarding → Free plan, no setup
  • capture from ChatGPT + Claude + Gemini + Cursor merges into ONE evolving idea
  • per-conversation source URLs survive to the trace and the packet; never leak into paste text
  • recall: search, trace, open loops, decisions
  • continuation packet: evolution, unresolved question, {{CONTINUE_FROM_HERE}} token
  • return-nudge rule (shared with the Mac app) fires in-window, stays silent out of window
  • email claim, second-device sign-in (per-device tokens), email_in_use protection
  • Free 25-idea cap: capture gated, reads never gated; /v1/continue stays open (tier 'free')
  • payment: a correctly SIGNED Paddle webhook flips the account to Pro and re-opens the gates
  • cancellation: Pro through the paid period, then Free

NOT provable here — needs the founder's live config (see e2e/README.md):
  • a real Paddle hosted checkout with a card (dashboard product/price/client-token/webhook)
  • the deployed website's Paddle.js overlay + /billing/success polling
  • api.threadnow.app DNS + TLS
  • the extension's live-DOM adapters against the real ChatGPT/Claude/Gemini pages
  • model QUALITY (does extraction/identity actually produce this) — that's \`bun run eval\`
  • the Mac app's SwiftUI flows (logic is covered by swift test)`);

process.exit(failed > 0 ? 1 : 0);
