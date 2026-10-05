/**
 * In-memory sliding-window rate limiter for the handful of UNAUTHENTICATED routes -- anon
 * account creation, the download beacon, the sign-in-code request. Best-effort abuse dampening:
 * the state is per-process and resets on redeploy, which is fine. Its job is to stop a trivial
 * `while true; do curl` loop from
 *   - filling the Railway volume with anon `users` rows + a per-user SQLite file each, or
 *   - poisoning the /admin download numbers,
 * not to be a hard quota. Authenticated routes are already gated by the bearer token; the
 * email-code path keeps its own per-email DB limit in authCodes.ts.
 */

export interface RateRule {
  /** Max hits allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** key -> ascending hit timestamps within the active window. */
const buckets = new Map<string, number[]>();
let lastSweep = 0;
const GC_IDLE_MS = 60 * 60 * 1000; // drop a bucket after an hour of silence

/**
 * Record a hit for `key` and report whether it's allowed. Returns true and counts the hit when
 * under `rule.limit`; returns false (and does NOT count it) once at/over the limit.
 */
export function rateLimit(key: string, rule: RateRule, now: number = Date.now()): boolean {
  // Integration tests and the deterministic e2e sims drive many synthetic clients through one
  // process from one (absent) IP; they set THREAD_RATE_LIMIT=off so the shared limiter doesn't
  // treat them as an attacker. Never set in production.
  if (process.env.THREAD_RATE_LIMIT === "off") return true;

  if (now - lastSweep > 60_000) {
    for (const [k, ts] of buckets) {
      if (ts.length === 0 || ts[ts.length - 1]! < now - GC_IDLE_MS) buckets.delete(k);
    }
    lastSweep = now;
  }

  const cutoff = now - rule.windowMs;
  const ts = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (ts.length >= rule.limit) {
    buckets.set(key, ts);
    return false;
  }
  ts.push(now);
  buckets.set(key, ts);
  return true;
}

/**
 * Best-effort client identifier for keying. Railway's edge (like every proxy in front of this API)
 * APPENDS the address it actually saw to `x-forwarded-for`, so the RIGHT-most entry is the one a
 * client can't forge. The left-most is whatever the client sent -- keying on it let anyone pick a
 * fresh "IP" per request and walk straight past every limit here (e.g. unlimited anonymous
 * accounts). Falls back to `x-real-ip`, then a constant, so local/test traffic shares one bucket.
 */
export function clientKey(req: Request, scope: string): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const ip = hops[hops.length - 1] || req.headers.get("x-real-ip")?.trim() || "unknown";
  return `${scope}:${ip}`;
}

/** Test-only: wipe all buckets. */
export function __resetRateLimiter(): void {
  buckets.clear();
  lastSweep = 0;
}
