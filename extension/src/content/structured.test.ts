import { describe, expect, test } from "bun:test";
import { chatgptMessages, chatgptReader, claudeMessages, claudeReader, slimChatgptConversation, slimClaudeConversation } from "./structured";

const gptConv = {
  conversation_id: "c1",
  title: "Pricing",
  current_node: "a2",
  mapping: {
    root: { id: "root", parent: null, children: ["sys"], message: null },
    sys: { id: "sys", parent: "root", children: ["ci"], message: { id: "sys", author: { role: "system" }, content: { content_type: "text", parts: [""] }, create_time: 1 } },
    ci: { id: "ci", parent: "sys", children: ["u1"], message: { id: "ci", author: { role: "user" }, content: { content_type: "text", parts: ["MY CUSTOM INSTRUCTIONS"] }, create_time: 1, metadata: { is_visually_hidden_from_conversation: true } } },
    u1: { id: "u1", parent: "ci", children: ["a1", "a2"], message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["Should we charge per seat?"] }, create_time: 2 } },
    a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["(regenerated away)"] }, create_time: 3 } },
    a2: { id: "a2", parent: "u1", children: [], message: { id: "a2", author: { role: "assistant" }, content: { content_type: "text", parts: ["Per seat fits teams."] }, create_time: 4 } },
  },
};

describe("ChatGPT structured data", () => {
  test("keeps only the visible kept path", () => {
    expect(chatgptMessages(gptConv)).toEqual([
      { role: "user", text: "Should we charge per seat?" },
      { role: "assistant", text: "Per seat fits teams." },
    ]);
  });

  test("slim export drops hidden custom instructions and abandoned branches", () => {
    const slim = slimChatgptConversation(gptConv, "c1") as { mapping: Record<string, unknown>; current_node: string };
    const json = JSON.stringify(slim);
    expect(json).not.toContain("CUSTOM INSTRUCTIONS");
    expect(json).not.toContain("regenerated away");
    expect(Object.keys(slim.mapping)).toEqual(["u1", "a2"]);
    expect(slim.current_node).toBe("a2");
  });

  test("reader authenticates once and pages the list", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/api/auth/session")) return Response.json({ accessToken: "tok" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      if (url.includes("/backend-api/conversations?offset=0")) {
        return Response.json({ items: [{ id: "c1", update_time: "2026-01-01T00:00:00Z" }], total: 1 });
      }
      return Response.json(gptConv);
    };
    const reader = chatgptReader(fetcher, "https://chatgpt.com");
    expect(await reader.listPage(0)).toEqual({ items: [{ id: "c1", updatedAt: "2026-01-01T00:00:00.000Z" }], done: true });
    expect((await reader.fetchMessages("c1")).length).toBe(2);
    expect(calls.filter((c) => c.endsWith("/api/auth/session"))).toHaveLength(1);
  });
});

const claudeConv = {
  uuid: "k1",
  name: "Authority",
  chat_messages: [
    { uuid: "m2", index: 1, sender: "assistant", content: [{ type: "text", text: "It must be verifiable." }] },
    { uuid: "m1", index: 0, sender: "human", text: "Authority needs boundaries." },
    { uuid: "m3", index: 2, sender: "human", content: [{ type: "tool_use" }] },
  ],
};

describe("Claude structured data", () => {
  test("orders by index and keeps text turns only", () => {
    expect(claudeMessages(claudeConv)).toEqual([
      { role: "user", text: "Authority needs boundaries." },
      { role: "assistant", text: "It must be verifiable." },
    ]);
  });

  test("slim export keeps the export shape the backend parser reads", () => {
    const slim = slimClaudeConversation(claudeConv, "k1") as { uuid: string; chat_messages: { sender: string; text: string }[] };
    expect(slim.uuid).toBe("k1");
    expect(slim.chat_messages.map((m) => m.sender)).toEqual(["human", "assistant"]);
  });

  test("reader picks the chat org and treats an unpaged full list as done", async () => {
    const fetcher = async (url: string) => {
      if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "api-only", capabilities: ["api"] }, { uuid: "org1", capabilities: ["chat"] }]);
      expect(url).toContain("/organizations/org1/");
      return Response.json(Array.from({ length: 80 }, (_, i) => ({ uuid: `k${i}`, updated_at: "2026-01-01T00:00:00Z" })));
    };
    const page = await claudeReader(fetcher, "https://claude.ai").listPage(0);
    expect(page.items).toHaveLength(80);
    expect(page.done).toBe(true);
  });
});
