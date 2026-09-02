import { randomUUID } from "node:crypto";
import {
  attachEmail,
  createUser,
  EmailInUseError,
  findAccountByEmail,
  getAccount,
  issueToken,
  verifyToken,
} from "./auth";
import { consumeCode, issueCode, RateLimitedError } from "./authCodes";
import { sendEmail, signInCodeEmail } from "./email";
import {
  accountView,
  applyPaddleEvent,
  billingConfigured,
  canCapture,
  createPortalLink,
  isProActive,
  verifyPaddleSignature,
} from "./billing";
import { openUserDb } from "../db/tenancy";
import { deleteIdea, renameIdea, setIdeaState, setOpenLoopResolved } from "../db/mutations";
import { loadIdeas } from "../db/queries";
import { ingestConversation, type IngestConversationInput } from "./ingest";
import { parsePastedConversation } from "../import/pasteParser";
import {
  continueThinking,
  getIdea,
  getOpenLoops,
  getRecentChanges,
  getThreadState,
  searchIdeas,
  traceIdea,
} from "../mcp/tools";
import type { IdeaState } from "../types";
import type { PipelineProviders } from "../state/pipeline";

const VALID_IDEA_STATES: IdeaState[] = ["developing", "established", "rejected", "dormant"];

/**
 * The whole API as a pure (Request) => Response function, deliberately separate from Bun.serve
 * (server.ts is a two-line wrapper around this). That's what makes it testable with plain
 * `fetch(new Request(...))` calls and no network port -- see handler.test.ts.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, message: string, code?: string): Response {
  return json(code ? { error: message, code } : { error: message }, status);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** This user's current idea-node count -- drives the Free plan's capture cap. */
function ideaCountFor(userId: string): number {
  const db = openUserDb(userId);
  try {
    return loadIdeas(db).length;
  } finally {
    db.close();
  }
}

/** `Authorization: Bearer <userId>:<token>`. Returns the userId if valid, or a 401 Response. */
async function authenticate(req: Request): Promise<string | Response> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer (user_[a-f0-9]{24}):([a-f0-9]{64})$/);
  if (!match) return error(401, "Missing or malformed Authorization header");
  const [, userId, token] = match as unknown as [string, string, string];
  const ok = await verifyToken(userId, token);
  if (!ok) return error(401, "Invalid credentials");
  return userId;
}

