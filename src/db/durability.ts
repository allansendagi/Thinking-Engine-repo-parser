/**
 * Storage-durability guard.
 *
 * `registry.db` (accounts, per-device tokens, login codes) and every per-user database resolve
 * to a local `data/` directory unless an explicit override or a mounted volume redirects them
 * (see auth.ts `registryPath()` and tenancy.ts `dataDir()`). On a container host that local
 * directory is wiped on every redeploy -- which silently 401s every account the next time the
 * service restarts. This turns that from a silent outage into a failed boot.
 */

export type StorageMode = "explicit" | "railway-volume" | "local";

/** How storage paths are currently being resolved. `local` on a container host is the danger. */
export function storageMode(): StorageMode {
  if (process.env.THREAD_REGISTRY_PATH || process.env.THREAD_DATA_DIR) return "explicit";
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return "railway-volume";
  return "local";
}

/** Best-effort "am I running in an ephemeral container" check across the common PaaS hosts. */
function onEphemeralHost(): boolean {
  return !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.KUBERNETES_SERVICE_HOST ||
    process.env.DYNO // Heroku
  );
}

/**
 * Throws if we're on a container host with `local` storage and no explicit opt-in. Call once at
 * boot (server.ts), before `Bun.serve`, so a misconfigured deploy fails instead of coming up and
 * losing everyone's session on the redeploy after that.
 */
export function assertDurableStorage(): void {
  if (onEphemeralHost() && storageMode() === "local" && process.env.THREAD_ALLOW_EPHEMERAL !== "1") {
    throw new Error(
      "Refusing to start: storage is EPHEMERAL on this host.\n" +
        "  registry.db (accounts + device tokens + login codes) and every per-user database\n" +
        "  live under ./data and would be WIPED on the next redeploy -- every account would 401.\n" +
        "  Fix: attach a persistent volume (Railway: add a Volume to the service -- it injects\n" +
        "  RAILWAY_VOLUME_MOUNT_PATH and storage follows automatically), or set THREAD_REGISTRY_PATH\n" +
        "  and THREAD_DATA_DIR to a durable path.\n" +
        "  Override (throwaway storage on purpose): THREAD_ALLOW_EPHEMERAL=1",
    );
  }
}
