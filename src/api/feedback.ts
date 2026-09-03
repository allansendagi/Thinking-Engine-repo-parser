import { openRegistry } from "./auth";
import { emailConfigured, sendEmail } from "./email";
import { adminEmails } from "./metrics";

/**
 * "Report an issue" from the website footer. One append-only `feedback` table in the shared
 * registry.db so nothing is ever lost, plus a best-effort email to THREAD_ADMIN_EMAILS when a
 * mailer is configured. Public + unauthenticated (rate-limited in the handler).
 */

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

function openFeedback() {
  const db = openRegistry();
  db.exec(
    `CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      email TEXT,
      page TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );`,
  );
  return db;
}

const clip = (s: unknown, n: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim().slice(0, n);
  return t.length ? t : null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FeedbackInput {
  kind?: unknown;
  message?: unknown;
  email?: unknown;
  page?: unknown;
  userAgent?: unknown;
}

export type FeedbackResult =
  | { ok: true }
  | { ok: false; error: "message_too_short" | "message_too_long" };

const MIN = 8;
const MAX = 4000;

/** Validate, store, and (best-effort) notify. Never throws for a notification failure. */
export async function recordFeedback(input: FeedbackInput, now: Date = new Date()): Promise<FeedbackResult> {
  const raw = typeof input.message === "string" ? input.message.trim() : "";
  if (raw.length < MIN) return { ok: false, error: "message_too_short" };
  if (raw.length > MAX) return { ok: false, error: "message_too_long" };

  const kind: FeedbackKind = FEEDBACK_KINDS.includes(input.kind as FeedbackKind)
    ? (input.kind as FeedbackKind)
    : "other";
  const message = raw.slice(0, MAX);
  const emailRaw = clip(input.email, 254);
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
  const page = clip(input.page, 300);
  const userAgent = clip(input.userAgent, 400);

  const db = openFeedback();
  try {
    db.prepare(
      `INSERT INTO feedback (kind, message, email, page, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(kind, message, email, page, userAgent, now.toISOString());
  } finally {
    db.close();
  }

  const to = adminEmails();
  if (emailConfigured() && to.length) {
    const subject = `[Thread feedback: ${kind}] ${message.slice(0, 60).replace(/\s+/g, " ")}`;
    const text = [
      `Kind:  ${kind}`,
      `From:  ${email ?? "(no email given)"}`,
      `Page:  ${page ?? "-"}`,
      `UA:    ${userAgent ?? "-"}`,
      ``,
      message,
    ].join("\n");
    await Promise.allSettled(to.map((addr) => sendEmail({ to: addr, subject, text })));
  }

  return { ok: true };
}
