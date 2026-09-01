import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Deliberately minimal, real auth: opaque bearer tokens, hashed at rest, constant-time compared.
 * NOT a full auth system -- no email verification, no password reset, no OAuth, no rate limiting.
 * That's a known, stated scope boundary (see README), not a hidden shortcut: this is what a
 * single-binary, no-external-dependency MVP can honestly support, and it's the same shape real
 * API tokens (GitHub PATs, Stripe keys) use, just without the account-recovery flow around it.
 */

// Read lazily (not as a module-level const) so tests can override THREAD_REGISTRY_PATH before
// the first call -- module-level consts would capture whatever the env var was at import time,
// which in an ES module is before any test code can run (imports are hoisted).
//
// The token registry MUST outlive a redeploy or every issued credential 401s. Same resolution
// order as the per-user DBs: explicit override, else Railway's attached volume, else local.
function registryPath(): string {
  if (process.env.THREAD_REGISTRY_PATH) return process.env.THREAD_REGISTRY_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/registry.db`;
  }
  return "data/registry.db";
}

/** Days of free trial granted at account creation. */
export const TRIAL_DAYS = 14;

function openRegistry(): Database {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  );
  // Billing columns, added idempotently so an existing registry.db upgrades in place.
  for (const col of [
    "stripe_customer_id TEXT",
    "subscription_status TEXT NOT NULL DEFAULT 'trialing'",
    "trial_ends_at TEXT",
    "current_period_end TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
  return db;
}

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete";

export interface Account {
  userId: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
}

function rowToAccount(row: Record<string, unknown>): Account {
  // Accounts created before the billing migration have trial_ends_at = NULL. Derive it from
  // created_at so they still get a full trial window rather than showing as expired.
  let trialEndsAt = (row.trial_ends_at as string | null) ?? null;
  if (!trialEndsAt && row.created_at) {
    trialEndsAt = new Date(new Date(row.created_at as string).getTime() + TRIAL_DAYS * 86_400_000).toISOString();
  }
  return {
    userId: row.id as string,
    status: (row.subscription_status as SubscriptionStatus) ?? "trialing",
    trialEndsAt,
    currentPeriodEnd: (row.current_period_end as string | null) ?? null,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
  };
}

export function getAccount(userId: string): Account | null {
  const db = openRegistry();
  try {
    const row = db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown> | null;
    return row ? rowToAccount(row) : null;
  } finally {
    db.close();
  }
}

export function findAccountByStripeCustomer(customerId: string): Account | null {
  const db = openRegistry();
  try {
    const row = db.query("SELECT * FROM users WHERE stripe_customer_id = ?").get(customerId) as
      | Record<string, unknown>
      | null;
    return row ? rowToAccount(row) : null;
  } finally {
    db.close();
  }
}

export function updateSubscription(
  userId: string,
  patch: { status?: SubscriptionStatus; stripeCustomerId?: string; currentPeriodEnd?: string | null },
): void {
  const db = openRegistry();
  try {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("subscription_status = ?");
      args.push(patch.status);
    }
    if (patch.stripeCustomerId !== undefined) {
      sets.push("stripe_customer_id = ?");
      args.push(patch.stripeCustomerId);
    }
    if (patch.currentPeriodEnd !== undefined) {
      sets.push("current_period_end = ?");
      args.push(patch.currentPeriodEnd);
    }
    if (sets.length === 0) return;
    args.push(userId);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
  } finally {
    db.close();
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CreatedUser {
  userId: string;
  /** Shown exactly once. Only the hash is persisted -- losing this means losing access, by design. */
  token: string;
}

export async function createUser(): Promise<CreatedUser> {
  const db = openRegistry();
  try {
    const userId = `user_${randomBytes(12).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const trialEndsAt = new Date(now + TRIAL_DAYS * 86_400_000).toISOString();
    db.prepare(
      "INSERT INTO users (id, token_hash, created_at, subscription_status, trial_ends_at) VALUES (?, ?, ?, 'trialing', ?)",
    ).run(userId, tokenHash, new Date(now).toISOString(), trialEndsAt);
    return { userId, token };
  } finally {
    db.close();
  }
}

export async function verifyToken(userId: string, token: string): Promise<boolean> {
  const db = openRegistry();
  try {
    const row = db.query("SELECT token_hash FROM users WHERE id = ?").get(userId) as
      | { token_hash: string }
      | null;
    if (!row) return false;
    return timingSafeEqual(await sha256Hex(token), row.token_hash);
  } finally {
    db.close();
  }
}
