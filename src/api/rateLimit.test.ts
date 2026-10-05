import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetRateLimiter, clientKey, rateLimit } from "./rateLimit";

// A sibling test file may have set THREAD_RATE_LIMIT=off in this shared process; these tests
// exercise the limiter itself, so make sure it's active.
beforeEach(() => {
  delete process.env.THREAD_RATE_LIMIT;
  __resetRateLimiter();
});
afterEach(() => __resetRateLimiter());

test("allows up to the limit, then blocks within the window", () => {
  const rule = { limit: 3, windowMs: 1000 };
  const t0 = 1_000_000;
  expect(rateLimit("k", rule, t0)).toBe(true);
  expect(rateLimit("k", rule, t0 + 10)).toBe(true);
  expect(rateLimit("k", rule, t0 + 20)).toBe(true);
  expect(rateLimit("k", rule, t0 + 30)).toBe(false);
  expect(rateLimit("k", rule, t0 + 40)).toBe(false);
});

test("a blocked hit does not consume budget -- window slides forward cleanly", () => {
  const rule = { limit: 2, windowMs: 1000 };
  const t0 = 2_000_000;
  expect(rateLimit("k", rule, t0)).toBe(true);
  expect(rateLimit("k", rule, t0 + 100)).toBe(true);
  expect(rateLimit("k", rule, t0 + 200)).toBe(false); // over
  // Once the first two hits age out, the caller is allowed again.
  expect(rateLimit("k", rule, t0 + 1100)).toBe(true);
  expect(rateLimit("k", rule, t0 + 1150)).toBe(true);
  expect(rateLimit("k", rule, t0 + 1200)).toBe(false);
});

test("keys are independent", () => {
  const rule = { limit: 1, windowMs: 1000 };
  const t0 = 3_000_000;
  expect(rateLimit("a", rule, t0)).toBe(true);
  expect(rateLimit("b", rule, t0)).toBe(true);
  expect(rateLimit("a", rule, t0 + 1)).toBe(false);
  expect(rateLimit("b", rule, t0 + 1)).toBe(false);
});

test("clientKey reads the right-most x-forwarded-for entry (the one our proxy appended), scoped", () => {
  const req = new Request("https://x/y", { headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" } });
  expect(clientKey(req, "users")).toBe("users:203.0.113.9");
});

test("clientKey can't be steered by a client-supplied x-forwarded-for prefix", () => {
  // A client rotating a fake left-most "IP" every request must still land in one bucket.
  const a = new Request("https://x/y", { headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.9" } });
  const b = new Request("https://x/y", { headers: { "x-forwarded-for": "2.2.2.2, 203.0.113.9" } });
  expect(clientKey(a, "users")).toBe(clientKey(b, "users"));
});

test("clientKey falls back when no proxy headers are present", () => {
  expect(clientKey(new Request("https://x/y"), "download")).toBe("download:unknown");
});
