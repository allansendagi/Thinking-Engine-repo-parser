#!/usr/bin/env bun
/**
 * HTTP-backed MCP server. Exposes the same seven tools as mcp/server.ts, but reads the user's
 * real Thinking State from the hosted, per-account backend over HTTP instead of a local SQLite
 * file. This is the one to point a compatible AI tool (Claude Desktop, Cursor, the MCP inspector)
 * at -- run it with Thread for Mac open and it adopts that account automatically.
 *
 *   claude_desktop_config.json:
 *   { "mcpServers": { "thread": { "command": "bun",
 *       "args": ["run", "/path/to/thinking-engine/src/mcp/server-http.ts"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeClient, resolveCredentials } from "./httpClient";
import { resolveContinueToken } from "./tools";

const creds = await resolveCredentials();
const api = makeClient(creds);
console.error(`[Thread MCP] connected as ${creds.userId} -> ${creds.apiBaseUrl}`);

const server = new McpServer({ name: "thread-thinking-engine", version: "0.2.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * Register through one loosely-typed boundary. `McpServer.tool()` is generic over the zod shape
 * and infers a conditional type deep enough that, on a case-sensitive FS with CI's
 * module-resolution order, `tsc` reports TS2589 ("excessively deep") for every call site --
 * green on macOS, red on Linux. Calling it via a structural `{ tool: (...args) => void }` cast
 * never touches the generic overload, so the inference doesn't happen at all. Runtime is
 * unchanged (zod still validates every call); handlers annotate the fields they read.
 */
const registrar = server as unknown as { tool: (name: string, description: string, schema: z.ZodRawShape, handler: (args: any) => Promise<ToolResult>) => void };
const tool = registrar.tool.bind(registrar);

tool(
  "search_ideas",
  "Search the user's ideas by keyword. Returns idea summaries ranked by relevance.",
  { query: z.string().describe("Search terms") },
  async ({ query }) => json(await api.searchIdeas(query as string)),
);

tool(
  "get_idea",
  "Fetch one idea by id, including its full evolution, open loops, decisions, and related ideas.",
  { id: z.string() },
  async ({ id }) => json(await api.getIdea(id as string)),
);

tool(
  "trace_idea",
  "Fetch one idea's evolution alongside the original source text each step is grounded in.",
  { id: z.string() },
  async ({ id }) => json(await api.traceIdea(id as string)),
);

tool(
  "get_thread_state",
  "Reconstruct the Thinking State for a topic: current ideas, recent changes, decisions, open loops, contradictions, related ideas.",
  { topic: z.string().optional().describe("Case-insensitive substring match; omit for all ideas") },
  async ({ topic }) => json(await api.getThreadState(topic as string | undefined)),
);

tool(
  "get_open_loops",
  "List unresolved open loops, optionally filtered to a topic.",
  { topic: z.string().optional() },
  async ({ topic }) => json(await api.getOpenLoops(topic as string | undefined)),
);

tool(
  "get_recent_changes",
  "List evolution steps within a recent window (default 14 days).",
  { sinceDays: z.number().int().positive().optional() },
  async ({ sinceDays }) => json(await api.getRecentChanges(sinceDays as number | undefined)),
);

tool(
  "continue_thinking",
  "Summarize where the user's thinking on a topic currently stands and suggest a next step.",
  { topic: z.string() },
  async ({ topic }) => {
    const { text, packet } = await api.continueThinking(topic as string);
    // The HTTP endpoint leaves the "Continue from here" token in place for the Mac app's local
    // editing; a prose consumer wants it filled with the suggested line.
    return { content: [{ type: "text" as const, text: resolveContinueToken(text, packet.suggestedNext) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
