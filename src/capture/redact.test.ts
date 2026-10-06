import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactDeep, redactSecrets } from "./redact";

/** Shared vectors -- the extension copy and the Swift mirror are checked against these too. */
export const REDACTION_VECTORS: [input: string, expected: string][] = [
  ["my key is sk-proj-abcdefghijklmnopqrstuvwx123", "my key is [redacted api key]"],
  ["export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "export ANTHROPIC_API_KEY=[redacted api key]"],
  ["aws AKIAIOSFODNN7EXAMPLE done", "aws [redacted aws key] done"],
  ["token ghp_" + "a".repeat(36), "token [redacted github token]"],
  ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "Authorization: Bearer [redacted bearer token]"],
  ['password = "hunter2hunter2"', 'password = "[redacted secret]"'],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "[redacted private key]"],
  // ordinary thinking is untouched
  ["We should charge per seat, not a flat fee.", "We should charge per seat, not a flat fee."],
  ["the password reset flow needs a second step", "the password reset flow needs a second step"],
  ["const task = await sk(request)", "const task = await sk(request)"],
];

describe("on-device secret redaction", () => {
  for (const [input, expected] of REDACTION_VECTORS) {
    test(JSON.stringify(input.slice(0, 40)), () => expect(redactSecrets(input)).toBe(expected));
  }

  test("idempotent: the server re-running the pass on already-redacted text changes nothing", () => {
    for (const [input] of REDACTION_VECTORS) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  test("walks export-shaped JSON", () => {
    expect(redactDeep({ mapping: { a: { parts: ["key sk-abcdefghijklmnopqrstuvwxyz"] } }, n: 3 })).toEqual({
      mapping: { a: { parts: ["key [redacted api key]"] } },
      n: 3,
    });
  });

  test("the extension's copy is identical", () => {
    const here = readFileSync(join(import.meta.dir, "redact.ts"), "utf-8");
    const ext = readFileSync(join(import.meta.dir, "../../extension/src/lib/redact.ts"), "utf-8");
    expect(ext).toBe(here);
  });
});
