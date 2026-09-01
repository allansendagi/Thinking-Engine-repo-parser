import type { CanonicalEvent, Role } from "../types";

/**
 * Raw Claude.ai export shapes (conversations.json). UNVERIFIED against a real export -- built
 * from general knowledge of Claude's export format, not a live download, the same honesty
 * boundary as the browser extension's DOM adapters. Structurally simpler than ChatGPT's parser
 * for a real reason, not a shortcut: to my knowledge, Claude's export stores each conversation as
 * a flat, already-resolved message list (`chat_messages`), not a branching tree with a
 * `current_node` pointer -- so there's no equivalent of the ChatGPT parser's branch-resolution
 * problem here. If a real export turns out to carry edit/regenerate branches after all, that
 * assumption is wrong and this needs the same tree-walk treatment chatgpt.ts has. Verify against
 * a real export before trusting this on anything that matters.
 */
interface RawContentBlock {
  type: string;
  text?: string;
}

interface RawClaudeMessage {
  uuid?: string;
  sender: "human" | "assistant" | string;
  text?: string;
  content?: RawContentBlock[];
  created_at?: string;
}

interface RawClaudeConversation {
  uuid?: string;
  id?: string;
  name?: string;
  chat_messages?: RawClaudeMessage[];
  messages?: RawClaudeMessage[]; // seen in some export variants
}

function extractText(message: RawClaudeMessage): string {
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

function toRole(sender: string): Role | null {
  if (sender === "human") return "user";
  if (sender === "assistant") return "assistant";
  return null;
}

export function parseClaudeExport(raw: unknown): CanonicalEvent[] {
  if (!Array.isArray(raw)) {
    throw new Error("Expected conversations.json to be an array of conversations");
  }

  const events: CanonicalEvent[] = [];

  for (const conversation of raw as RawClaudeConversation[]) {
    const conversationId = conversation.uuid ?? conversation.id ?? conversation.name ?? "unknown";
    const messages = conversation.chat_messages ?? conversation.messages ?? [];

    let index = 0;
    let lastKnownTime = new Date(0).toISOString();

    for (const message of messages) {
      const role = toRole(message.sender);
      if (!role) continue;

      const text = extractText(message);
      if (text.length === 0) continue;

      const createdAt = message.created_at ?? lastKnownTime;
      lastKnownTime = createdAt;

      events.push({
        id: message.uuid ?? `${conversationId}::${index}`,
        conversationId: String(conversationId),
        source: "claude",
        role,
        text,
        createdAt,
        index: index++,
      });
    }
  }

  return events;
}
