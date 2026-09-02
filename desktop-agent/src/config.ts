export interface AgentConfig {
  apiBaseUrl: string;
  userId: string;
  token: string;
}

/** Thread for Mac's loopback pairing endpoint -- the same one the browser extension adopts from. */
const PAIRING_URL = "http://127.0.0.1:43917/thread/pair";

interface PairPayload {
  userId?: unknown;
  token?: unknown;
  apiBaseUrl?: unknown;
}

const isUserId = (v: unknown): v is string => typeof v === "string" && /^user_[a-f0-9]{24}$/.test(v);
const isToken = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

async function fetchDesktopPairing(): Promise<AgentConfig | null> {
  try {
    const res = await fetch(PAIRING_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as PairPayload;
    if (!isUserId(body.userId) || !isToken(body.token)) return null;
    const apiBaseUrl =
      typeof body.apiBaseUrl === "string" && body.apiBaseUrl.startsWith("http")
        ? body.apiBaseUrl
        : "https://api.threadnow.app";
    return { apiBaseUrl, userId: body.userId, token: body.token };
  } catch {
    return null; // Mac app not running -- fall through to env vars
  }
}

/**
 * Resolution order, so all three capture surfaces (extension, this agent, Mac app) end up on the
 * one account:
 *   1. THREAD_USER_ID / THREAD_TOKEN env vars -- explicit override, for headless/CI use
 *   2. Thread for Mac's loopback pairing endpoint -- the normal case on a desktop
 */
export async function loadConfig(): Promise<AgentConfig> {
  const apiBaseUrl = process.env.THREAD_API_BASE_URL ?? "https://api.threadnow.app";
  const userId = process.env.THREAD_USER_ID;
  const token = process.env.THREAD_TOKEN;

  if (userId && token) return { apiBaseUrl, userId, token };

  const paired = await fetchDesktopPairing();
  if (paired) return paired;

  throw new Error(
    "No credentials. Open Thread for Mac (this agent adopts its account automatically), or set " +
      "THREAD_USER_ID and THREAD_TOKEN explicitly.",
  );
}
