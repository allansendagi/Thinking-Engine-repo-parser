export interface AgentConfig {
  apiBaseUrl: string;
  userId: string;
  token: string;
}

/**
 * Env-var config, matching how the backend itself is configured -- no separate config-file
 * mechanism to build and keep in sync. Get userId/token from `bun src/cli.ts import ...` (in the
 * backend repo) or POST /v1/users directly; there's no auto-pairing here the way the extension
 * does it, since a desktop agent isn't a fresh install with no prior context the way a new
 * browser profile is -- it's reasonable to require deliberately supplying an existing account.
 */
export function loadConfig(): AgentConfig {
  const apiBaseUrl = process.env.THREAD_API_BASE_URL ?? "https://thinking-engine-repo-parser-production.up.railway.app";
  const userId = process.env.THREAD_USER_ID;
  const token = process.env.THREAD_TOKEN;

  if (!userId || !token) {
    throw new Error(
      "THREAD_USER_ID and THREAD_TOKEN must be set. Create an account with the backend's " +
        "`bun src/cli.ts import ...` (it prints credentials) or POST /v1/users directly.",
    );
  }

  return { apiBaseUrl, userId, token };
}
