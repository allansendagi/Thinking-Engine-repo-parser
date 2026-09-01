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
function registryPath(): string {
  return process.env.THREAD_REGISTRY_PATH ?? "data/registry.db";
}

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
  return db;
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
    db.prepare("INSERT INTO users (id, token_hash, created_at) VALUES (?, ?, ?)").run(
      userId,
      tokenHash,
      new Date().toISOString(),
    );
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
