import { randomUUID } from "node:crypto";
import {
  attachEmail,
  createUser,
  deviceLabel,
  AccountHasEmailError,
  EmailInUseError,
  findAccountByEmail,
  getAccount,
  issueToken,
  listSessions,
  reassignEmail,
  revokeOtherSessions,
  revokeSession,
  revokeTokenHash,
  touchToken,
  verifyTokenHash,
} from "./auth";
import { consumeCode, issueCode, RateLimitedError } from "./authCodes";
import { clientKey, rateLimit } from "./rateLimit";
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
import { storageMode } from "../db/durability";
import { downloadSummary, isAdmin, recordDownload } from "./metrics";
import { recordFeedback } from "./feedback";
import { deleteIdea, renameIdea, setIdeaState, setOpenLoopResolved } from "../db/mutations";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { ingestConversation, type IngestConversationInput } from "./ingest";
import { parsePastedConversation } from "../import/pasteParser";
import {
  buildContinuationPacket,
  getIdea,
  getOpenLoops,
  getRecentChanges,
  getThreadState,
  searchIdeas,
  traceIdea,
} from "../mcp/tools";
import type { IdeaState } from "../types";
import type { PipelineProviders } from "../state/pipeline";

const VALID_IDEA_STATES: IdeaState[] = ["developing", "established", "rejected", "dormant", "contested"];

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

/**
 * Idea / open-loop ids can contain characters a strict HTTP client (Foundation's URLSession, in
 * the Mac app) will only send percent-encoded -- notably `:` from paste-sourced ids like
 * `<conv>::<n>`. `URL.pathname` is NOT auto-decoded, so decode the captured segment here. A raw,
 * un-encoded id has no `%` and decodes to itself, so this is safe for the existing clients.
 */
function decodePathId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed %-escape -- fall back to the literal, the lookup will 404
  }
}

/**
 * A conversation `sourceUrl` is client-supplied and only ever used as a "view source" link, so
 * keep it to a plain absolute http(s) URL and drop it otherwise. Strips query + hash (the
 * canonical conversation URL never needs them) so nothing sensitive rides along in a stored link.
 */
function sanitizeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

/** A device label from an explicit `deviceName` in the request body, else the User-Agent. */
function deviceNameFrom(body: { deviceName?: unknown } | null, req: Request): string {
  const given = typeof body?.deviceName === "string" ? body.deviceName : undefined;
  return deviceLabel(given, req.headers.get("user-agent"));
}

/** This user's current idea-node count -- drives the Free plan's capture cap. */
function ideaCountFor(userId: string): number {
  const db = openUserDb(userId);
  try {
    return loadIdeas(db).length;
  } finally {
    db.close();
  }
}

/** No ideas AND no captured messages -- an account that was minted and never actually used. */
function accountIsEmpty(userId: string): boolean {
  const db = openUserDb(userId);
  try {
    return loadIdeas(db).length === 0 && loadCanonicalEvents(db).length === 0;
  } finally {
    db.close();
  }
}

/**
 * `Authorization: Bearer <userId>:<token>`. On success returns `{ userId, tokenHash }` -- the
 * hash identifies which device row made the request (for last-seen, the session list, and "sign
 * out this device"). On failure returns a 401 Response.
 */
async function authenticate(req: Request): Promise<{ userId: string; tokenHash: string } | Response> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer (user_[a-f0-9]{24}):([a-f0-9]{64})$/);
  if (!match) return error(401, "Missing or malformed Authorization header");
  const [, userId, token] = match as unknown as [string, string, string];
  const tokenHash = await verifyTokenHash(userId, token);
  if (!tokenHash) return error(401, "Invalid credentials");
  return { userId, tokenHash };
}

