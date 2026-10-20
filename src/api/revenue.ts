import type { Database } from "bun:sqlite";
import { adminEmails } from "./admin";
import { analyticsStart, openMetrics } from "./metrics";

/**
 * Subscriptions, measured: an append-only log of what Paddle told us (`billing_events`), so MRR,
 * revenue, churn and reactivation can be computed for any period -- the account row alone only
 * says what an account is *now*. Amounts and currency come from Paddle's payload, never assumed.
 * Paddle retries webhooks, so the log is keyed by Paddle's event id.
 *
 * Owner, admin and test accounts are left out of every number (THREAD_ADMIN_EMAILS +
 * THREAD_METRICS_EXCLUDE_USERS): at this size one test purchase would distort everything.
 */

function openRevenue(): Database {
  const db = openMetrics();
  db.exec(
    `CREATE TABLE IF NOT EXISTS billing_events (
       event_id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,            -- payment | refund | activated | canceled | past_due | resumed | paused
       user_id TEXT,
       amount_minor INTEGER,          -- payments/refunds: in the currency's minor unit (cents); refunds negative
       currency TEXT,
       interval TEXT,                 -- month | year, when the payment is for a subscription period
       subscription_id TEXT,
       transaction_id TEXT,
       at TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS billing_events_at ON billing_events(at);
     CREATE INDEX IF NOT EXISTS billing_events_user ON billing_events(user_id);`,
  );
  const cols = db.query("PRAGMA table_info(billing_events)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "transaction_id")) db.exec("ALTER TABLE billing_events ADD COLUMN transaction_id TEXT;");
  db.exec("CREATE TABLE IF NOT EXISTS growth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // The Paddle account is shared with other products (its webhook gets every event in the
  // account). Rows logged before events were filtered to Thread are dropped once and the import
  // re-run with the filter.
  if (!db.query("SELECT 1 FROM growth_meta WHERE key = 'billing_thread_only'").get()) {
    db.transaction(() => {
      db.exec("DELETE FROM billing_events WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)");
      db.exec("DELETE FROM growth_meta WHERE key = 'billing_backfilled'");
      db.prepare("INSERT INTO growth_meta (key, value) VALUES ('billing_thread_only', ?)").run(new Date().toISOString());
    })();
  }
  return db;
}

/** Thread's own Paddle prices -- the account is shared with other products. */
function threadPriceIds(): Set<string> {
  return new Set([process.env.PADDLE_PRICE_ID, process.env.PADDLE_PRICE_ID_YEARLY].filter((x): x is string => !!x));
}

/**
 * Does this event belong to Thread? The Paddle account also sells other products, and a webhook
 * destination receives every event in the account. Thread's if: it resolves to a Thread account
 * (thread_user_id in custom data, or a known Thread customer), or it's for a Thread price, or it
 * refunds a payment already logged as Thread's.
 */
function isThreadEvent(db: Database, event: BillingEventIn, userId: string | null): boolean {
  if (userId) return true;
  const d = event.data ?? {};
  const prices = threadPriceIds();
  const items = (d.items as { price?: { id?: string }; price_id?: string }[] | undefined) ?? [];
  if (items.some((i) => prices.has(i.price?.id ?? i.price_id ?? ""))) return true;
  const txn = str(d.transaction_id as string);
  if (txn && db.query("SELECT 1 FROM billing_events WHERE transaction_id = ?").get(txn)) return true;
  return false;
}

export interface BillingEventIn {
  event_id?: string;
  event_type: string;
  occurred_at?: string;
  data: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Turn one Paddle event into a log row (or null for event types that don't matter here). */
export function billingRow(event: BillingEventIn, userId: string | null): {
  event_id: string; kind: string; user_id: string | null; amount_minor: number | null; currency: string | null; interval: string | null; subscription_id: string | null; transaction_id: string | null; at: string;
} | null {
  const d = event.data ?? {};
  const at = str(event.occurred_at) ?? str(d.updated_at as string) ?? new Date().toISOString();
  const id = str(event.event_id) ?? `${event.event_type}:${str(d.id as string) ?? at}`;
  const base = { event_id: id, user_id: userId, amount_minor: null as number | null, currency: null as string | null, interval: null as string | null, subscription_id: null as string | null, transaction_id: null as string | null, at };
  switch (event.event_type) {
    case "transaction.completed": {
      const totals = ((d.details as Record<string, unknown> | undefined)?.totals ?? {}) as Record<string, unknown>;
      const amount = Number(totals.grand_total ?? totals.total ?? NaN);
      const period = (d.billing_period ?? null) as { starts_at?: string; ends_at?: string } | null;
      const items = (d.items as { price?: { billing_cycle?: { interval?: string } } }[] | undefined) ?? [];
      return {
        ...base,
        kind: "payment",
        amount_minor: Number.isFinite(amount) ? amount : null,
        currency: str(d.currency_code),
        interval: items[0]?.price?.billing_cycle?.interval ?? (period ? "month" : null),
        subscription_id: str(d.subscription_id),
        transaction_id: str(d.id),
      };
    }
    case "adjustment.created":
    case "adjustment.updated": {
      if (d.action !== "refund" || (d.status !== "approved" && event.event_type === "adjustment.updated")) return null;
      const totals = (d.totals ?? {}) as Record<string, unknown>;
      const amount = Number(totals.total ?? NaN);
      return { ...base, kind: "refund", amount_minor: Number.isFinite(amount) ? -Math.abs(amount) : null, currency: str(d.currency_code), subscription_id: str(d.subscription_id), transaction_id: str(d.transaction_id) };
    }
    case "subscription.activated":
    case "subscription.created":
      return { ...base, kind: "activated", subscription_id: str(d.id) };
    case "subscription.canceled":
      return { ...base, kind: "canceled", subscription_id: str(d.id) };
    case "subscription.past_due":
      return { ...base, kind: "past_due", subscription_id: str(d.id) };
    case "subscription.resumed":
      return { ...base, kind: "resumed", subscription_id: str(d.id) };
    case "subscription.paused":
      return { ...base, kind: "paused", subscription_id: str(d.id) };
    default:
      return null;
  }
}

/** Log a verified Paddle event. Idempotent on Paddle's event id; never throws. */
export function recordBillingEvent(event: BillingEventIn, userId: string | null): void {
  try {
    const row = billingRow(event, userId);
    if (!row) return;
    const db = openRevenue();
    try {
      if (!isThreadEvent(db, event, userId)) return; // another product in the shared account
      // A refund's user is the user of the payment it refunds.
      const user = row.user_id ?? (row.transaction_id ? ((db.query("SELECT user_id FROM billing_events WHERE transaction_id = ? AND kind = 'payment'").get(row.transaction_id) as { user_id: string | null } | null)?.user_id ?? null) : null);
      db.prepare(
        `INSERT OR IGNORE INTO billing_events (event_id, kind, user_id, amount_minor, currency, interval, subscription_id, transaction_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.event_id, row.kind, user, row.amount_minor, row.currency, row.interval, row.subscription_id, row.kind === "payment" ? row.transaction_id : row.transaction_id, row.at);
    } finally {
      db.close();
    }
  } catch {
    /* accounting must never fail the webhook */
  }
}

/**
 * Once: fill the log from Paddle's own records (completed transactions and current
 * subscriptions), so revenue before the log existed is counted. Synthetic ids (`bf:`) never
 * collide with real event ids. Only when PADDLE_API_KEY is set; never throws.
 */
export async function backfillBillingFromPaddle(fetcher: typeof fetch = fetch): Promise<number> {
  const key = process.env.PADDLE_API_KEY;
  if (!key) return 0;
  const db = openRevenue();
  try {
    db.exec("CREATE TABLE IF NOT EXISTS growth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (db.query("SELECT 1 FROM growth_meta WHERE key = 'billing_backfilled'").get()) return 0;
  } finally {
    db.close();
  }
  const base = process.env.PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  const userFor = (customData: unknown, customerId: unknown): string | null => {
    const fromData = (customData as { thread_user_id?: string } | null)?.thread_user_id;
    if (fromData) return fromData;
    if (typeof customerId !== "string") return null;
    const db = openRevenue();
    try {
      return (db.query("SELECT id FROM users WHERE paddle_customer_id = ?").get(customerId) as { id: string } | null)?.id ?? null;
    } finally {
      db.close();
    }
  };
  const all = async (path: string): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let url: string | null = `${base}${path}`;
    for (let i = 0; url && i < 50; i++) {
      const res: Response = await fetcher(url, { headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`Paddle ${res.status}`);
      const body = (await res.json()) as { data: Record<string, unknown>[]; meta?: { pagination?: { next?: string; has_more?: boolean } } };
      out.push(...body.data);
      url = body.meta?.pagination?.has_more ? body.meta.pagination.next ?? null : null;
    }
    return out;
  };
  try {
    let n = 0;
    for (const t of await all("/transactions?status=completed&per_page=100")) {
      recordBillingEvent({ event_id: `bf:txn:${t.id}`, event_type: "transaction.completed", occurred_at: str(t.billed_at as string) ?? str(t.created_at as string) ?? undefined, data: t }, userFor(t.custom_data, t.customer_id));
      n++;
    }
    for (const s of await all("/subscriptions?per_page=100")) {
      const user = userFor(s.custom_data, s.customer_id);
      recordBillingEvent({ event_id: `bf:sub:${s.id}:start`, event_type: "subscription.activated", occurred_at: str(s.started_at as string) ?? str(s.created_at as string) ?? undefined, data: s }, user);
      if (s.status === "canceled") recordBillingEvent({ event_id: `bf:sub:${s.id}:cancel`, event_type: "subscription.canceled", occurred_at: str(s.canceled_at as string) ?? str(s.updated_at as string) ?? undefined, data: s }, user);
      n++;
    }
    const db = openRevenue();
    try {
      db.prepare("INSERT OR REPLACE INTO growth_meta (key, value) VALUES ('billing_backfilled', ?)").run(new Date().toISOString());
    } finally {
      db.close();
    }
    return n;
  } catch (e) {
    console.error("[Thread] billing backfill failed:", e);
    return 0;
  }
}

/** Accounts left out of business metrics: operators (THREAD_ADMIN_EMAILS) and named test accounts. */
export function excludedUserIds(db: Database): Set<string> {
  const ids = new Set((process.env.THREAD_METRICS_EXCLUDE_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const emails = adminEmails();
  if (emails.length) {
    const rows = db.query(`SELECT id FROM users WHERE lower(email) IN (${emails.map(() => "?").join(",")})`).all(...emails) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

export interface Revenue {
  windowDays: number;
  currency: string | null;
  /** Paying now: Pro and active or past due (still within the paid period). */
  activeSubscribers: number;
  pastDue: number;
  /** Monthly recurring revenue, minor units: each active subscriber's latest recurring payment, per month. */
  mrrMinor: number;
  /** In the window. */
  revenueMinor: number;
  refundsMinor: number;
  newSubscribers: number;
  churned: number;
  reactivated: number;
  /** Of accounts created in the window, the share that became Pro. */
  conversion: { installs: number; pro: number };
  /** Median days from opening the app to paying, over everyone who has paid. */
  medianDaysToPro: number | null;
  /** MRR at the end of each of the last 12 weeks, oldest first. */
  mrrWeekly: { week: string; mrrMinor: number; subscribers: number }[];
  excluded: number;
}

export function revenueSummary(windowDays = 30, now: Date = new Date()): Revenue {
  const db = openRevenue();
  try {
    const excluded = excludedUserIds(db);
    const ok = (u: string | null) => !!u && !excluded.has(u);
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const events = (db.query("SELECT kind, user_id, amount_minor, currency, interval, at FROM billing_events ORDER BY at").all() as {
      kind: string; user_id: string | null; amount_minor: number | null; currency: string | null; interval: string | null; at: string;
    }[]).filter((e) => ok(e.user_id));
    const users = (db.query("SELECT id, plan, subscription_status, current_period_end, created_at FROM users").all() as {
      id: string; plan: string; subscription_status: string; current_period_end: string | null; created_at: string;
    }[]).filter((u) => !excluded.has(u.id));

    const payments = events.filter((e) => e.kind === "payment" && e.amount_minor !== null);
    const currency = payments.at(-1)?.currency ?? null;
    const monthly = (e: { amount_minor: number | null; interval: string | null }) => (e.amount_minor ?? 0) / (e.interval === "year" ? 12 : 1);

    /** Who was subscribed at time t, and what each paid per month, from the log alone. */
    const subscribedAt = (t: string) => {
      const state = new Map<string, { on: boolean; monthly: number }>();
      for (const e of events) {
        if (e.at > t || !e.user_id) continue;
        const s = state.get(e.user_id) ?? { on: false, monthly: 0 };
        if (e.kind === "payment" && e.amount_minor) state.set(e.user_id, { on: true, monthly: monthly(e) });
        else if (e.kind === "activated" || e.kind === "resumed") state.set(e.user_id, { ...s, on: true });
        else if (e.kind === "canceled" || e.kind === "paused") state.set(e.user_id, { ...s, on: false });
      }
      return [...state.values()].filter((s) => s.on);
    };

    const paying = users.filter(
      (u) => u.plan === "pro" && (u.subscription_status === "active" || u.subscription_status === "past_due" || (u.current_period_end ?? "") > now.toISOString()),
    );
    const lastMonthly = new Map<string, number>();
    for (const p of payments) if (p.user_id) lastMonthly.set(p.user_id, monthly(p));
    const known = [...lastMonthly.values()].sort((a, b) => a - b);
    const typical = known.length ? known[Math.floor(known.length / 2)]! : 0;
    const mrrMinor = Math.round(paying.reduce((s, u) => s + (lastMonthly.get(u.id) ?? typical), 0));

    const inWindow = events.filter((e) => e.at >= since);
    const firstPaid = new Map<string, string>();
    for (const e of events) if (e.user_id && (e.kind === "payment" || e.kind === "activated") && !firstPaid.has(e.user_id)) firstPaid.set(e.user_id, e.at);
    const newSubscribers = [...firstPaid.values()].filter((t) => t >= since).length;
    const reactivated = inWindow.filter((e) => e.kind === "resumed").length;

    const created = new Map(users.map((u) => [u.id, u.created_at]));
    const days = [...firstPaid]
      .map(([u, t]) => (created.has(u) ? (Date.parse(t) - Date.parse(created.get(u)!)) / 86_400_000 : null))
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b);

    const windowUsers = users.filter((u) => u.created_at >= since && u.created_at >= analyticsStart()); // pre-launch accounts are the founder's development, not installs
    const DAY = 86_400_000;
    const mrrWeekly = Array.from({ length: 12 }, (_, i) => {
      const end = new Date(now.getTime() - (11 - i) * 7 * DAY);
      const subs = subscribedAt(end.toISOString());
      return { week: end.toISOString().slice(0, 10), mrrMinor: Math.round(subs.reduce((s, x) => s + x.monthly, 0)), subscribers: subs.length };
    });

    return {
      windowDays,
      currency,
      activeSubscribers: paying.length,
      pastDue: paying.filter((u) => u.subscription_status === "past_due").length,
      mrrMinor,
      revenueMinor: inWindow.filter((e) => e.kind === "payment").reduce((s, e) => s + (e.amount_minor ?? 0), 0),
      refundsMinor: -inWindow.filter((e) => e.kind === "refund").reduce((s, e) => s + (e.amount_minor ?? 0), 0),
      newSubscribers,
      churned: inWindow.filter((e) => e.kind === "canceled").length,
      reactivated,
      conversion: { installs: windowUsers.length, pro: windowUsers.filter((u) => firstPaid.has(u.id) || u.plan === "pro").length },
      medianDaysToPro: days.length ? Math.round(days[Math.floor(days.length / 2)]! * 10) / 10 : null,
      mrrWeekly,
      excluded: excluded.size,
    };
  } finally {
    db.close();
  }
}
