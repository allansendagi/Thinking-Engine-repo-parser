import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "./client";

/**
 * Where the per-user SQLite files live. Read lazily, not as a module-level const -- see auth.ts's
 * registryPath() for why. Resolution order:
 *   1. THREAD_DATA_DIR                -- explicit override
 *   2. $RAILWAY_VOLUME_MOUNT_PATH/users -- Railway injects this when a volume is attached, so
 *      attaching one in the dashboard is all that's needed for data to survive redeploys
 *   3. data/users                    -- local dev default (ephemeral in a container)
 */
export function dataDir(): string {
  if (process.env.THREAD_DATA_DIR) return process.env.THREAD_DATA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "users");
  return "data/users";
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
