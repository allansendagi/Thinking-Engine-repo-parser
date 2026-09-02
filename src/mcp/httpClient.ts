/**
 * Credential resolution + a typed fetch wrapper for the HTTP-backed MCP server. The point of the
 * HTTP server (vs. mcp/server.ts, which opens a local SQLite file) is that a user's real thinking
 * state lives in the hosted, per-account backend -- so a compatible AI tool has to reach it the
 * same way the extension and Mac app do: with the account's bearer token.
 */

const PRODUCTION_API = "https://api.threadnow.app";
const PAIRING_URL = "http://127.0.0.1:43917/thread/pair";

export interface ThreadCredentials {
  apiBaseUrl: string;
  userId: string;
  token: string;
}

const isUserId = (v: unknown): v is string => typeof v === "string" && /^user_[a-f0-9]{24}$/.test(v);
const isToken = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

async function fromDesktopApp(): Promise<ThreadCredentials | null> {
  try {
    const res = await fetch(PAIRING_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (!isUserId(body.userId) || !isToken(body.token)) return null;
    const apiBaseUrl = typeof body.apiBaseUrl === "string" && body.apiBaseUrl.startsWith("http") ? body.apiBaseUrl : PRODUCTION_API;
    return { apiBaseUrl, userId: body.userId, token: body.token };
  } catch {
    return null;
  }
}

/** Env vars win (headless use); otherwise adopt the account from a running Thread for Mac. */
export async function resolveCredentials(): Promise<ThreadCredentials> {
  const apiBaseUrl = process.env.THREAD_API_BASE_URL ?? PRODUCTION_API;
  const userId = process.env.THREAD_USER_ID;
  const token = process.env.THREAD_TOKEN;
  if (userId && token) return { apiBaseUrl, userId, token };

  const paired = await fromDesktopApp();
  if (paired) return paired;

  throw new Error(
    "Thread MCP: no credentials. Open Thread for Mac (the server adopts its account " +
      "automatically), or set THREAD_USER_ID and THREAD_TOKEN.",
  );
}

export function makeClient(creds: ThreadCredentials) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${creds.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.userId}:${creds.token}`,
        ...init.headers,
      },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) throw new Error(body.error ?? `Thread API ${res.status} for ${path}`);
    return body;
  }

  const qs = (params: Record<string, string | number | undefined>): string => {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
    return entries.length ? "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&") : "";
  };

  return {
    searchIdeas: (query: string) => call(`/v1/ideas${qs({ q: query })}`),
    getIdea: (id: string) => call(`/v1/ideas/${encodeURIComponent(id)}`),
    traceIdea: (id: string) => call(`/v1/ideas/${encodeURIComponent(id)}/trace`),
    getThreadState: (topic?: string) => call(`/v1/thinking-state${qs({ topic })}`),
    getOpenLoops: (topic?: string) => call(`/v1/open-loops${qs({ topic })}`),
    getRecentChanges: (sinceDays?: number) => call(`/v1/recent-changes${qs({ sinceDays })}`),
    continueThinking: (topic: string) =>
      call<{ text: string; packet: { suggestedNext: string } }>(`/v1/continue`, {
        method: "POST",
        body: JSON.stringify({ topic }),
      }),
  };
}
