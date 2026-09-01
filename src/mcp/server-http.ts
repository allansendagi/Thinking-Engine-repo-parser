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

const creds = await resolveCredentials();
const api = makeClient(creds);
console.error(`[Thread MCP] connected as ${creds.userId} -> ${creds.apiBaseUrl}`);

const server = new McpServer({ name: "thread-thinking-engine", version: "0.2.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

server.tool(
  "search_ideas",
  "Search the user's ideas by keyword. Returns idea summaries ranked by relevance.",
  { query: z.string().describe("Search terms") },
  async ({ query }) => json(await api.searchIdeas(query)),
);

server.tool(
  "get_idea",
  "Fetch one idea by id, including its full evolution, open loops, decisions, and related ideas.",
  { id: z.string() },
  async ({ id }) => json(await api.getIdea(id)),
);

server.tool(
  "trace_idea",
  "Fetch one idea's evolution alongside the original source text each step is grounded in.",
  { id: z.string() },
  async ({ id }) => json(await api.traceIdea(id)),
);

server.tool(
  "get_thread_state",
  "Reconstruct the Thinking State for a topic: current ideas, recent changes, decisions, open loops, contradictions, related ideas.",
  { topic: z.string().optional().describe("Case-insensitive substring match; omit for all ideas") },
  async ({ topic }) => json(await api.getThreadState(topic)),
);

server.tool(
  "get_open_loops",
  "List unresolved open loops, optionally filtered to a topic.",
  { topic: z.string().optional() },
  async ({ topic }) => json(await api.getOpenLoops(topic)),
);

server.tool(
  "get_recent_changes",
  "List evolution steps within a recent window (default 14 days).",
  { sinceDays: z.number().int().positive().optional() },
  async ({ sinceDays }) => json(await api.getRecentChanges(sinceDays)),
);

server.tool(
  "continue_thinking",
  "Summarize where the user's thinking on a topic currently stands and suggest a next step.",
  { topic: z.string() },
  async ({ topic }) => {
    const { text } = await api.continueThinking(topic);
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
