import { describe, expect, test } from "bun:test";
import { runHistorySync } from "./historySync";
import { chatgptReader, claudeReader } from "./structured";

/**
 * The privacy claims about what leaves the browser, as tests. History import signs in to the AI
 * site with the person's own logged-in session; none of that may ride along to Thread. These
 * run the real readers and the real sync loop against a recording fetch and check three things:
 *  1. the site's session token is only ever sent to the site itself;
 *  2. nothing handed on for upload contains the token, a header, or a cookie;
 *  3. hidden content the person never wrote in the chat (custom instructions) doesn't leave.
 */

const TOKEN = "eyJ-SESSION-TOKEN-MUST-NEVER-LEAVE-9f31";
const GPT_ORIGIN = "https://chatgpt.com";

const gptConversation = {
  conversation_id: "c1",
  title: "Pricing",
  current_node: "a1",
  mapping: {
    root: { id: "root", parent: null, children: ["ci"], message: null },
    ci: { id: "ci", parent: "root", children: ["u1"], message: { id: "ci", author: { role: "user" }, content: { content_type: "text", parts: ["HIDDEN CUSTOM INSTRUCTIONS about my family"] }, create_time: 1, metadata: { is_visually_hidden_from_conversation: true } } },
    u1: { id: "u1", parent: "ci", children: ["a1"], message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["Should we charge per seat?"] }, create_time: 2 } },
    a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["Per seat fits teams."] }, create_time: 3 } },
  },
};

describe("history import never moves the site's session off the site", () => {
  test("ChatGPT: the token goes only to chatgpt.com, and nothing uploaded contains it", async () => {
    const requests: { url: string; headers: Headers; credentials?: RequestCredentials }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers), credentials: init?.credentials });
      if (url.endsWith("/api/auth/session")) return Response.json({ accessToken: TOKEN });
      if (url.includes("/backend-api/conversations?")) return Response.json({ items: [{ id: "c1", update_time: 1_725_000_000 }], total: 1 });
      return Response.json(gptConversation);
    };
    const uploads: unknown[][] = [];
    await runHistorySync({
      reader: chatgptReader(fetcher, GPT_ORIGIN),
      synced: {},
      delayMs: 0,
      sendBatch: async (b) => {
        uploads.push(b);
        return {};
      },
      markSynced: async () => {},
    });

    // 1. Every request that carried the token went to the site itself.
    const withToken = requests.filter((r) => (r.headers.get("authorization") ?? "").includes(TOKEN));
    expect(withToken.length).toBeGreaterThan(0);
    for (const r of withToken) expect(new URL(r.url).origin).toBe(GPT_ORIGIN);
    // And nothing at all went anywhere but the site.
    for (const r of requests) expect(new URL(r.url).origin).toBe(GPT_ORIGIN);

    // 2. What's handed on for upload has no token, header or cookie in it.
    const payload = JSON.stringify(uploads);
    expect(payload).not.toContain(TOKEN);
    expect(payload).not.toMatch(/authorization|bearer|cookie|accessToken/i);
    expect(payload).toContain("Should we charge per seat?");

    // 3. Instructions the person set up once and never typed in this chat stay home.
    expect(payload).not.toContain("HIDDEN CUSTOM INSTRUCTIONS");
  });

  test("Claude: only the site is contacted, and nothing uploaded carries session material", async () => {
    const requests: string[] = [];
    const fetcher = async (url: string) => {
      requests.push(url);
      if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "org-1", capabilities: ["chat"] }]);
      if (url.includes("/chat_conversations?")) return Response.json([{ uuid: "k1", updated_at: "2026-10-01T10:00:00Z" }]);
      return Response.json({
        uuid: "k1",
        name: "Plan",
        chat_messages: [
          { uuid: "m1", sender: "human", text: "Ship the import first.", created_at: "2026-10-01T10:00:00Z", index: 0 },
          { uuid: "m2", sender: "assistant", text: "Agreed.", created_at: "2026-10-01T10:00:05Z", index: 1 },
        ],
      });
    };
    const uploads: unknown[][] = [];
    await runHistorySync({
      reader: claudeReader(fetcher, "https://claude.ai"),
      synced: {},
      delayMs: 0,
      sendBatch: async (b) => {
        uploads.push(b);
        return {};
      },
      markSynced: async () => {},
    });
    for (const u of requests) expect(new URL(u).origin).toBe("https://claude.ai");
    const payload = JSON.stringify(uploads);
    expect(payload).not.toMatch(/authorization|bearer|cookie|sessionKey|org-1/i);
    expect(payload).toContain("Ship the import first.");
  });
});
