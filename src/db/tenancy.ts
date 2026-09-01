import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "./client";

// Read lazily, not as a module-level const -- see auth.ts's registryPath() for why.
function dataDir(): string {
  return process.env.THREAD_DATA_DIR ?? "data/users";
}

/**
 * userId flows into a filesystem path (one SQLite file per user). Since it's created by
 * createUser() as `user_<32 hex chars>` this should never fail in practice, but any value
 * reaching this from an HTTP request is untrusted until checked -- rejecting anything else here
 * is what actually prevents path traversal (e.g. a crafted userId of "../../etc/passwd"), not a
 * hope that callers always pass well-formed ids.
 */
function assertSafeUserId(userId: string): void {
  if (!/^user_[a-f0-9]{24}$/.test(userId)) {
    throw new Error(`Invalid userId: ${userId}`);
  }
}

export function dbPathForUser(userId: string): string {
  assertSafeUserId(userId);
  return join(dataDir(), `${userId}.db`);
}

export function openUserDb(userId: string): Database {
  return openDb(dbPathForUser(userId));
}
