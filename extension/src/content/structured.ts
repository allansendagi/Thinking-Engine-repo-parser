import type { RawMessage } from "./common/siteAdapter";

/**
 * Structured access to the conversations the user is already signed in to -- the same JSON the
 * ChatGPT and Claude web apps load to render themselves, fetched same-origin from the content
 * script with the user's own session. Two uses:
 *
 *  1. History sync: bring in every past conversation in minutes, with no data-export email to
 *     wait hours for (see historySync.ts).
 *  2. Capture fallback: when a site redesign breaks the DOM selectors, capture keeps working from
 *     this structured copy (see capture.ts).
 *
 * These are the sites' own internal endpoints, not public APIs, so they can change too -- but far
 * less often than the markup, and every failure here degrades to the DOM path, never breaks it.
 *
 * Payloads are rebuilt in the shape of each provider's official data export, which the backend's
 * `/v1/import` parsers already understand -- and slimmed to just the kept conversation path, so a
 * batch stays small and no hidden system / custom-instruction text is ever sent.
 */

export type HistoryFormat = "chatgpt" | "claude";

export interface ConversationRef {
  id: string;
  updatedAt: string;
}

export interface HistoryReader {
  format: HistoryFormat;
  /** One page of the user's conversations, most recently updated first. */
  listPage(page: number): Promise<{ items: ConversationRef[]; done: boolean }>;
  /** One conversation, export-shaped and slimmed, ready for `/v1/import`. */
  fetchForImport(id: string): Promise<unknown>;
  /** One conversation's visible turns, in order -- the capture fallback. */
  fetchMessages(id: string): Promise<RawMessage[]>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One reader per page, created on first use (it caches the session token / org id). */
export function lazyReader(make: () => HistoryReader): () => HistoryReader {
  let reader: HistoryReader | null = null;
  return () => (reader ??= make());
}

async function getJson(fetcher: Fetcher, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(url, { credentials: "include", ...init });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function iso(t: unknown): string {
  if (typeof t === "number") return new Date(t * 1000).toISOString();
  if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return new Date(0).toISOString();
}

// --------------------------------------------------------------------------------------------
// ChatGPT

interface GptNode {
  id: string;
  parent: string | null;
  children?: string[];
  message: {
    id: string;
    author: { role: string };
    content: { content_type: string; parts?: unknown[] };
    create_time: number | null;
    metadata?: { is_visually_hidden_from_conversation?: boolean };
  } | null;
}

interface GptConversation {
  conversation_id?: string;
  id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  current_node: string;
  mapping: Record<string, GptNode>;
}

/** The turns the user actually kept (current_node back to the root), visible user/assistant only. */
function gptKeptPath(conv: GptConversation): GptNode[] {
  const path: GptNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = conv.current_node;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: GptNode | undefined = conv.mapping[cursor];
    if (!node) break;
    path.push(node);
    cursor = node.parent;
  }
  return path.reverse();
}

function gptText(node: GptNode): string | null {
  const m = node.message;
  if (!m || (m.author.role !== "user" && m.author.role !== "assistant")) return null;
  if (m.metadata?.is_visually_hidden_from_conversation) return null;
  const text = (m.content.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
  return text.length > 0 ? text : null;
}

export function chatgptMessages(conv: GptConversation): RawMessage[] {
  const out: RawMessage[] = [];
  for (const node of gptKeptPath(conv)) {
    const text = gptText(node);
    if (text) out.push({ role: node.message!.author.role as "user" | "assistant", text });
  }
  return out;
}

/** Export-shaped, kept path only, visible turns only, text parts only. */
export function slimChatgptConversation(conv: GptConversation, fallbackId: string): unknown {
  const kept = gptKeptPath(conv).filter((n) => gptText(n) !== null);
  const mapping: Record<string, unknown> = {};
  kept.forEach((n, i) => {
    const m = n.message!;
    mapping[n.id] = {
      id: n.id,
      parent: i === 0 ? null : kept[i - 1]!.id,
      children: i === kept.length - 1 ? [] : [kept[i + 1]!.id],
      message: {
        id: m.id,
        author: { role: m.author.role },
        content: { content_type: "text", parts: [gptText(n)] },
        create_time: m.create_time,
      },
    };
  });
  return {
    conversation_id: conv.conversation_id ?? conv.id ?? fallbackId,
    title: conv.title ?? "",
    create_time: conv.create_time ?? null,
    update_time: conv.update_time ?? null,
    current_node: kept.length > 0 ? kept[kept.length - 1]!.id : conv.current_node,
    mapping,
  };
}

export function chatgptReader(fetcher: Fetcher = fetch.bind(globalThis), origin = location.origin): HistoryReader {
  const PAGE = 50;
  let token: string | null = null;
  async function auth(): Promise<HeadersInit> {
    if (!token) {
      const session = (await getJson(fetcher, `${origin}/api/auth/session`)) as { accessToken?: string };
      if (!session.accessToken) throw new Error("Not signed in to ChatGPT");
      token = session.accessToken;
    }
    return { authorization: `Bearer ${token}` };
  }
  async function conversation(id: string): Promise<GptConversation> {
    return (await getJson(fetcher, `${origin}/backend-api/conversation/${encodeURIComponent(id)}`, {
      headers: await auth(),
    })) as GptConversation;
  }
  return {
    format: "chatgpt",
    async listPage(page) {
      const body = (await getJson(
        fetcher,
        `${origin}/backend-api/conversations?offset=${page * PAGE}&limit=${PAGE}&order=updated`,
        { headers: await auth() },
      )) as { items?: { id: string; update_time?: unknown }[]; total?: number };
      const items = (body.items ?? []).map((c) => ({ id: c.id, updatedAt: iso(c.update_time) }));
      const done = items.length < PAGE || (typeof body.total === "number" && (page + 1) * PAGE >= body.total);
      return { items, done };
    },
    async fetchForImport(id) {
      return slimChatgptConversation(await conversation(id), id);
    },
    async fetchMessages(id) {
      return chatgptMessages(await conversation(id));
    },
  };
}

// --------------------------------------------------------------------------------------------
// Claude

interface ClaudeMessage {
  uuid?: string;
  sender: string;
  text?: string;
  content?: { type: string; text?: string }[];
  created_at?: string;
  index?: number;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

function claudeText(m: ClaudeMessage): string {
  const blocks = (m.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  return blocks || (m.text ?? "").trim();
}

function claudeOrdered(conv: ClaudeConversation): ClaudeMessage[] {
  const msgs = [...(conv.chat_messages ?? [])];
  if (msgs.every((m) => typeof m.index === "number")) msgs.sort((a, b) => a.index! - b.index!);
  return msgs.filter((m) => (m.sender === "human" || m.sender === "assistant") && claudeText(m).length > 0);
}

export function claudeMessages(conv: ClaudeConversation): RawMessage[] {
  return claudeOrdered(conv).map((m) => ({ role: m.sender === "human" ? "user" : "assistant", text: claudeText(m) }));
}

export function slimClaudeConversation(conv: ClaudeConversation, fallbackId: string): unknown {
  return {
    uuid: conv.uuid ?? fallbackId,
    name: conv.name ?? "",
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    chat_messages: claudeOrdered(conv).map((m) => ({
      uuid: m.uuid,
      sender: m.sender,
      text: claudeText(m),
      created_at: m.created_at,
    })),
  };
}

export function claudeReader(fetcher: Fetcher = fetch.bind(globalThis), origin = location.origin): HistoryReader {
  const PAGE = 50;
  let org: string | null = null;
  async function orgId(): Promise<string> {
    if (!org) {
      const orgs = (await getJson(fetcher, `${origin}/api/organizations`)) as { uuid: string; capabilities?: string[] }[];
      const chat = orgs.find((o) => o.capabilities?.includes("chat")) ?? orgs[0];
      if (!chat) throw new Error("Not signed in to Claude");
      org = chat.uuid;
    }
    return org;
  }
  async function conversation(id: string): Promise<ClaudeConversation> {
    return (await getJson(
      fetcher,
      `${origin}/api/organizations/${await orgId()}/chat_conversations/${encodeURIComponent(id)}?tree=False&rendering_mode=messages`,
    )) as ClaudeConversation;
  }
  return {
    format: "claude",
    async listPage(page) {
      const list = (await getJson(
        fetcher,
        `${origin}/api/organizations/${await orgId()}/chat_conversations?limit=${PAGE}&offset=${page * PAGE}`,
      )) as { uuid: string; updated_at?: string }[];
      const items = list.map((c) => ({ id: c.uuid, updatedAt: iso(c.updated_at) }));
      // Older deployments ignore limit/offset and return everything at once.
      return { items, done: items.length < PAGE || items.length > PAGE };
    },
    async fetchForImport(id) {
      return slimClaudeConversation(await conversation(id), id);
    },
    async fetchMessages(id) {
      return claudeMessages(await conversation(id));
    },
  };
}
