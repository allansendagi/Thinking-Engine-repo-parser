import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUser,
  issueToken,
  openRegistry,
  revokeOtherSessions,
  revokeTokenHash,
  verifyToken,
  verifyTokenHash,
} from "./auth";

// Revocation must stick. The registry used to re-copy users.token_hash into auth_tokens on every
// open, which resurrected an account's FIRST token immediately after it was revoked.

let dir: string;
let prev: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-revoke-"));
  prev = process.env.THREAD_REGISTRY_PATH;
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
});
afterAll(() => {
  if (prev === undefined) delete process.env.THREAD_REGISTRY_PATH;
  else process.env.THREAD_REGISTRY_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("sign out other devices also signs out the account's original token", async () => {
  const first = await createUser(undefined, "Mac");
  const second = await issueToken(first.userId, "Website");
  const keep = (await verifyTokenHash(first.userId, second))!;
  expect(revokeOtherSessions(first.userId, keep)).toBe(1);
  expect(await verifyToken(first.userId, first.token)).toBe(false);
  expect(await verifyToken(first.userId, second)).toBe(true);
});

test("sign out this device revokes the original token for good", async () => {
  const user = await createUser(undefined, "Mac");
  const hash = (await verifyTokenHash(user.userId, user.token))!;
  expect(revokeTokenHash(hash)).toBe(1);
  openRegistry().close(); // any later open must not bring it back
  expect(await verifyToken(user.userId, user.token)).toBe(false);
});

test("the users table no longer holds a token hash", async () => {
  const user = await createUser();
  const db = openRegistry();
  const row = db.query("SELECT token_hash FROM users WHERE id = ?").get(user.userId) as { token_hash: string };
  db.close();
  expect(row.token_hash).toBe("");
});
