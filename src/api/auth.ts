import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opaque bearer tokens, hashed at rest, constant-time compared -- the same shape real API tokens
 * (GitHub PATs, Stripe keys) use. Identity is now email-backed: an account can carry a verified
 * email, and sign-in (email + 6-digit code, see authCodes.ts) rotates the token. An account with
 * no email is still valid -- the Mac app auto-creates one on first launch so capture works with
 * zero setup, and the user attaches an email later to claim it.
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

/**
 * Legacy: days of free trial once granted at account creation. The model is now a permanent
 * capped Free plan (see billing.ts `FREE_IDEA_CAP`), not a timed trial -- `trial_ends_at` is a
 * dead column kept only so old rows still decode. Retained as an export because a couple of old
 * tests reference it.
 */
export const TRIAL_DAYS = 14;

/** Opens the shared account/token registry, upgrading its schema in place. */
export function openRegistry(): Database {
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
  // Columns added idempotently so an existing registry.db upgrades in place. `stripe_customer_id`
  // and `trial_ends_at` predate the Paddle + permanent-Free move and are now vestigial -- kept so
  // old rows decode, never written.
  for (const col of [
    "stripe_customer_id TEXT",
    "subscription_status TEXT NOT NULL DEFAULT 'free'",
    "trial_ends_at TEXT",
    "current_period_end TEXT",
    "email TEXT",
    "email_verified_at TEXT",
    "plan TEXT NOT NULL DEFAULT 'free'",
    "paddle_customer_id TEXT",
    "paddle_subscription_id TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
  // One account per email (case-insensitive). Partial index so the many email-less accounts
  // don't collide on NULL.
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users(lower(email)) WHERE email IS NOT NULL;",
    );
  } catch {
    // index already exists
  }
  return db;
}

export type Plan = "free" | "pro";

/** `free` for a non-paying account; the rest mirror the Paddle subscription lifecycle. */
export type SubscriptionStatus = "free" | "active" | "past_due" | "canceled" | "incomplete" | "trialing";

export interface Account {
  userId: string;
  email: string | null;
  emailVerifiedAt: string | null;
  plan: Plan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  /** Vestigial -- see `openRegistry`. Never populated for new accounts. */
  trialEndsAt: string | null;
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    userId: row.id as string,
    email: (row.email as string | null) ?? null,
    emailVerifiedAt: (row.email_verified_at as string | null) ?? null,
    plan: ((row.plan as string | null) ?? "free") === "pro" ? "pro" : "free",
    status: (row.subscription_status as SubscriptionStatus) ?? "free",
    currentPeriodEnd: (row.current_period_end as string | null) ?? null,
    paddleCustomerId: (row.paddle_customer_id as string | null) ?? null,
    paddleSubscriptionId: (row.paddle_subscription_id as string | null) ?? null,
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
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

export function findAccountByEmail(email: string): Account | null {
  const db = openRegistry();
  try {
    const row = db.query("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) as
      | Record<string, unknown>
      | null;
    return row ? rowToAccount(row) : null;
  } finally {
    db.close();
  }
}

export function findAccountByPaddleCustomer(customerId: string): Account | null {
  const db = openRegistry();
  try {
    const row = db.query("SELECT * FROM users WHERE paddle_customer_id = ?").get(customerId) as
      | Record<string, unknown>
      | null;
    return row ? rowToAccount(row) : null;
  } finally {
    db.close();
  }
}

export class EmailInUseError extends Error {
  constructor(public readonly ownerUserId: string) {
    super("That email is already attached to another Thread account");
    this.name = "EmailInUseError";
  }
}

/**
 * Attaches a verified email to an existing account (the "claim" flow -- an anonymous account
 * created on first launch gets an identity, keeping all its ideas). Throws EmailInUseError if
 * the email already belongs to a *different* account. Idempotent for the same account.
 */
export function attachEmail(userId: string, email: string): void {
  const db = openRegistry();
  try {
    const existing = db.query("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as
      | { id: string }
      | null;
    if (existing && existing.id !== userId) throw new EmailInUseError(existing.id);
    db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(
      email,
      new Date().toISOString(),
      userId,
    );
  } finally {
    db.close();
  }
}

export function setPlan(
  userId: string,
  patch: {
    plan?: Plan;
    status?: SubscriptionStatus;
    currentPeriodEnd?: string | null;
    paddleCustomerId?: string | null;
    paddleSubscriptionId?: string | null;
  },
): void {
  const db = openRegistry();
  try {
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };
    if (patch.plan !== undefined) put("plan", patch.plan);
    if (patch.status !== undefined) put("subscription_status", patch.status);
    if (patch.currentPeriodEnd !== undefined) put("current_period_end", patch.currentPeriodEnd);
    if (patch.paddleCustomerId !== undefined) put("paddle_customer_id", patch.paddleCustomerId);
    if (patch.paddleSubscriptionId !== undefined) put("paddle_subscription_id", patch.paddleSubscriptionId);
    if (sets.length === 0) return;
    args.push(userId);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
  } finally {
    db.close();
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
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

/** Mints a new anonymous account (Free plan). Pass `email` to attach a verified identity now. */
export async function createUser(email?: string): Promise<CreatedUser> {
  const db = openRegistry();
  try {
    const userId = `user_${randomBytes(12).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    const tokenHash = await sha256Hex(token);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, token_hash, created_at, subscription_status, plan, email, email_verified_at)
       VALUES (?, ?, ?, 'free', 'free', ?, ?)`,
    ).run(userId, tokenHash, now, email ?? null, email ? now : null);
    return { userId, token };
  } finally {
    db.close();
  }
}

/** Issues a fresh token for an existing account and invalidates the old one. Used by sign-in. */
export async function rotateToken(userId: string): Promise<string> {
  const db = openRegistry();
  try {
    const token = randomBytes(32).toString("hex");
    db.prepare("UPDATE users SET token_hash = ? WHERE id = ?").run(await sha256Hex(token), userId);
    return token;
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
