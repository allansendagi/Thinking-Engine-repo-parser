import { describe, expect, test } from "bun:test";
import { DEFAULT_API_BASE_URL, trustedApiBase } from "./apiOrigin";

describe("trustedApiBase", () => {
  test("Thread's own server is accepted, normalised to its origin", () => {
    expect(trustedApiBase(DEFAULT_API_BASE_URL, false)).toBe(DEFAULT_API_BASE_URL);
    expect(trustedApiBase(`${DEFAULT_API_BASE_URL}/some/path?x=1`, false)).toBe(DEFAULT_API_BASE_URL);
  });

  test("any other server falls back to Thread's own, whatever the source says", () => {
    for (const evil of [
      "https://attacker.example",
      "http://attacker.example",
      "https://thinking-engine-repo-parser-production.up.railway.app.attacker.example",
      "https://attacker.example/https://thinking-engine-repo-parser-production.up.railway.app",
      "http://thinking-engine-repo-parser-production.up.railway.app", // plain http
      "https://user:pw@thinking-engine-repo-parser-production.up.railway.app",
      "javascript:alert(1)",
      "not a url",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(trustedApiBase(evil, false)).toBe(DEFAULT_API_BASE_URL);
    }
  });

  test("a server on this computer is only for a dev install", () => {
    expect(trustedApiBase("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000");
    expect(trustedApiBase("http://127.0.0.1:3000", false)).toBe(DEFAULT_API_BASE_URL);
    expect(trustedApiBase("http://localhost:3000", true)).toBe(DEFAULT_API_BASE_URL);
    expect(trustedApiBase("http://127.0.0.1.attacker.example", true)).toBe(DEFAULT_API_BASE_URL);
  });
});
