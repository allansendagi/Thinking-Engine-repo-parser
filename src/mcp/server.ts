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

server.tool(
  "search_ideas",
  "Search the user's ideas by keyword. Returns idea summaries ranked by lexical relevance.",
  { query: z.string().describe("Search terms"), limit: z.number().int().positive().max(50).optional() },
  async ({ query, limit }) => json(searchIdeas(db, query, limit)),
);

server.tool(
  "get_idea",
  "Fetch one idea by id, including its full evolution, open loops, decisions, and related ideas.",
  { id: z.string() },
  async ({ id }) => json(getIdea(db, id)),
);

server.tool(
  "trace_idea",
  "Fetch one idea's evolution alongside the original source text each step is grounded in.",
  { id: z.string() },
  async ({ id }) => json(traceIdea(db, id)),
);

server.tool(
  "get_thread_state",
  "Reconstruct the Thinking State for a topic: current ideas, recent changes, decisions, open loops, contradictions, related ideas.",
  { topic: z.string().optional().describe("Case-insensitive substring match; omit for all ideas") },
  async ({ topic }) => json(getThreadState(db, topic)),
);

server.tool(
  "get_open_loops",
  "List unresolved open loops, optionally filtered to a topic.",
  { topic: z.string().optional() },
  async ({ topic }) => json(getOpenLoops(db, topic)),
);

server.tool(
  "get_recent_changes",
  "List evolution steps within a recent window (default 14 days).",
  { sinceDays: z.number().int().positive().optional() },
  async ({ sinceDays }) => json(getRecentChanges(db, sinceDays)),
);

server.tool(
  "continue_thinking",
  "Summarize where the user's thinking on a topic currently stands and suggest a next step. Requires a configured reasoning provider.",
  { topic: z.string() },
  async ({ topic }) => {
    const text = await continueThinking(db, topic, createReasoningProvider());
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
