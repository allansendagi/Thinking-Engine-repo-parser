import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "./config";

const VALID_ID = "user_" + "a".repeat(24);
const VALID_TOKEN = "b".repeat(64);

const saved = { ...process.env };
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of ["THREAD_USER_ID", "THREAD_TOKEN", "THREAD_API_BASE_URL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

test("explicit env credentials win", async () => {
  process.env.THREAD_USER_ID = VALID_ID;
  process.env.THREAD_TOKEN = VALID_TOKEN;
  globalThis.fetch = (async () => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  expect(await loadConfig()).toMatchObject({ userId: VALID_ID, token: VALID_TOKEN });
});

test("falls back to the Mac app's loopback pairing endpoint", async () => {
  delete process.env.THREAD_USER_ID;
  delete process.env.THREAD_TOKEN;
  globalThis.fetch = (async (url: string) => {
    expect(url).toContain("127.0.0.1:43917");
    return new Response(
      JSON.stringify({ userId: VALID_ID, token: VALID_TOKEN, apiBaseUrl: "http://localhost:8787" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  expect(await loadConfig()).toEqual({
    userId: VALID_ID,
    token: VALID_TOKEN,
    apiBaseUrl: "http://localhost:8787",
  });
});

test("throws a helpful error when nothing is available", async () => {
  delete process.env.THREAD_USER_ID;
  delete process.env.THREAD_TOKEN;
  globalThis.fetch = (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;
  await expect(loadConfig()).rejects.toThrow(/Thread for Mac|THREAD_USER_ID/);
});
