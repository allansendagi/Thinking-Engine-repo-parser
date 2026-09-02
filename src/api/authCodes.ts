import { randomInt } from "node:crypto";
import { openRegistry, sha256Hex, timingSafeEqual } from "./auth";

/**
 * 6-digit sign-in codes, stored hashed in the shared registry.db. One live code per email
 * (re-requesting replaces it), 10-minute TTL, at most 5 verify attempts per code, and a soft
 * rate limit of 5 issues per email per hour. This is the whole of Thread's "password" surface.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_ISSUES_PER_HOUR = 5;

function openCodes() {
  const db = openRegistry();
  db.exec(
    `CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      issued_at TEXT NOT NULL,
      issue_count INTEGER NOT NULL DEFAULT 1
    );`,
  );
  return db;
}

export class RateLimitedError extends Error {
  constructor() {
    super("Too many sign-in codes requested for this email. Try again later.");
    this.name = "RateLimitedError";
  }
}

const normalize = (email: string) => email.trim().toLowerCase();

/** Generates, stores (hashed) and returns a fresh code for `email`. Caller emails it. */
export async function issueCode(email: string, now = Date.now()): Promise<string> {
  const e = normalize(email);
  const db = openCodes();
  try {
    const existing = db.query("SELECT issued_at, issue_count FROM login_codes WHERE email = ?").get(e) as
      | { issued_at: string; issue_count: number }
      | null;
    let issueCount = 1;
    if (existing) {
      const withinHour = now - new Date(existing.issued_at).getTime() < 60 * 60 * 1000;
      if (withinHour) {
        if (existing.issue_count >= MAX_ISSUES_PER_HOUR) throw new RateLimitedError();
        issueCount = existing.issue_count + 1;
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    db.prepare(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts, issued_at, issue_count)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         code_hash = excluded.code_hash,
         expires_at = excluded.expires_at,
         attempts = 0,
         issued_at = excluded.issued_at,
         issue_count = ?`,
    ).run(
      e,
      await sha256Hex(code),
      new Date(now + CODE_TTL_MS).toISOString(),
      new Date(now).toISOString(),
      issueCount,
      issueCount,
    );
    return code;
  } finally {
    db.close();
  }
}

/** Verifies and single-use-consumes a code. Returns true only on an exact, live, in-budget match. */
export async function consumeCode(email: string, code: string, now = Date.now()): Promise<boolean> {
  const e = normalize(email);
  const db = openCodes();
  try {
    const row = db.query("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?").get(e) as
      | { code_hash: string; expires_at: string; attempts: number }
      | null;
    if (!row) return false;
    if (new Date(row.expires_at).getTime() < now || row.attempts >= MAX_ATTEMPTS) {
      db.prepare("DELETE FROM login_codes WHERE email = ?").run(e);
      return false;
    }
    const ok = timingSafeEqual(await sha256Hex(code), row.code_hash);
    if (ok) {
      db.prepare("DELETE FROM login_codes WHERE email = ?").run(e);
      return true;
    }
    db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").run(e);
    return false;
  } finally {
    db.close();
  }
}
