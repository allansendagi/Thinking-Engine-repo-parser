/**
 * Which servers this extension will ever send your conversations and your sign-in to.
 *
 * The backend address used to be taken from whatever answered on the Mac pairing port, and from
 * storage, so anything able to answer on that port (another program, another user on a shared
 * Mac) could point the extension at its own server and receive everything it captures. The
 * address is now pinned: only Thread's own server is accepted, from every source.
 *
 * An address is not a secret (it is visible in any browser's network tab), so nothing here relies
 * on hiding it. This only decides who we are willing to talk to.
 */

/** Thread's servers. When the branded address (api.threadnow.app) is live, it is added here and
 *  to the manifest's host permissions, and the Railway address is dropped in a later release. */
export const TRUSTED_API_ORIGINS: readonly string[] = ["https://thinking-engine-repo-parser-production.up.railway.app"];

export const DEFAULT_API_BASE_URL = TRUSTED_API_ORIGINS[0]!;

/** An unpacked/dev install has no `update_url`; a Chrome Web Store install always does. Only a dev
 *  install may talk to a server on this computer (127.0.0.1), so a published build never does. */
function isDevInstall(): boolean {
  try {
    const manifest = (globalThis as { chrome?: { runtime?: { getManifest?: () => object } } }).chrome?.runtime?.getManifest?.();
    return !!manifest && !("update_url" in manifest);
  } catch {
    return false;
  }
}

/**
 * The server to use for `candidate`: its origin when it is one we trust, otherwise Thread's own
 * server. Never throws, never returns anything else, so a bad value can't redirect traffic.
 */
export function trustedApiBase(candidate: unknown, allowDev: boolean = isDevInstall()): string {
  if (typeof candidate !== "string") return DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
  if (url.username || url.password) return DEFAULT_API_BASE_URL;
  if (TRUSTED_API_ORIGINS.includes(url.origin)) return url.origin;
  if (allowDev && url.protocol === "http:" && url.hostname === "127.0.0.1") return url.origin;
  return DEFAULT_API_BASE_URL;
}