export function createRequestHandler(providers: PipelineProviders): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/v1/health") {
      return json({ status: "ok" });
    }

    if (req.method === "POST" && pathname === "/v1/users") {
      const user = await createUser();
      return json(user, 201);
    }

    // --- Passwordless sign-in: email + 6-digit code (public) --------------------------------
    if (req.method === "POST" && pathname === "/v1/auth/start") {
      let body: { email?: string };
      try {
        body = (await req.json()) as { email?: string };
      } catch {
        return error(400, "Invalid JSON body");
      }
      const email = (body.email ?? "").trim();
      if (!EMAIL_RE.test(email)) return error(400, "A valid email is required");
      try {
        const code = await issueCode(email);
        await sendEmail({ to: email, ...signInCodeEmail(code) });
      } catch (e) {
        if (e instanceof RateLimitedError) return error(429, e.message);
        console.error("[Thread] auth/start failed:", e);
        return error(502, "Could not send the sign-in code");
      }
      return json({ ok: true }); // never reveal whether the email has an account
    }

    if (req.method === "POST" && pathname === "/v1/auth/verify") {
      let body: { email?: string; code?: string };
      try {
        body = (await req.json()) as { email?: string; code?: string };
      } catch {
        return error(400, "Invalid JSON body");
      }
      const email = (body.email ?? "").trim();
      const code = (body.code ?? "").trim();
      if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return error(400, "Email and 6-digit code are required");
      if (!(await consumeCode(email, code))) return error(400, "That code is wrong or expired", "bad_code");

      const existing = findAccountByEmail(email);
      if (existing) {
        // Sign-in issues a token for *this* device. Other devices (Mac app, extension,
        // desktop agent) keep their own tokens -- see auth.ts `auth_tokens`.
        const token = await issueToken(existing.userId);
        return json({ userId: existing.userId, token });
      }
      const created = await createUser(email);
      return json(created, 201);
    }

    // Paddle calls this -- no Thread bearer token. Verified by signature instead.
    if (req.method === "POST" && pathname === "/v1/paddle/webhook") {
      const secret = process.env.PADDLE_WEBHOOK_SECRET;
      const sig = req.headers.get("paddle-signature") ?? "";
      const raw = await req.text();
      if (!secret || !verifyPaddleSignature(raw, sig, secret)) {
        return error(400, "Bad signature");
      }
      try {
        applyPaddleEvent(JSON.parse(raw));
      } catch (e) {
        console.error("[Thread] paddle webhook handling failed:", e);
        return error(500, "Webhook handling failed");
      }
      return json({ received: true });
    }

    // Every route below requires auth.
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const userId = auth;

    if (req.method === "GET" && pathname === "/v1/account") {
      const account = getAccount(userId);
      if (!account) return error(404, "Account not found");
      return json({ userId, ...accountView(account, ideaCountFor(userId)) });
    }

    // --- Claim an anonymous account by attaching a verified email --------------------------
    if (req.method === "POST" && pathname === "/v1/account/email") {
      let body: { email?: string };
      try {
        body = (await req.json()) as { email?: string };
      } catch {
        return error(400, "Invalid JSON body");
      }
      const email = (body.email ?? "").trim();
      if (!EMAIL_RE.test(email)) return error(400, "A valid email is required");
      try {
        const code = await issueCode(email);
        await sendEmail({ to: email, ...signInCodeEmail(code) });
      } catch (e) {
        if (e instanceof RateLimitedError) return error(429, e.message);
        return error(502, "Could not send the code");
      }
      return json({ ok: true });
    }

    if (req.method === "POST" && pathname === "/v1/account/email/verify") {
      let body: { email?: string; code?: string };
      try {
        body = (await req.json()) as { email?: string; code?: string };
      } catch {
        return error(400, "Invalid JSON body");
      }
      const email = (body.email ?? "").trim();
      const code = (body.code ?? "").trim();
      if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return error(400, "Email and 6-digit code are required");
      if (!(await consumeCode(email, code))) return error(400, "That code is wrong or expired", "bad_code");
      try {
        attachEmail(userId, email);
      } catch (e) {
        if (e instanceof EmailInUseError) {
          return error(409, "That email already belongs to another Thread account. Sign in with it instead.", "email_in_use");
        }
        throw e;
      }
      return json({ userId, ...accountView(getAccount(userId)!, ideaCountFor(userId)) });
    }

    if (req.method === "GET" && pathname === "/v1/billing/portal") {
      const account = getAccount(userId);
      if (!account?.paddleCustomerId) return error(409, "No billing account yet -- subscribe first");
      try {
        return json({ url: await createPortalLink(account) });
      } catch (e) {
        return error(502, e instanceof Error ? e.message : "Portal failed");
      }
    }

    const db = openUserDb(userId);

    try {
      // Soft lock. Reads are never gated. No-op until Paddle is actually configured.
      // One DB open serves both the gate check and the request body below.
      const isCaptureRoute =
        req.method === "POST" && (pathname === "/v1/conversations" || pathname === "/v1/paste");
      if (isCaptureRoute && billingConfigured() && !canCapture(getAccount(userId), loadIdeas(db).length)) {
        return error(
          402,
          "You've hit the Free plan's 25-idea limit. Upgrade to Pro from your Thread account to keep capturing.",
          "upgrade_required",
        );
      }

      // MCP / AI continuation is a Pro feature.
      if (
        req.method === "POST" &&
        pathname === "/v1/continue" &&
        billingConfigured() &&
        !isProActive(getAccount(userId))
      ) {
        return error(402, "Continuing an idea with AI is a Pro feature. Upgrade from your Thread account.", "pro_required");
      }

      if (req.method === "POST" && pathname === "/v1/conversations") {
        let body: IngestConversationInput;
        try {
          body = (await req.json()) as IngestConversationInput;
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (!body.conversationId || !Array.isArray(body.messages)) {
          return error(400, "conversationId and messages[] are required");
        }
        const result = await ingestConversation(db, body, providers);
        return json(result);
      }

      if (req.method === "POST" && pathname === "/v1/paste") {
        let body: { conversationId?: string; text?: string };
        try {
          body = (await req.json()) as { conversationId?: string; text?: string };
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (!body.text || body.text.trim().length === 0) return error(400, "text is required");

        const parsed = parsePastedConversation(body.text);
        if (parsed.length === 0) return error(400, "Nothing parseable in the pasted text");

        const conversationId = body.conversationId ?? `paste_${randomUUID()}`;
        const baseTime = Date.now();
        const messages = parsed.map((m, i) => ({
          id: `${conversationId}::${i}`,
          role: m.role,
          text: m.text,
          // Synthesized, evenly spaced timestamps -- a paste has no real per-message timestamps.
          // Order is preserved (what identity resolution's temporal signal actually needs); the
          // exact spacing is a placeholder, not a claim about when these were really said.
          createdAt: new Date(baseTime + i * 1000).toISOString(),
        }));

        const result = await ingestConversation(db, { conversationId, source: "paste", messages }, providers);
        return json({ conversationId, ...result });
      }

      if (req.method === "GET" && pathname === "/v1/ideas") {
        const q = url.searchParams.get("q") ?? "";
        return json(searchIdeas(db, q));
      }

      const ideaMatch = pathname.match(/^\/v1\/ideas\/([^/]+)(\/trace)?$/);
      if (req.method === "GET" && ideaMatch) {
        const [, ideaId, isTrace] = ideaMatch;
        const result = isTrace ? traceIdea(db, ideaId as string) : getIdea(db, ideaId as string);
        return result ? json(result) : error(404, "Idea not found");
      }

      if (req.method === "DELETE" && ideaMatch && !ideaMatch[2]) {
        const ideaId = ideaMatch[1] as string;
        const deleted = deleteIdea(db, ideaId);
        return deleted ? json({ deleted: true }) : error(404, "Idea not found");
      }

      if (req.method === "PATCH" && ideaMatch && !ideaMatch[2]) {
        const ideaId = ideaMatch[1] as string;
        let body: { state?: string; title?: string };
        try {
          body = (await req.json()) as { state?: string; title?: string };
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (body.state === undefined && body.title === undefined) {
          return error(400, "Provide at least one of: state, title");
        }
        if (body.state !== undefined) {
          if (!VALID_IDEA_STATES.includes(body.state as IdeaState)) {
            return error(400, `state must be one of: ${VALID_IDEA_STATES.join(", ")}`);
          }
          if (!setIdeaState(db, ideaId, body.state as IdeaState)) return error(404, "Idea not found");
        }
        if (body.title !== undefined) {
          try {
            if (!renameIdea(db, ideaId, body.title)) return error(404, "Idea not found");
          } catch (e) {
            return error(400, e instanceof Error ? e.message : "Invalid title");
          }
        }
        const updated = getIdea(db, ideaId);
        return updated ? json(updated) : error(404, "Idea not found");
      }

      const loopMatch = pathname.match(/^\/v1\/open-loops\/([^/]+)$/);
      if (req.method === "PATCH" && loopMatch) {
        const loopId = loopMatch[1] as string;
        let body: { resolved?: boolean };
        try {
          body = (await req.json()) as { resolved?: boolean };
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (typeof body.resolved !== "boolean") return error(400, "resolved (boolean) is required");
        const updated = setOpenLoopResolved(db, loopId, body.resolved);
        return updated ? json({ updated: true }) : error(404, "Open loop not found");
      }

      if (req.method === "GET" && pathname === "/v1/thinking-state") {
        const topic = url.searchParams.get("topic") ?? undefined;
        return json(getThreadState(db, topic));
      }

      if (req.method === "GET" && pathname === "/v1/open-loops") {
        const topic = url.searchParams.get("topic") ?? undefined;
        return json(getOpenLoops(db, topic));
      }

      if (req.method === "GET" && pathname === "/v1/recent-changes") {
        const sinceDaysParam = url.searchParams.get("sinceDays");
        const sinceDays = sinceDaysParam ? Number(sinceDaysParam) : undefined;
        return json(getRecentChanges(db, sinceDays));
      }

      if (req.method === "POST" && pathname === "/v1/continue") {
        let body: { topic?: string };
        try {
          body = (await req.json()) as { topic?: string };
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (!body.topic) return error(400, "topic is required");
        try {
          const text = await continueThinking(db, body.topic, providers.reasoning);
          return json({ text });
        } catch (e) {
          return error(404, e instanceof Error ? e.message : "No matching ideas");
        }
      }

      return error(404, "Not found");
    } finally {
      db.close();
    }
  };
}
