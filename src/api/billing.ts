import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { findAccountByStripeCustomer, updateSubscription, type Account, type SubscriptionStatus } from "./auth";

/**
 * Stripe billing, done with plain `fetch` + manual webhook-signature verification -- no `stripe`
 * SDK dependency (keeps the single-binary, Railpack-friendly build). Trial is 7 days, granted at
 * account creation and tracked locally (no card); converting to Pro is a Stripe Checkout. Access
 * is a SOFT lock: reads always work so you can recover your thinking; only new captures are gated.
 *
 * Required env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID.
 * Optional: APP_PUBLIC_URL (redirect base; defaults to the marketing site).
 */

const STRIPE_API = "https://api.stripe.com/v1";
const PUBLIC_URL = () => process.env.APP_PUBLIC_URL ?? "https://mind-stream-continuity.vercel.app";

export function billingConfigured(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

/** The gate. True = allowed to capture. Reads are never gated on this. */
export function isEntitled(account: Account | null, now: Date = new Date()): boolean {
  if (!account) return false;
  switch (account.status) {
    case "active":
    case "past_due": // grace: Stripe is still retrying payment
      return true;
    case "trialing":
      return account.trialEndsAt != null && new Date(account.trialEndsAt) > now;
    case "canceled":
      // Canceled but paid through the end of the current period.
      return account.currentPeriodEnd != null && new Date(account.currentPeriodEnd) > now;
    default:
      return false;
  }
}

/** Shape the Mac app / website read from GET /v1/account. */
export function accountView(account: Account, now: Date = new Date()): {
  status: SubscriptionStatus;
  entitled: boolean;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
} {
  const trialDaysLeft =
    account.status === "trialing" && account.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(account.trialEndsAt).getTime() - now.getTime()) / 86_400_000))
      : null;
  return {
    status: account.status,
    entitled: isEntitled(account, now),
    trialEndsAt: account.trialEndsAt,
    trialDaysLeft,
    currentPeriodEnd: account.currentPeriodEnd,
  };
}

async function stripe(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new Error(`Stripe ${res.status}: ${err?.message ?? "request failed"}`);
  }
  return body;
}

export async function createCheckoutSession(userId: string, account: Account): Promise<string> {
  const form: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": process.env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    client_reference_id: userId,
    "subscription_data[metadata][thread_user_id]": userId,
    success_url: `${PUBLIC_URL()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_URL()}/pricing?canceled=1`,
    allow_promotion_codes: "true",
  };
  if (account.stripeCustomerId) form.customer = account.stripeCustomerId;
  const session = await stripe("/checkout/sessions", form);
  return session.url as string;
}

export async function createPortalSession(account: Account): Promise<string> {
  if (!account.stripeCustomerId) throw new Error("No Stripe customer for this account");
  const session = await stripe("/billing_portal/sessions", {
    customer: account.stripeCustomerId,
    return_url: `${PUBLIC_URL()}/account`,
  });
  return session.url as string;
}

// --- Webhook signature verification (Stripe's t=/v1= scheme) ---------------------------------

const TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(payload: string, sigHeader: string, secret: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && nodeTimingSafeEqual(a, b);
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

/** Apply a verified webhook event to the local account row. Idempotent. */
export function applyStripeEvent(event: StripeEvent): void {
  const obj = event.data.object;

  const userIdFromEvent = (): string | null => {
    const ref = (obj.client_reference_id as string) ?? null;
    if (ref) return ref;
    const meta = (obj.metadata as Record<string, string> | undefined) ?? {};
    if (meta.thread_user_id) return meta.thread_user_id;
    const customer = obj.customer as string | undefined;
    if (customer) return findAccountByStripeCustomer(customer)?.userId ?? null;
    return null;
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const userId = userIdFromEvent();
      if (!userId) return;
      updateSubscription(userId, {
        status: "active",
        stripeCustomerId: obj.customer as string,
      });
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const userId = userIdFromEvent();
      if (!userId) return;
      const status = mapSubStatus(obj.status as string);
      const periodEnd = obj.current_period_end as number | undefined;
      updateSubscription(userId, {
        status,
        stripeCustomerId: obj.customer as string,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      });
      return;
    }
    case "customer.subscription.deleted": {
      const userId = userIdFromEvent();
      if (!userId) return;
      updateSubscription(userId, { status: "canceled" });
      return;
    }
    default:
      return; // ignore everything else
  }
}

function mapSubStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active"; // a Stripe trial still means "paying customer" to us
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return "incomplete";
  }
}
