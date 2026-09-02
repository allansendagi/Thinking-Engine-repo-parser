import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import {
  findAccountByPaddleCustomer,
  setPlan,
  type Account,
  type Plan,
  type SubscriptionStatus,
} from "./auth";

/**
 * Paddle billing (Merchant of Record), done with plain `fetch` + manual webhook-signature
 * verification -- no Paddle SDK, keeping the single-binary build.
 *
 * Model: one permanent **Free** plan (capture up to FREE_IDEA_CAP idea nodes, unlimited reads
 * forever) + one **Pro** plan (unlimited capture + MCP/AI access). No timed trial. Checkout
 * happens on the website with Paddle.js; this module only verifies webhooks and mints the
 * customer-portal link. Access is a SOFT lock: reads always work, only new capture / AI is gated.
 *
 * Required env: PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_PRICE_ID.
 * Optional: PADDLE_ENV ("sandbox" | "production", default "production"), PADDLE_PRICE_ID_YEARLY,
 * APP_PUBLIC_URL (portal return URL; defaults to the marketing site).
 */

const PUBLIC_URL = () => process.env.APP_PUBLIC_URL ?? "https://mind-stream-continuity.vercel.app";
const paddleApiBase = () =>
  process.env.PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

/** Free accounts may capture up to this many idea nodes before Pro is required. */
export const FREE_IDEA_CAP = 25;

export function billingConfigured(): boolean {
  return !!(process.env.PADDLE_API_KEY && process.env.PADDLE_PRICE_ID && process.env.PADDLE_WEBHOOK_SECRET);
}

/** Pro and currently paying (or in grace / paid-through-period-end). Gates MCP + /v1/continue. */
export function isProActive(account: Account | null, now: Date = new Date()): boolean {
  if (!account || account.plan !== "pro") return false;
  switch (account.status) {
    case "active":
    case "past_due":
      return true;
    case "canceled":
      return account.currentPeriodEnd != null && new Date(account.currentPeriodEnd) > now;
    default:
      return false;
  }
}

/** The capture gate. `ideaCount` is this user's current idea-node count. */
export function canCapture(account: Account | null, ideaCount: number, now: Date = new Date()): boolean {
  if (isProActive(account, now)) return true;
  return ideaCount < FREE_IDEA_CAP;
}

/** Shape the Mac app / website read from GET /v1/account. */
export function accountView(account: Account, ideaCount: number, now: Date = new Date()): {
  plan: Plan;
  status: SubscriptionStatus;
  isPro: boolean;
  canCapture: boolean;
  ideaCount: number;
  ideaCap: number;
  currentPeriodEnd: string | null;
  email: string | null;
  billingEnabled: boolean;
} {
  return {
    plan: account.plan,
    status: account.status,
    isPro: isProActive(account, now),
    canCapture: canCapture(account, ideaCount, now),
    ideaCount,
    ideaCap: FREE_IDEA_CAP,
    currentPeriodEnd: account.currentPeriodEnd,
    email: account.email,
    billingEnabled: billingConfigured(),
  };
}

async function paddle(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${paddleApiBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { detail?: string } | undefined;
    throw new Error(`Paddle ${res.status}: ${err?.detail ?? "request failed"}`);
  }
  return body;
}

/** An authenticated Paddle customer-portal link (self-serve cancel / update card / invoices). */
export async function createPortalLink(account: Account): Promise<string> {
  if (!account.paddleCustomerId) throw new Error("No Paddle customer for this account");
  const body = await paddle(`/customers/${account.paddleCustomerId}/portal-sessions`, {
    method: "POST",
    body: JSON.stringify(
      account.paddleSubscriptionId ? { subscription_ids: [account.paddleSubscriptionId] } : {},
    ),
  });
  const data = body.data as
    | { urls?: { general?: { overview?: string } } }
    | undefined;
  const url = data?.urls?.general?.overview;
  if (!url) throw new Error("Paddle did not return a portal URL");
  return url;
}

// --- Webhook signature verification (Paddle's `ts=..;h1=..` scheme) --------------------------

const TOLERANCE_SECONDS = 300;

export function verifyPaddleSignature(payload: string, sigHeader: string, secret: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(
    sigHeader.split(";").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  ) as { ts?: string; h1?: string };
  if (!parts.ts || !parts.h1) return false;

  const timestamp = Number(parts.ts);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${parts.ts}:${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.h1, "hex");
  return a.length === b.length && nodeTimingSafeEqual(a, b);
}

interface PaddleEvent {
  event_type: string;
  data: Record<string, unknown>;
}

/** Map a Paddle subscription status onto our local union. */
export function mapPaddleStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "paused":
      return "canceled";
    default:
      return "incomplete";
  }
}

/** Apply a verified Paddle webhook event to the local account row. Idempotent. */
export function applyPaddleEvent(event: PaddleEvent): void {
  const data = event.data ?? {};
  const customData = (data.custom_data as Record<string, string> | null) ?? {};
  const customerId = (data.customer_id as string | undefined) ?? undefined;

  const resolveUserId = (): string | null => {
    if (customData.thread_user_id) return customData.thread_user_id;
    if (customerId) return findAccountByPaddleCustomer(customerId)?.userId ?? null;
    return null;
  };

  switch (event.event_type) {
    case "subscription.activated":
    case "subscription.created":
    case "subscription.updated":
    case "subscription.resumed": {
      const userId = resolveUserId();
      if (!userId) return;
      const period = data.current_billing_period as { ends_at?: string } | undefined;
      setPlan(userId, {
        plan: "pro",
        status: mapPaddleStatus(data.status as string),
        paddleCustomerId: customerId ?? null,
        paddleSubscriptionId: (data.id as string | undefined) ?? null,
        currentPeriodEnd: period?.ends_at ?? null,
      });
      return;
    }
    case "subscription.past_due": {
      const userId = resolveUserId();
      if (!userId) return;
      setPlan(userId, { plan: "pro", status: "past_due", paddleCustomerId: customerId ?? null });
      return;
    }
    case "subscription.canceled":
    case "subscription.paused": {
      const userId = resolveUserId();
      if (!userId) return;
      // Stays Pro until currentPeriodEnd; the capture gate treats it as Free after that.
      setPlan(userId, { status: "canceled" });
      return;
    }
    case "transaction.completed": {
      // Activation rides the subscription event; just make sure we can resolve the customer later.
      const userId = customData.thread_user_id ?? null;
      if (userId && customerId) setPlan(userId, { paddleCustomerId: customerId });
      return;
    }
    default:
      return; // ignore everything else
  }
}
