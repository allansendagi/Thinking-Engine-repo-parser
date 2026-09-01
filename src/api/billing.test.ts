import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountView, applyStripeEvent, isEntitled, verifyStripeSignature } from "./billing";
import { createUser, getAccount, updateSubscription } from "./auth";
import type { Account } from "./auth";

const base: Account = {
  userId: "user_" + "a".repeat(24),
  status: "trialing",
  trialEndsAt: null,
  currentPeriodEnd: null,
  stripeCustomerId: null,
};
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("isEntitled", () => {
  test("trial in the future is entitled; expired trial is not", () => {
    expect(isEntitled({ ...base, status: "trialing", trialEndsAt: inDays(3) })).toBe(true);
    expect(isEntitled({ ...base, status: "trialing", trialEndsAt: inDays(-1) })).toBe(false);
    expect(isEntitled({ ...base, status: "trialing", trialEndsAt: null })).toBe(false);
  });
  test("active and past_due are entitled", () => {
    expect(isEntitled({ ...base, status: "active" })).toBe(true);
    expect(isEntitled({ ...base, status: "past_due" })).toBe(true);
  });
  test("canceled is entitled only through the paid period", () => {
    expect(isEntitled({ ...base, status: "canceled", currentPeriodEnd: inDays(10) })).toBe(true);
    expect(isEntitled({ ...base, status: "canceled", currentPeriodEnd: inDays(-1) })).toBe(false);
  });
  test("null account is not entitled", () => {
    expect(isEntitled(null)).toBe(false);
  });
});

describe("accountView", () => {
  test("reports trialDaysLeft, rounded up, floored at 0", () => {
    const v = accountView({ ...base, status: "trialing", trialEndsAt: inDays(2.2) });
    expect(v.trialDaysLeft).toBe(3);
    expect(v.entitled).toBe(true);
    const gone = accountView({ ...base, status: "trialing", trialEndsAt: inDays(-2) });
    expect(gone.trialDaysLeft).toBe(0);
    expect(gone.entitled).toBe(false);
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const payload = '{"hello":"world"}';
  const sign = (ts: number, body: string, key = secret) =>
    `t=${ts},v1=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}`;

  test("accepts a correctly signed, fresh payload", () => {
    const now = Date.now();
    expect(verifyStripeSignature(payload, sign(Math.floor(now / 1000), payload), secret, now)).toBe(true);
  });
  test("rejects a wrong secret, a tampered body, a stale timestamp, and junk", () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    expect(verifyStripeSignature(payload, sign(t, payload, "whsec_wrong"), secret, now)).toBe(false);
    expect(verifyStripeSignature('{"hello":"tampered"}', sign(t, payload), secret, now)).toBe(false);
    expect(verifyStripeSignature(payload, sign(t - 10_000, payload), secret, now)).toBe(false);
    expect(verifyStripeSignature(payload, "not-a-signature", secret, now)).toBe(false);
  });
});

describe("applyStripeEvent (against a real registry.db)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "thread-billing-"));
    process.env.THREAD_REGISTRY_PATH = join(tmp, "registry.db");
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.THREAD_REGISTRY_PATH;
  });

  let userId: string;
  beforeEach(async () => {
    userId = (await createUser()).userId;
  });

  test("new account starts on a 14-day trial and is entitled", () => {
    const acct = getAccount(userId)!;
    expect(acct.status).toBe("trialing");
    expect(isEntitled(acct)).toBe(true);
    expect(accountView(acct).trialDaysLeft).toBe(14);
  });

  test("checkout.session.completed activates and stores the customer", () => {
    applyStripeEvent({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: userId, customer: "cus_123" } },
    });
    const acct = getAccount(userId)!;
    expect(acct.status).toBe("active");
    expect(acct.stripeCustomerId).toBe("cus_123");
  });

  test("subscription.updated maps status + period end; mapping customer->user via the stored id", () => {
    updateSubscription(userId, { stripeCustomerId: "cus_456" });
    const periodEnd = Math.floor((Date.now() + 30 * 86_400_000) / 1000);
    applyStripeEvent({
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_456", status: "past_due", current_period_end: periodEnd } },
    });
    const acct = getAccount(userId)!;
    expect(acct.status).toBe("past_due");
    expect(new Date(acct.currentPeriodEnd!).getTime()).toBeGreaterThan(Date.now());
  });

  test("subscription.deleted cancels", () => {
    updateSubscription(userId, { stripeCustomerId: "cus_789", status: "active" });
    applyStripeEvent({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_789" } },
    });
    expect(getAccount(userId)!.status).toBe("canceled");
  });
});
