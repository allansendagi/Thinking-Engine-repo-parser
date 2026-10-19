import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./auth";
import { billingRow, recordBillingEvent, revenueSummary } from "./revenue";
import { accuracySummary } from "./accuracy";
import { openUserDb } from "../db/tenancy";

let dir = "";
const saved = { reg: process.env.THREAD_REGISTRY_PATH, data: process.env.THREAD_DATA_DIR, admins: process.env.THREAD_ADMIN_EMAILS };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "revenue-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
  process.env.THREAD_DATA_DIR = join(dir, "users");
});
afterAll(() => {
  for (const [k, v] of [["THREAD_REGISTRY_PATH", saved.reg], ["THREAD_DATA_DIR", saved.data], ["THREAD_ADMIN_EMAILS", saved.admins]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const user = (id: string, createdAt: string, plan = "free", status = "free", email: string | null = null) => {
  const db = openRegistry();
  try {
    db.prepare("INSERT INTO users (id, token_hash, created_at, plan, subscription_status, email) VALUES (?, 'h', ?, ?, ?, ?)").run(id, createdAt, plan, status, email);
  } finally {
    db.close();
  }
};
const payment = (id: string, userId: string, at: string, cents: number, interval = "month") =>
  recordBillingEvent({ event_id: id, event_type: "transaction.completed", occurred_at: at, data: { currency_code: "USD", details: { totals: { grand_total: String(cents) } }, items: [{ price: { billing_cycle: { interval } } }], billing_period: { starts_at: at } } }, userId);

describe("billing log", () => {
  test("reads amount, currency and interval from Paddle's payload", () => {
    const row = billingRow({ event_id: "evt_1", event_type: "transaction.completed", occurred_at: "2026-10-01T00:00:00Z", data: { currency_code: "EUR", details: { totals: { grand_total: "1499" } }, items: [{ price: { billing_cycle: { interval: "year" } } }] } }, "user_a");
    expect(row).toMatchObject({ kind: "payment", amount_minor: 1499, currency: "EUR", interval: "year" });
    expect(billingRow({ event_type: "adjustment.created", data: { action: "refund", totals: { total: "1500" }, currency_code: "USD" } }, null)).toMatchObject({ kind: "refund", amount_minor: -1500 });
    expect(billingRow({ event_type: "customer.updated", data: {} }, null)).toBeNull();
  });

  test("MRR, revenue, churn, conversion -- idempotent on retries, operators excluded", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    user("user_p1", "2026-10-01T00:00:00Z", "pro", "active");
    user("user_p2", "2026-10-05T00:00:00Z", "pro", "active");
    user("user_c1", "2026-09-01T00:00:00Z", "free", "canceled");
    user("user_owner", "2026-09-01T00:00:00Z", "pro", "active", "owner@example.com");
    user("user_f1", "2026-10-10T00:00:00Z");
    payment("t1", "user_p1", "2026-10-03T00:00:00Z", 1500);
    payment("t1", "user_p1", "2026-10-03T00:00:00Z", 1500); // Paddle retried: counted once
    payment("t2", "user_p2", "2026-10-06T00:00:00Z", 18000, "year");
    payment("t3", "user_c1", "2026-09-02T00:00:00Z", 1500);
    recordBillingEvent({ event_id: "e_c1", event_type: "subscription.canceled", occurred_at: "2026-10-12T00:00:00Z", data: { id: "sub_c1" } }, "user_c1");
    payment("t4", "user_owner", "2026-10-02T00:00:00Z", 1500);
    process.env.THREAD_ADMIN_EMAILS = "owner@example.com";
    const r = revenueSummary(30, now);
    expect(r.excluded).toBe(1);
    expect(r.activeSubscribers).toBe(2);
    expect(r.mrrMinor).toBe(1500 + 1500); // a yearly 180.00 is 15.00 a month
    expect(r.revenueMinor).toBe(1500 + 18000);
    expect(r.churned).toBe(1);
    expect(r.newSubscribers).toBe(2);
    expect(r.conversion).toEqual({ installs: 3, pro: 2 });
    expect(r.currency).toBe("USD");
    expect(r.mrrWeekly.at(-1)).toEqual({ week: "2026-10-19", mrrMinor: 3000, subscribers: 2 });
  });
});

describe("shared Paddle account", () => {
  test("another product's payments are ignored; a refund of a Thread payment is linked to its account", () => {
    process.env.PADDLE_PRICE_ID = "pri_thread";
    const before = revenueSummary(30, new Date("2026-10-19T12:00:00Z")).revenueMinor;
    // NOMOS sale in the same account: no Thread user, not a Thread price.
    recordBillingEvent({ event_id: "nomos_1", event_type: "transaction.completed", occurred_at: "2026-10-15T00:00:00Z",
      data: { id: "txn_nomos", currency_code: "USD", details: { totals: { grand_total: "99900" } }, items: [{ price: { id: "pri_nomos" } }] } }, null);
    // A Thread sale identified only by its price, then refunded.
    user("user_p3", "2026-10-10T00:00:00Z", "pro", "active");
    recordBillingEvent({ event_id: "thr_1", event_type: "transaction.completed", occurred_at: "2026-10-16T00:00:00Z",
      data: { id: "txn_thr", currency_code: "USD", details: { totals: { grand_total: "1500" } }, items: [{ price: { id: "pri_thread" } }] } }, "user_p3");
    recordBillingEvent({ event_id: "adj_1", event_type: "adjustment.created", occurred_at: "2026-10-17T00:00:00Z",
      data: { action: "refund", transaction_id: "txn_thr", currency_code: "USD", totals: { total: "1500" } } }, null);
    const r = revenueSummary(30, new Date("2026-10-19T12:00:00Z"));
    expect(r.revenueMinor - before).toBe(1500); // the 999.00 NOMOS sale isn't Thread's
    expect(r.refundsMinor).toBe(1500);
    delete process.env.PADDLE_PRICE_ID;
  });
});

describe("idea accuracy", () => {
  test("counts verdicts on served ideas by week; reviews kept apart; judges counted", () => {
    user("user_aaaaaaaaaaaaaaaaaaaaaaaa", "2026-10-01T00:00:00Z");
    const db = openUserDb("user_aaaaaaaaaaaaaaaaaaaaaaaa");
    try {
      const idea = db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, 't', 'developing', 'x', ?, ?)");
      idea.run("i1", "2026-10-13T00:00:00Z", "2026-10-13T00:00:00Z");
      idea.run("i2", "2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z");
      db.prepare("INSERT INTO idea_verdicts (verdict, idea_id, thought_ids, created_at) VALUES ('keep', 'i1', '[]', '2026-10-14T00:00:00Z')").run();
      db.prepare("INSERT INTO idea_verdicts (verdict, idea_id, thought_ids, created_at, origin) VALUES ('keep', 'i9', '[]', '2026-10-14T00:00:00Z', 'review')").run();
      const corr = db.prepare("INSERT INTO idea_corrections (kind, idea_id, thought_ids, created_at) VALUES (?, 'i2', '[]', '2026-10-15T00:00:00Z')");
      for (const k of ["not_idea", "merge", "rename"]) corr.run(k);
    } finally {
      db.close();
    }
    const a = accuracySummary(new Date("2026-10-19T12:00:00Z"));
    const w = a.weeks.find((x) => x.week === "2026-10-12")!;
    expect(w).toMatchObject({ newIdeas: 2, keeps: 1, notIdeas: 1, merges: 1, renames: 1, reviewed: 1, judges: 1 });
  });
});
