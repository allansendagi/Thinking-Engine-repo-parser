import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeCode, issueCode, RateLimitedError } from "./authCodes";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "thread-codes-"));
  process.env.THREAD_REGISTRY_PATH = join(tmp, "registry.db");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.THREAD_REGISTRY_PATH;
});

describe("authCodes", () => {
  test("a fresh code verifies once, then is consumed", async () => {
    const email = "a@example.com";
    const code = await issueCode(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(await consumeCode(email, code)).toBe(true);
    expect(await consumeCode(email, code)).toBe(false); // single-use
  });

  test("wrong code fails; 5 wrong attempts burn the code", async () => {
    const email = "b@example.com";
    const code = await issueCode(email);
    for (let i = 0; i < 5; i++) expect(await consumeCode(email, "999999")).toBe(false);
    expect(await consumeCode(email, code)).toBe(false); // real code no longer usable
  });

  test("re-issuing replaces the previous code", async () => {
    const email = "c@example.com";
    const first = await issueCode(email);
    const second = await issueCode(email);
    expect(await consumeCode(email, first)).toBe(false);
    expect(await consumeCode(email, second)).toBe(true);
  });

  test("expired code fails", async () => {
    const email = "d@example.com";
    const base = Date.now();
    const code = await issueCode(email, base);
    expect(await consumeCode(email, code, base + 11 * 60 * 1000)).toBe(false);
  });

  test("more than 5 issues within an hour is rate limited", async () => {
    const email = "e@example.com";
    const base = Date.now();
    for (let i = 0; i < 5; i++) await issueCode(email, base + i * 1000);
    await expect(issueCode(email, base + 6000)).rejects.toBeInstanceOf(RateLimitedError);
    // ...but an hour later it's allowed again
    await expect(issueCode(email, base + 61 * 60 * 1000)).resolves.toMatch(/^\d{6}$/);
  });
});