export function createRequestHandler(providers: PipelineProviders): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/v1/health") {
      return json({ status: "ok", storage: storageMode() });
    }

    if (req.method === "POST" && pathname === "/v1/users") {
      // Anon account creation is unauthenticated by design (zero-setup first launch). Cap it per
      // IP so a loop can't fill the volume with `users` rows + a per-user SQLite file each.
      if (!rateLimit(clientKey(req, "users"), { limit: 15, windowMs: 3_600_000 })) {
        return error(429, "Too many accounts created from here. Try again later.");
      }
      let uBody: { deviceName?: string } = {};
      try {
        uBody = (await req.json()) as { deviceName?: string };
      } catch {
        /* body is optional here */
      }
      const user = await createUser(undefined, deviceNameFrom(uBody, req));
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
      // Per-IP ceiling on top of authCodes.ts's per-email limit -- one IP shouldn't be able to
      // spray sign-in codes at many different addresses.
      if (!rateLimit(clientKey(req, "auth-start"), { limit: 20, windowMs: 3_600_000 })) {
        return error(429, "Too many sign-in attempts from here. Try again later.");
      }
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
      let body: { email?: string; code?: string; deviceName?: string };
      try {
        body = (await req.json()) as { email?: string; code?: string; deviceName?: string };
      } catch {
        return error(400, "Invalid JSON body");
      }
      const email = (body.email ?? "").trim();
      const code = (body.code ?? "").trim();
      if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return error(400, "Email and 6-digit code are required");
      if (!(await consumeCode(email, code))) return error(400, "That code is wrong or expired", "bad_code");

      const label = deviceNameFrom(body, req);
      const existing = findAccountByEmail(email);
      if (existing) {
        // Sign-in issues a token for *this* device. Other devices (Mac app, extension,
        // desktop agent) keep their own tokens -- see auth.ts `auth_tokens`.
        const token = await issueToken(existing.userId, label);
        return json({ userId: existing.userId, token });
      }
      const created = await createUser(email, label);
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

    // Download counter -- public, no auth (anyone can download). The website's /download/mac
    // endpoint pings this, then redirects to the DMG. Best-effort: a bad body still 204s.
    if (req.method === "POST" && pathname === "/v1/events/download") {
      // Public beacon: silently drop once an IP is over the ceiling so a loop can't inflate the
      // /admin numbers or grow the table without bound. Still a 204 -- it's fire-and-forget.
      if (!rateLimit(clientKey(req, "download"), { limit: 40, windowMs: 3_600_000 })) {
        return new Response(null, { status: 204 });
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* empty / malformed body is fine */
      }
      try {
        recordDownload({
          platform: body.platform,
          version: body.version,
          referrer: body.referrer,
          country: body.country ?? req.headers.get("x-vercel-ip-country"),
          uaFamily: deviceLabel(null, (body.uaFamily as string) ?? req.headers.get("user-agent")),
        });
      } catch (e) {
        console.error("[Thread] download event failed:", e);
      }
      return new Response(null, { status: 204 });
    }

    // "Report an issue" from the website footer -- public, unauthenticated, rate-limited.
    if (req.method === "POST" && pathname === "/v1/feedback") {
      if (!rateLimit(clientKey(req, "feedback"), { limit: 6, windowMs: 3_600_000 })) {
        return error(429, "Too many reports from here. Try again later.");
      }
      let fb: Record<string, unknown> = {};
      try {
        fb = (await req.json()) as Record<string, unknown>;
      } catch {
        return error(400, "Invalid JSON body");
      }
      const result = await recordFeedback({
        kind: fb.kind,
        message: fb.message,
        email: fb.email,
        page: fb.page,
        userAgent: fb.userAgent ?? req.headers.get("user-agent"),
      });
      if (!result.ok) {
        return error(
          400,
          result.error === "message_too_short"
            ? "Please add a little more detail."
            : "That's longer than we can accept — please trim it.",
          result.error,
        );
      }
      return json({ ok: true });
    }

    // Every route below requires auth.
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const { userId, tokenHash } = auth;
    touchToken(tokenHash); // throttled last-seen bump for the session list

    // Admin-only product metrics (THREAD_ADMIN_EMAILS). Downloads for now.
    if (req.method === "GET" && pathname === "/v1/events/downloads") {
      if (!isAdmin(getAccount(userId)?.email)) return error(403, "Not authorized");
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
      return json(downloadSummary(days));
    }

    // --- Device sessions (list / revoke) --------------------------------------------------
    if (req.method === "GET" && pathname === "/v1/auth/sessions") {
      return json({ sessions: listSessions(userId, tokenHash) });
    }
    if (req.method === "DELETE" && pathname === "/v1/auth/session") {
      // Sign out THIS device -- revoke exactly the token that made this request.
      return json({ revoked: revokeTokenHash(tokenHash) });
    }
    if (req.method === "POST" && pathname === "/v1/auth/sessions/revoke-others") {
      // Sign out everywhere else -- keep only the caller's token.
      return json({ revoked: revokeOtherSessions(userId, tokenHash) });
    }
    const sessionMatch = pathname.match(/^\/v1\/auth\/sessions\/([a-f0-9]{16})$/);
    if (req.method === "DELETE" && sessionMatch) {
      const n = revokeSession(userId, sessionMatch[1]!);
      return n > 0 ? json({ revoked: n }) : error(404, "No such session");
    }

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
        if (e instanceof AccountHasEmailError) {
          return error(
            409,
            `This device is already linked to ${e.currentEmail}. Sign out first, then sign in with a different email.`,
            "account_has_email",
          );
        }
        if (e instanceof EmailInUseError) {
          // If the email is sitting on an account that was minted and never used (0 ideas, 0
          // captured messages -- e.g. a stray website sign-in), just move it here rather than
          // stranding the user. Only a real account with data gets protected with a 409.
          if (accountIsEmpty(e.ownerUserId)) {
            reassignEmail(e.ownerUserId, userId, email);
            return json({
              userId,
              ...accountView(getAccount(userId)!, ideaCountFor(userId)),
              reclaimedFromEmptyAccount: true,
            });
          }
          return error(
            409,
            "That email is already on another Thread account that has ideas in it. Sign in with that email instead.",
            "email_in_use",
          );
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
        // Accept only a plain http(s) URL; anything else (or absent) is stored as null rather
        // than trusted verbatim into the DB.
        body.sourceUrl = sanitizeSourceUrl(body.sourceUrl);
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
        const [, rawIdeaId, isTrace] = ideaMatch;
        const ideaId = decodePathId(rawIdeaId as string);
        const result = isTrace ? traceIdea(db, ideaId) : getIdea(db, ideaId);
        return result ? json(result) : error(404, "Idea not found");
      }

      if (req.method === "DELETE" && ideaMatch && !ideaMatch[2]) {
        const ideaId = decodePathId(ideaMatch[1] as string);
        const deleted = deleteIdea(db, ideaId);
        return deleted ? json({ deleted: true }) : error(404, "Idea not found");
      }

      if (req.method === "PATCH" && ideaMatch && !ideaMatch[2]) {
        const ideaId = decodePathId(ideaMatch[1] as string);
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
        const loopId = decodePathId(loopMatch[1] as string);
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
        let body: { topic?: string; ideaId?: string };
        try {
          body = (await req.json()) as { topic?: string; ideaId?: string };
        } catch {
          return error(400, "Invalid JSON body");
        }
        if (!body.topic && !body.ideaId) return error(400, "topic or ideaId is required");
        // Returns { text, packet }. `text` is the paste-ready render with a CONTINUE_TOKEN where
        // the "Continue from here" line goes -- a client fills it with packet.suggestedNext or
        // the user's edit (see resolveContinueToken) so the field stays editable offline.
        // `packet` carries the structured fields (source affordances, full evolution list).
        const result = await buildContinuationPacket(
          db,
          { ideaId: body.ideaId, topic: body.topic },
          providers.reasoning,
        );
        if (!result) return error(404, body.ideaId ? "Idea not found" : "No matching ideas");
        return json(result);
      }

      return error(404, "Not found");
    } finally {
      db.close();
    }
  };
}
