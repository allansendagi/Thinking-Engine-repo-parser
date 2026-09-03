#!/usr/bin/env bun
/**
 * Thin MCP protocol wiring over src/mcp/tools.ts. This file has NOT been exercised against a
 * real MCP client in this environment -- the tool logic itself is unit-tested directly against
 * bun:sqlite (see mcp/tools.test.ts); this file is where an SDK API mismatch would surface, and
 * it hasn't been run to find out. Verify with an actual MCP client (e.g. Claude Desktop, the MCP
 * inspector) before relying on it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "../db/client";
import { createReasoningProvider } from "../providers/anthropic";
import {
  continueThinking,
  getIdea,
  getOpenLoops,
  getRecentChanges,
  getThreadState,
  searchIdeas,
  traceIdea,
} from "./tools";

const DB_PATH = process.env.THREAD_DB_PATH ?? "data/thread.db";
const db = openDb(DB_PATH);

const server = new McpServer({ name: "thread-thinking-engine", version: "0.1.0" });

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * `McpServer.tool()` is generic over the zod shape and infers a conditional type deep enough
 * that, on a case-sensitive FS with CI's module-resolution order, `tsc` reports TS2589
 * ("excessively deep") for every call site -- green on macOS, red on Linux. Calling it via a
 * structural `{ tool: (...) => void }` cast never touches the generic overload, so the inference
 * doesn't happen. Runtime is unchanged (zod still validates every call); handlers annotate the
 * fields they read.
 */
const registrar = server as unknown as { tool: (name: string, description: string, schema: z.ZodRawShape, handler: (args: any) => Promise<ToolResult>) => void };
const tool = registrar.tool.bind(registrar);

tool(
  "search_ideas",
  "Search the user's ideas by keyword. Returns idea summaries ranked by lexical relevance.",
  { query: z.string().describe("Search terms"), limit: z.number().int().positive().max(50).optional() },
  async ({ query, limit }: { query: string; limit?: number }) => json(searchIdeas(db, query, limit)),
);

tool(
  "get_idea",
  "Fetch one idea by id, including its full evolution, open loops, decisions, and related ideas.",
  { id: z.string() },
  async ({ id }: { id: string }) => json(getIdea(db, id)),
);

tool(
  "trace_idea",
  "Fetch one idea's evolution alongside the original source text each step is grounded in.",
  { id: z.string() },
  async ({ id }: { id: string }) => json(traceIdea(db, id)),
);

tool(
  "get_thread_state",
  "Reconstruct the Thinking State for a topic: current ideas, recent changes, decisions, open loops, contradictions, related ideas.",
  { topic: z.string().optional().describe("Case-insensitive substring match; omit for all ideas") },
  async ({ topic }: { topic?: string }) => json(getThreadState(db, topic)),
);

tool(
  "get_open_loops",
  "List unresolved open loops, optionally filtered to a topic.",
  { topic: z.string().optional() },
  async ({ topic }: { topic?: string }) => json(getOpenLoops(db, topic)),
);

tool(
  "get_recent_changes",
  "List evolution steps within a recent window (default 14 days).",
  { sinceDays: z.number().int().positive().optional() },
  async ({ sinceDays }: { sinceDays?: number }) => json(getRecentChanges(db, sinceDays)),
);

tool(
  "continue_thinking",
  "Summarize where the user's thinking on a topic currently stands and suggest a next step. Requires a configured reasoning provider.",
  { topic: z.string() },
  async ({ topic }: { topic: string }) => {
    const text = await continueThinking(db, topic, createReasoningProvider());
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
