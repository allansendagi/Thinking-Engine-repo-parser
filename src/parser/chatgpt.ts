import type { CanonicalEvent, Role } from "../types";

/**
 * Raw ChatGPT export shapes (conversations.json). Only the fields the parser needs are typed --
 * the real export carries many more we don't use.
 */
interface RawMessageAuthor {
  role: "user" | "assistant" | "system" | "tool";
}

interface RawMessageContent {
  content_type: string;
  parts?: unknown[];
}

interface RawMessage {
  id: string;
  author: RawMessageAuthor;
  content: RawMessageContent;
  create_time: number | null;
}

interface RawNode {
  id: string;
  message: RawMessage | null;
  parent: string | null;
  children: string[];
}

interface RawConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  mapping: Record<string, RawNode>;
  current_node: string;
}

/**
 * ChatGPT's export stores every conversation as a tree, not a list: regenerated responses and
 * edited messages create sibling branches off the same parent. Only the path ending at
 * `current_node` is the conversation the user actually kept -- every other branch is an
 * abandoned regeneration. Flattening by timestamp instead of walking this path would feed
 * abandoned branches into extraction as if the user had actually said them, and those
 * near-duplicate abandoned turns are indistinguishable from genuine idea-forks downstream.
 * This function's only job is to make that mistake impossible.
 */
function resolveKeptPath(conversation: RawConversation): RawNode[] {
  const { mapping, current_node: currentNode } = conversation;
  const path: RawNode[] = [];
  let cursor: string | null = currentNode;
  const seen = new Set<string>();

  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new Error(`Cycle detected in conversation mapping at node ${cursor}`);
    }
    seen.add(cursor);

    const node: RawNode | undefined = mapping[cursor];
    if (!node) {
      throw new Error(`current_node path references missing node ${cursor}`);
    }
    path.push(node);
    cursor = node.parent;
  }

  path.reverse();
  return path;
}

function extractText(message: RawMessage): string {
  if (message.content.content_type !== "text") return "";
  const parts = message.content.parts ?? [];
  return parts
    .filter((p): p is string => typeof p === "string")
    .join("\n")
    .trim();
}

function toIso(epochSeconds: number | null, fallback: string): string {
  if (epochSeconds === null) return fallback;
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Parses a full conversations.json export (an array of conversations) into CanonicalEvents,
 * resolving each conversation's kept branch and dropping system/tool turns and empty messages.
 */
export function parseChatGptExport(raw: unknown): CanonicalEvent[] {
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to be an array of conversations");
  }

  const events: CanonicalEvent[] = [];

  for (const conversation of raw as RawConversation[]) {
    const conversationId = conversation.conversation_id ?? conversation.id ?? conversation.title ?? "unknown";
    const path = resolveKeptPath(conversation);

    let index = 0;
    let lastKnownTime = new Date(0).toISOString();

    for (const node of path) {
      const message = node.message;
      if (!message) continue;
      if (message.author.role !== "user" && message.author.role !== "assistant") continue;

      const text = extractText(message);
      if (text.length === 0) continue;

      const createdAt = toIso(message.create_time, lastKnownTime);
      lastKnownTime = createdAt;

      events.push({
        id: message.id,
        conversationId: String(conversationId),
        source: "chatgpt",
        role: message.author.role as Role,
        text,
        createdAt,
        index: index++,
      });
    }
  }

  return events;
}
