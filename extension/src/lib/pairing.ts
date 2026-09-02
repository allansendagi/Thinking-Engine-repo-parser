import type { Credentials } from "./types";

/**
 * Local handshake with Thread for Mac. The Mac app is the account authority: it creates the
 * account and, while running, serves the credentials on a loopback-only HTTP endpoint. The
 * extension adopts them so both clients read and write the same per-user store on the backend.
 *
 * Loopback only (127.0.0.1), so nothing off-device can reach it. The manifest grants
 * `http://127.0.0.1/*` as a host permission, which is what lets the service worker fetch this
 * without a CORS preflight.
 */

export const PAIRING_PORT = 43917;
export const PAIRING_URL = `http://127.0.0.1:${PAIRING_PORT}/thread/pair`;

interface PairPayload {
  userId?: unknown;
  token?: unknown;
  apiBaseUrl?: unknown;
}

export interface DesktopPairing {
  credentials: Credentials;
  apiBaseUrl: string;
}

function isValidUserId(v: unknown): v is string {
  return typeof v === "string" && /^user_[a-f0-9]{24}$/.test(v);
}
function isValidToken(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}

/**
 * Returns credentials from a running Mac app, or null if it isn't reachable (not running, or the
 * pairing window is closed). Never throws for the "app not there" case -- that's the normal state
 * before the app is installed -- but does throw if the app answers with something malformed,
 * since that's a real bug worth surfacing.
 */
export async function fetchDesktopPairing(timeoutMs = 1500): Promise<DesktopPairing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(PAIRING_URL, { signal: controller.signal, cache: "no-store" });
  } catch {
    return null; // connection refused / aborted -- app not running or not in pairing mode
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404 || res.status === 403) return null; // app up, pairing window closed
  if (!res.ok) throw new Error(`Thread for Mac returned ${res.status} from the pairing endpoint`);

  const body = (await res.json().catch(() => null)) as PairPayload | null;
  if (!body || !isValidUserId(body.userId) || !isValidToken(body.token)) {
    throw new Error("Thread for Mac sent a malformed pairing response");
  }
  const apiBaseUrl =
    typeof body.apiBaseUrl === "string" && body.apiBaseUrl.startsWith("http")
      ? body.apiBaseUrl
      : "https://api.threadnow.app";

  return { credentials: { userId: body.userId, token: body.token }, apiBaseUrl };
}

/** Parses a hand-copied pairing string of the form `user_<24hex>:<64hex>`. */
export function parsePairingString(raw: string): Credentials | null {
  const parts = raw.trim().split(":");
  if (parts.length !== 2) return null;
  const [userId, token] = parts;
  if (!isValidUserId(userId) || !isValidToken(token)) return null;
  return { userId, token };
}
