import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opaque bearer tokens, hashed at rest, constant-time compared -- the same shape real API tokens
 * (GitHub PATs, Stripe keys) use. Identity is now email-backed: an account can carry a verified
 * email, and sign-in (email + 6-digit code, see authCodes.ts) issues an *additional* token for
 * the device that's signing in. Tokens are per-device (see the `auth_tokens` table): signing in
 * on the website must not knock the Mac app, the desktop agent, or the extension offline. An
 * account with no email is still valid -- the Mac app auto-creates one on first launch so
 * capture works with zero setup, and the user attaches an email later to claim it.
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

  // Per-device tokens. An account can have several live tokens at once (the Mac app, the
  // website, the desktop agent) -- signing in on one device must not knock the others offline.
  db.exec(
    `CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id);");
  // A human label ("Thread for Mac", "Website", "Chrome extension") + a throttled last-seen, so a
  // Settings screen can list your devices and revoke one. Added idempotently for existing rows.
  for (const col of ["label TEXT", "last_seen_at TEXT"]) {
    try {
      db.exec(`ALTER TABLE auth_tokens ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
  // Backfill from the original single-token column for accounts that predate this table.
  db.exec(
    `INSERT OR IGNORE INTO auth_tokens (token_hash, user_id, created_at)
     SELECT token_hash, id, created_at FROM users WHERE token_hash IS NOT NULL;`,
  );

  // Trial-era rows carry a subscription_status like 'trialing' / 'active' from before the Paddle
  // migration. On a free-plan account that's meaningless and leaks to the client (the Mac app
  // shows "trialing"). Normalize once.
  try {
    db.exec("UPDATE users SET subscription_status = 'free' WHERE plan = 'free' AND subscription_status <> 'free';");
  } catch {
    // columns not present yet on a very old DB -- the ALTERs above add them; next open normalizes
  }
  return db;
}

/** A short, safe device label. Falls back to a rough parse of a User-Agent, then "Unknown device". */
export function deviceLabel(raw: string | null | undefined, userAgent?: string | null): string {
  const given = (raw ?? "").trim().replace(/[\x00-\x1f]/g, "").slice(0, 60);
  if (given) return given;
  const ua = userAgent ?? "";
  const os = /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [app, os].filter(Boolean).join(" on ") || "Unknown device";
}

/** Adds a token for an account and returns it once. Existing tokens stay valid. */
export async function issueToken(userId: string, label?: string): Promise<string> {
  const db = openRegistry();
  try {
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO auth_tokens (token_hash, user_id, created_at, label, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(
      await sha256Hex(token),
      userId,
      now,
      deviceLabel(label),
      now,
    );
    return token;
  } finally {
    db.close();
  }
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

/**
 * Moves a verified email from one account to another, atomically. Used only when the email is
 * currently on an account with no data at all (see handler.ts) -- e.g. someone signed in on the
 * website first, minting an empty account, and now wants to claim it onto the anonymous Mac
 * account that actually holds their ideas. The `from` account stays, just anonymous again.
 */
export function reassignEmail(fromUserId: string, toUserId: string, email: string): void {
  const db = openRegistry();
  try {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // NULL the old owner first -- the unique partial index on lower(email) would otherwise reject.
      db.prepare("UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?").run(fromUserId);
      db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(email, now, toUserId);
    });
    tx();
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
export async function createUser(email?: string, label?: string): Promise<CreatedUser> {
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
    db.prepare("INSERT INTO auth_tokens (token_hash, user_id, created_at, label, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(
      tokenHash,
      userId,
      now,
      deviceLabel(label),
      now,
    );
    return { userId, token };
  } finally {
    db.close();
  }
}

export async function verifyToken(userId: string, token: string): Promise<boolean> {
  return (await verifyTokenHash(userId, token)) !== null;
}

/**
 * Like `verifyToken`, but returns the matched token's hash (or null). The handler needs the hash
 * to touch `last_seen_at`, to flag the caller's own row in the session list, and to know which
 * token "sign out this device" should revoke.
 */
export async function verifyTokenHash(userId: string, token: string): Promise<string | null> {
  const db = openRegistry();
  try {
    const rows = db.query("SELECT token_hash FROM auth_tokens WHERE user_id = ?").all(userId) as {
      token_hash: string;
    }[];
    if (rows.length === 0) return null;
    const presented = await sha256Hex(token);
    // Check every live token; the loop is constant per-row so it stays timing-safe against
    // which token matched (there are at most a handful per account).
    let matched: string | null = null;
    for (const row of rows) if (timingSafeEqual(presented, row.token_hash)) matched = row.token_hash;
    return matched;
  } finally {
    db.close();
  }
}

/** Bump last_seen_at, at most once an hour per token (a single-row PK write, throttled). */
export function touchToken(tokenHash: string, now: Date = new Date()): void {
  const db = openRegistry();
  try {
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE auth_tokens SET last_seen_at = ? WHERE token_hash = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
    ).run(now.toISOString(), tokenHash, cutoff);
  } finally {
    db.close();
  }
}

export interface SessionInfo {
  /** Stable opaque handle for revocation -- the first 16 hex of the token hash (64 bits, no
   *  collision risk within one account). The full hash is never exposed. */
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** True for the token that authenticated the request that's listing sessions. */
  current: boolean;
}

/** Every live device token for an account, newest first, with the caller's own row flagged. */
export function listSessions(userId: string, currentHash: string): SessionInfo[] {
  const db = openRegistry();
  try {
    const rows = db
      .query("SELECT token_hash, label, created_at, last_seen_at FROM auth_tokens WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as { token_hash: string; label: string | null; created_at: string; last_seen_at: string | null }[];
    return rows.map((r) => ({
      id: r.token_hash.slice(0, 16),
      label: r.label ?? "Unknown device",
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at ?? null,
      current: r.token_hash === currentHash,
    }));
  } finally {
    db.close();
  }
}

/** Revoke one session of this account by its `id` (hash prefix). Returns rows deleted (0 or 1). */
export function revokeSession(userId: string, id: string): number {
  if (!/^[a-f0-9]{16}$/.test(id)) return 0;
  const db = openRegistry();
  try {
    return db
      .prepare("DELETE FROM auth_tokens WHERE user_id = ? AND substr(token_hash, 1, 16) = ?")
      .run(userId, id).changes;
  } finally {
    db.close();
  }
}

/** Revoke the exact token that made this request ("sign out this device"). */
export function revokeTokenHash(tokenHash: string): number {
  const db = openRegistry();
  try {
    return db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").run(tokenHash).changes;
  } finally {
    db.close();
  }
}

/** Revoke every session of this account EXCEPT the caller's ("sign out everywhere else"). */
export function revokeOtherSessions(userId: string, keepHash: string): number {
  const db = openRegistry();
  try {
    return db
      .prepare("DELETE FROM auth_tokens WHERE user_id = ? AND token_hash <> ?")
      .run(userId, keepHash).changes;
  } finally {
    db.close();
  }
}
