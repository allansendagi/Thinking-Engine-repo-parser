import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountView,
  applyPaddleEvent,
  canCapture,
  FREE_IDEA_CAP,
  isProActive,
  mapPaddleStatus,
  verifyPaddleSignature,
} from "./billing";
import { createUser, getAccount, setPlan } from "./auth";
import type { Account } from "./auth";

const base: Account = {
  userId: "user_" + "a".repeat(24),
  email: null,
  emailVerifiedAt: null,
  plan: "free",
  status: "free",
  currentPeriodEnd: null,
  paddleCustomerId: null,
  paddleSubscriptionId: null,
  trialEndsAt: null,
};
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const pro = (over: Partial<Account> = {}): Account => ({ ...base, plan: "pro", status: "active", ...over });

describe("isProActive", () => {
  test("pro + active/past_due is active", () => {
    expect(isProActive(pro({ status: "active" }))).toBe(true);
    expect(isProActive(pro({ status: "past_due" }))).toBe(true);
  });
  test("pro + canceled is active only through the paid period", () => {
    expect(isProActive(pro({ status: "canceled", currentPeriodEnd: inDays(10) }))).toBe(true);
    expect(isProActive(pro({ status: "canceled", currentPeriodEnd: inDays(-1) }))).toBe(false);
  });
  test("free / null is never active", () => {
    expect(isProActive(base)).toBe(false);
    expect(isProActive(null)).toBe(false);
  });
});

describe("canCapture", () => {
  test("free is capped at FREE_IDEA_CAP idea nodes", () => {
    expect(canCapture(base, FREE_IDEA_CAP - 1)).toBe(true);
    expect(canCapture(base, FREE_IDEA_CAP)).toBe(false);
    expect(canCapture(base, FREE_IDEA_CAP + 40)).toBe(false);
  });
  test("active pro captures without limit", () => {
    expect(canCapture(pro(), FREE_IDEA_CAP + 999)).toBe(true);
  });
  test("lapsed pro (canceled past period end) falls back to the free cap", () => {
    const lapsed = pro({ status: "canceled", currentPeriodEnd: inDays(-1) });
    expect(canCapture(lapsed, FREE_IDEA_CAP - 1)).toBe(true);
    expect(canCapture(lapsed, FREE_IDEA_CAP)).toBe(false);
  });
});

describe("accountView", () => {
  test("free account shape", () => {
    const v = accountView(base, 18);
    expect(v).toMatchObject({ plan: "free", isPro: false, canCapture: true, ideaCount: 18, ideaCap: FREE_IDEA_CAP });
  });
  test("free account over the cap cannot capture", () => {
    expect(accountView(base, FREE_IDEA_CAP).canCapture).toBe(false);
  });
  test("pro account", () => {
    expect(accountView(pro(), 999)).toMatchObject({ plan: "pro", isPro: true, canCapture: true });
  });
});

describe("mapPaddleStatus", () => {
  test("maps the lifecycle onto the local union", () => {
    expect(mapPaddleStatus("active")).toBe("active");
    expect(mapPaddleStatus("trialing")).toBe("active");
    expect(mapPaddleStatus("past_due")).toBe("past_due");
    expect(mapPaddleStatus("canceled")).toBe("canceled");
    expect(mapPaddleStatus("paused")).toBe("canceled");
    expect(mapPaddleStatus("weird")).toBe("incomplete");
  });
});

describe("verifyPaddleSignature", () => {
  const secret = "pdl_ntfset_test";
  const payload = '{"hello":"world"}';
  const sign = (ts: number, body: string, key = secret) =>
    `ts=${ts};h1=${createHmac("sha256", key).update(`${ts}:${body}`).digest("hex")}`;

  test("accepts a correctly signed, fresh payload", () => {
    const now = Date.now();
    expect(verifyPaddleSignature(payload, sign(Math.floor(now / 1000), payload), secret, now)).toBe(true);
  });
  test("rejects a wrong secret, a tampered body, a stale timestamp, and junk", () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    expect(verifyPaddleSignature(payload, sign(t, payload, "pdl_wrong"), secret, now)).toBe(false);
    expect(verifyPaddleSignature('{"hello":"tampered"}', sign(t, payload), secret, now)).toBe(false);
    expect(verifyPaddleSignature(payload, sign(t - 10_000, payload), secret, now)).toBe(false);
    expect(verifyPaddleSignature(payload, "not-a-signature", secret, now)).toBe(false);
  });
});

describe("applyPaddleEvent (against a real registry.db)", () => {
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

  test("new account starts on Free", () => {
    const acct = getAccount(userId)!;
    expect(acct.plan).toBe("free");
    expect(isProActive(acct)).toBe(false);
    expect(canCapture(acct, 0)).toBe(true);
  });

  test("subscription.activated makes the account Pro, keyed by custom_data.thread_user_id", () => {
    const endsAt = inDays(30);
    applyPaddleEvent({
      event_type: "subscription.activated",
      data: {
        id: "sub_123",
        customer_id: "ctm_123",
        status: "active",
        custom_data: { thread_user_id: userId },
        current_billing_period: { ends_at: endsAt },
      },
    });
    const acct = getAccount(userId)!;
    expect(acct.plan).toBe("pro");
    expect(acct.status).toBe("active");
    expect(acct.paddleCustomerId).toBe("ctm_123");
    expect(acct.paddleSubscriptionId).toBe("sub_123");
    expect(acct.currentPeriodEnd).toBe(endsAt);
    expect(isProActive(acct)).toBe(true);
  });

  test("subscription.past_due keeps Pro but marks past_due; resolved via the stored customer id", () => {
    setPlan(userId, { plan: "pro", status: "active", paddleCustomerId: "ctm_456" });
    applyPaddleEvent({
      event_type: "subscription.past_due",
      data: { id: "sub_456", customer_id: "ctm_456", status: "past_due", custom_data: null },
    });
    const acct = getAccount(userId)!;
    expect(acct.plan).toBe("pro");
    expect(acct.status).toBe("past_due");
    expect(isProActive(acct)).toBe(true);
  });

  test("subscription.canceled stays usable through currentPeriodEnd, then not", () => {
    setPlan(userId, { plan: "pro", status: "active", paddleCustomerId: "ctm_789", currentPeriodEnd: inDays(5) });
    applyPaddleEvent({
      event_type: "subscription.canceled",
      data: { id: "sub_789", customer_id: "ctm_789", status: "canceled", custom_data: null },
    });
    const acct = getAccount(userId)!;
    expect(acct.status).toBe("canceled");
    expect(isProActive(acct)).toBe(true); // still within the paid period

    setPlan(userId, { currentPeriodEnd: inDays(-1) });
    expect(isProActive(getAccount(userId)!)).toBe(false);
  });

  test("an event for an unknown user is ignored", () => {
    applyPaddleEvent({
      event_type: "subscription.activated",
      data: { id: "sub_x", customer_id: "ctm_x", status: "active", custom_data: { thread_user_id: "user_" + "f".repeat(24) } },
    });
    // nothing thrown, our user untouched
    expect(getAccount(userId)!.plan).toBe("free");
  });
});
