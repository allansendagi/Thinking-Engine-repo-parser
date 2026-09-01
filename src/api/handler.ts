import { createUser, verifyToken } from "./auth";
import { openUserDb } from "../db/tenancy";
import { deleteIdea, renameIdea, setIdeaState, setOpenLoopResolved } from "../db/mutations";
import { ingestConversation, type IngestConversationInput } from "./ingest";
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

function error(status: number, message: string): Response {
  return json({ error: message }, status);
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

    // Every route below requires auth.
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    const userId = auth;
    const db = openUserDb(userId);

    try {
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
