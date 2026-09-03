/**
 * Identity, sign-in, and "remember me" simulation.
 *
 *   bun run e2e:identity
 *
 * Proves the passwordless account model end to end through the real HTTP handler AND by
 * inspecting registry.db directly: how a 6-digit code behaves (TTL, single-use, attempt cap,
 * rate limit, hashed at rest), how per-device bearer tokens work (hashed at rest, many live at
 * once, one device signing out doesn't touch the others), how the email is stored and matched,
 * how an anonymous account is claimed without losing data, and that everything survives a
 * process restart. Deterministic, no network, no API key.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../src/providers/types";

class Noop implements CompletionProvider {
  async complete(): Promise<string> {
    return "{}";
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
const phase = (t: string) => console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);

const tmp = mkdtempSync(join(tmpdir(), "thread-identity-"));
process.env.THREAD_REGISTRY_PATH = join(tmp, "registry.db");
process.env.THREAD_DATA_DIR = join(tmp, "users");
for (const k of ["PADDLE_API_KEY", "PADDLE_PRICE_ID", "PADDLE_WEBHOOK_SECRET"]) delete process.env[k];

async function run(): Promise<void> {
  const { createRequestHandler } = await import("../src/api/handler");
  const { issueCode, consumeCode } = await import("../src/api/authCodes");
  const { openRegistry, sha256Hex, verifyToken, getAccount, setPlan } = await import("../src/api/auth");
  const { applyPaddleEvent } = await import("../src/api/billing");
  const { openUserDb } = await import("../src/db/tenancy");

  let handler = createRequestHandler({ extraction: new Noop(), reasoning: new Noop() });
  const call = (p: string, init: RequestInit = {}) => handler(new Request(`http://id${p}`, init));
  const authed = (tok: string, p: string, init: RequestInit = {}) =>
    call(p, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${tok}`, "content-type": "application/json" } });
  const post = (v: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(v) });
  const startVerify = async (path: "/v1/auth/verify" | "/v1/account/email/verify", email: string, code: string, tok?: string) =>
    tok ? authed(tok, path, post({ email, code })) : call(path, post({ email, code }));

  // ============================================================================================
  phase("Phase 1 — The 6-digit code: TTL, single-use, attempt cap, rate limit, hashed at rest");
  const cEmail = `code-${Date.now()}@example.com`;

  const codeNow = await issueCode(cEmail);
  check("issueCode returns a 6-digit numeric code", /^\d{6}$/.test(codeNow), codeNow);

  const reg = openRegistry();
  const stored = reg.query("SELECT code_hash, expires_at FROM login_codes WHERE email = ?").get(cEmail) as { code_hash: string; expires_at: string };
  check("the code is stored HASHED, never in the clear", stored.code_hash === (await sha256Hex(codeNow)) && stored.code_hash !== codeNow, stored.code_hash);
  check("the code carries a ~10-minute expiry", Date.parse(stored.expires_at) - Date.now() > 8 * 60_000 && Date.parse(stored.expires_at) - Date.now() <= 10 * 60_000);
  reg.close();

  check("an expired code is rejected", (await consumeCode(cEmail, codeNow, Date.now() + 11 * 60_000)) === false);
  const fresh = await issueCode(cEmail);
  check("a correct, live code verifies", (await consumeCode(cEmail, fresh)) === true);
  check("...and is single-use — the same code fails the second time", (await consumeCode(cEmail, fresh)) === false);

  const attEmail = `attempts-${Date.now()}@example.com`;
  const real = await issueCode(attEmail);
  for (let i = 0; i < 5; i++) await consumeCode(attEmail, "000000");
  check("5 wrong guesses burn the code — even the correct one then fails", (await consumeCode(attEmail, real)) === false);

  const rlEmail = `ratelimit-${Date.now()}@example.com`;
  let rateLimited = false;
  for (let i = 0; i < 6; i++) {
    try {
      await issueCode(rlEmail);
    } catch (e) {
      rateLimited = (e as Error).name === "RateLimitedError";
    }
  }
  check("6th code request within an hour → RateLimitedError (→ HTTP 429)", rateLimited);

  // The public endpoint never reveals any of this:
  const startRes = await call("/v1/auth/start", post({ email: `probe-${Date.now()}@example.com` }));
  check("POST /v1/auth/start is always 200 {ok:true} (no account enumeration)",
    startRes.status === 200 && JSON.stringify(await startRes.json()) === '{"ok":true}');

  // ============================================================================================
  phase("Phase 2 — First launch: anonymous account, zero setup, no email");
  const anon = (await (await call("/v1/users", { method: "POST" })).json()) as { userId: string; token: string };
  check("POST /v1/users mints user_<24hex>:<64hex>", /^user_[a-f0-9]{24}$/.test(anon.userId) && /^[a-f0-9]{64}$/.test(anon.token), anon.userId);
  const a0 = (await (await authed(`${anon.userId}:${anon.token}`, "/v1/account")).json()) as Record<string, unknown>;
  check("GET /v1/account → email null, plan free, billing not enabled", a0.email === null && a0.plan === "free" && a0.billingEnabled === false, a0);

  // capture one idea so we can prove data survives the claim + a restart
  const seed = openUserDb(anon.userId);
  seed.prepare("INSERT INTO idea_nodes (id,title,state,current_formulation,created_at,updated_at) VALUES ('idea_mine','My idea','developing','f',?,?)").run(new Date().toISOString(), new Date().toISOString());
  seed.close();

  // ============================================================================================
  phase("Phase 3 — Token storage: opaque, hashed at rest, one-time reveal");
  const rows = openRegistry();
  const trow = rows.query("SELECT token_hash FROM auth_tokens WHERE user_id = ?").get(anon.userId) as { token_hash: string };
  check("the bearer token is stored HASHED (sha256), not in the clear",
    trow.token_hash === (await sha256Hex(anon.token)) && trow.token_hash !== anon.token, trow.token_hash);
  const urow = rows.query("SELECT token_hash, email FROM users WHERE id = ?").get(anon.userId) as { token_hash: string; email: string | null };
  check("users.email is NULL for an anonymous account", urow.email === null);
  rows.close();
  check("a malformed Authorization header → 401", (await authed("not-a-real-token", "/v1/account")).status === 401);
  check("right userId + wrong token → 401", (await authed(`${anon.userId}:${"0".repeat(64)}`, "/v1/account")).status === 401);

  // ============================================================================================
  phase("Phase 4 — Claim: attach an email, keep every idea");
  const email = `owner-${Date.now()}@example.com`;
  await authed(`${anon.userId}:${anon.token}`, "/v1/account/email", post({ email }));
  const claim = await startVerify("/v1/account/email/verify", email, await issueCode(email), `${anon.userId}:${anon.token}`);
  check("claim verifies (200) and echoes the email", claim.status === 200 && ((await claim.json()) as { email: string }).email === email);

  const stored2 = openRegistry();
  const claimed = stored2.query("SELECT email, email_verified_at FROM users WHERE id = ?").get(anon.userId) as { email: string; email_verified_at: string };
  check("email is stored (plaintext — it's an identifier, and we must email to it) with a verified-at timestamp",
    claimed.email === email && !!claimed.email_verified_at, claimed);
  stored2.close();

  const ideasAfterClaim = (await (await authed(`${anon.userId}:${anon.token}`, "/v1/ideas?q=idea")).json()) as unknown[];
  check("the idea captured before the email is still there", ideasAfterClaim.length === 1, ideasAfterClaim);
  check("the original device token still works after the claim", (await authed(`${anon.userId}:${anon.token}`, "/v1/account")).status === 200);

  // ============================================================================================
  phase("Phase 5 — Sign in on more devices: many live tokens, case-insensitive email");
  const phone = (await (await startVerify("/v1/auth/verify", email.toUpperCase(), await issueCode(email))).json()) as { userId: string; token: string };
  check("signing in with EMAIL.toUpperCase() lands on the SAME account", phone.userId === anon.userId && phone.token !== anon.token, phone.userId);
  const laptop = (await (await startVerify("/v1/auth/verify", email, await issueCode(email))).json()) as { userId: string; token: string };

  check("all three device tokens authenticate at the same time (per-device, nothing rotated)",
    (await verifyToken(anon.userId, anon.token)) &&
      (await verifyToken(phone.userId, phone.token)) &&
      (await verifyToken(laptop.userId, laptop.token)));

  const tokenCount = () => {
    const r = openRegistry();
    const n = (r.query("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ?").get(anon.userId) as { n: number }).n;
    r.close();
    return n;
  };
  check("registry shows 3 live tokens for the one account", tokenCount() === 3, tokenCount());

  // ============================================================================================
  phase("Phase 6 — Sign out one device");
  // "Sign out" / "Unpair" in the clients discards the LOCAL token only — there is no server-side
  // revoke endpoint today, so the other devices are untouched by construction.
  check("after the phone 'signs out' locally, the Mac + laptop tokens still work",
    (await verifyToken(anon.userId, anon.token)) && (await verifyToken(anon.userId, laptop.token)));
  check("NOTE: the phone's token hash is still in auth_tokens — no server-side revoke exists yet",
    tokenCount() === 3);

  // ============================================================================================
  phase("Phase 7 — One account per email");
  const rival = (await (await call("/v1/users", { method: "POST" })).json()) as { userId: string; token: string };
  await authed(`${rival.userId}:${rival.token}`, "/v1/account/email", post({ email }));
  const collision = await startVerify("/v1/account/email/verify", email, await issueCode(email), `${rival.userId}:${rival.token}`);
  check("a second account claiming an in-use email (that has data) → 409 email_in_use",
    collision.status === 409 && ((await collision.json()) as { code: string }).code === "email_in_use", collision.status);

  const strayEmail = `stray-${Date.now()}@example.com`;
  const stray = (await (await startVerify("/v1/auth/verify", strayEmail, await issueCode(strayEmail))).json()) as { userId: string };
  check("signing in with a NEW email find-or-creates a fresh account", stray.userId !== anon.userId && /^user_/.test(stray.userId));
  // stray has no ideas → a real account can reclaim that email
  const macWithData = (await (await call("/v1/users", { method: "POST" })).json()) as { userId: string; token: string };
  openUserDb(macWithData.userId).prepare("INSERT INTO idea_nodes (id,title,state,current_formulation,created_at,updated_at) VALUES ('i','t','developing','f',?,?)").run(new Date().toISOString(), new Date().toISOString());
  await authed(`${macWithData.userId}:${macWithData.token}`, "/v1/account/email", post({ email: strayEmail }));
  const reclaimed = await startVerify("/v1/account/email/verify", strayEmail, await issueCode(strayEmail), `${macWithData.userId}:${macWithData.token}`);
  const rbody = (await reclaimed.json()) as { email: string; reclaimedFromEmptyAccount?: boolean };
  check("an email sitting on an EMPTY account is reclaimed onto the one with data, not blocked",
    reclaimed.status === 200 && rbody.email === strayEmail && rbody.reclaimedFromEmptyAccount === true, rbody);

  // ============================================================================================
  phase("Phase 8 — Charging maps to the account; Pro follows the account to every device");
  process.env.PADDLE_API_KEY = "pdl_t";
  process.env.PADDLE_PRICE_ID = "pri_t";
  process.env.PADDLE_WEBHOOK_SECRET = "whsec_id";
  applyPaddleEvent({
    event_type: "subscription.activated",
    data: { id: "sub_id", customer_id: "ctm_id", status: "active", custom_data: { thread_user_id: anon.userId }, current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() } },
  });
  const macAcct = (await (await authed(`${anon.userId}:${anon.token}`, "/v1/account")).json()) as Record<string, unknown>;
  const laptopAcct = (await (await authed(`${laptop.userId}:${laptop.token}`, "/v1/account")).json()) as Record<string, unknown>;
  check("the payment (keyed by thread_user_id) makes the ACCOUNT Pro — seen from every device",
    macAcct.plan === "pro" && macAcct.isPro === true && laptopAcct.plan === "pro" && laptopAcct.isPro === true, { macAcct, laptopAcct });
  const regPaid = openRegistry();
  const paidRow = regPaid.query("SELECT paddle_customer_id, paddle_subscription_id, current_period_end FROM users WHERE id = ?").get(anon.userId) as Record<string, unknown>;
  regPaid.close();
  check("the Paddle customer + subscription ids are stored on the account (so later portal events resolve)",
    paidRow.paddle_customer_id === "ctm_id" && paidRow.paddle_subscription_id === "sub_id" && !!paidRow.current_period_end, paidRow);
  const brandNewDevice = (await (await startVerify("/v1/auth/verify", email, await issueCode(email))).json()) as { userId: string; token: string };
  const newDeviceAcct = (await (await authed(`${brandNewDevice.userId}:${brandNewDevice.token}`, "/v1/account")).json()) as Record<string, unknown>;
  check("sign in on a brand-new device → immediately Pro (entitlement is on the account, not the device)", newDeviceAcct.isPro === true, newDeviceAcct);

  // ============================================================================================
  phase("Phase 9 — 'Remember me' across a server restart");
  handler = createRequestHandler({ extraction: new Noop(), reasoning: new Noop() }); // fresh process, same THREAD_* dirs
  const afterRestart = await authed(`${anon.userId}:${anon.token}`, "/v1/account");
  const arBody = (await afterRestart.json()) as Record<string, unknown>;
  check("the same token still authenticates after a restart (registry.db is durable)", afterRestart.status === 200, afterRestart.status);
  check("  → still the same email, still Pro, ideas intact",
    arBody.email === email && arBody.isPro === true &&
      ((await (await authed(`${anon.userId}:${anon.token}`, "/v1/ideas?q=idea")).json()) as unknown[]).length === 1, arBody);
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
How it works, confirmed by this run:
  • No password. Sign-in = email + a 6-digit code: random, SHA-256-hashed at rest, 10-min TTL,
    single-use, 5-attempt cap, 5-issues-per-hour-per-email limit. The email inbox IS the factor.
  • The email is stored in plaintext on the account row (it's an identifier and we must send to
    it), lower-cased for matching, unique — one account per email, many email-less accounts fine.
  • A device is remembered by an opaque bearer token (user_<24hex>:<64hex>), SHA-256-hashed at
    rest, shown once. Per-device: an account holds many live tokens; signing in adds one and
    rotates nothing. (Gap: no server-side revoke — 'sign out' only drops the local copy.)
  • First launch mints an anonymous Free account so capture works with zero setup; attaching an
    email later keeps every idea.
  • Charging: Paddle checkout on the website carries thread_user_id; the signed webhook flips
    users.plan and stores paddle_customer_id/subscription_id. Entitlement lives on the ACCOUNT,
    so it's Pro on every device the moment they sign in.
  • Durability: registry.db (users + auth_tokens + login_codes) must sit on a persistent volume
    or every token 401s after a redeploy.`);

process.exit(failed > 0 ? 1 : 0);
