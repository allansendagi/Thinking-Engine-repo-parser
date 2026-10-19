import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { ingestConversation } from "../api/ingest";
import { importIntoDb } from "../import/run";
import { FakeProvider } from "../providers/fake";
import type { CompletionProvider } from "../providers/types";
import { backlogPaused, deferredStatus, drainDeferredExtraction, retryDeferredExtraction } from "./deferred";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An AI provider that's down the way an unpaid account is: every call refused. */
const unpaid: CompletionProvider = {
  async complete() {
    throw Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 });
  },
};

const extraction = (sourceId: string, statement: string, quote: string) =>
  JSON.stringify({
    events: [{ type: "new_idea", statement, title: statement.split(" ").slice(0, 3).join(" "), confidence: 0.9, persistence: "high", source_event_id: sourceId, evidence_quote: quote }],
  });
const newIdea = JSON.stringify({ matched_idea_id: null, confidence: 0.2, reasoning: "unrelated", also_related_idea_id: null });

const capture = (conversationId: string, id: string, text: string) => ({
  conversationId,
  source: "claude" as const,
  messages: [{ id, role: "user" as const, text, createdAt: "2026-10-06T09:00:00.000Z" }],
});

describe("captures survive an unavailable AI", () => {
  test("the conversation is stored, the reason recorded, and nothing throws", async () => {
    const db = openDb(":memory:");
    const r = await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), {
      extraction: unpaid,
      reasoning: unpaid,
    });
    expect(r.newCanonicalEvents).toBe(1);
    expect(r.extractionPending).toBe(1);
    expect(r.extractionError).toContain("credit balance is too low");
    expect(loadCanonicalEvents(db).map((e) => e.id)).toEqual(["m1"]);
    expect(deferredStatus(db)).toMatchObject({ count: 1 });
  });

  test("once the AI is back, waiting captures become ideas -- oldest first, nothing re-sent", async () => {
    const db = openDb(":memory:");
    await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    // The client re-sending the same message changes nothing (already stored, still waiting).
    const again = await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    expect(again.newCanonicalEvents).toBe(0);
    expect(deferredStatus(db).count).toBe(1);

    const r = await retryDeferredExtraction(db, {
      extraction: new FakeProvider([extraction("m1", "Charge per seat rather than a flat fee.", "charge per seat")]),
      reasoning: new FakeProvider([newIdea]),
    });
    expect(r).toEqual({ processed: 1, error: null });
    expect(deferredStatus(db).count).toBe(0);
    expect(loadIdeas(db)).toHaveLength(1);
  });

  test("a new capture first clears the backlog, so ideas build in the order thinking happened", async () => {
    const db = openDb(":memory:");
    await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    const r = await ingestConversation(db, capture("c2", "m2", "Annual plans only for teams."), {
      extraction: new FakeProvider([
        extraction("m1", "Charge per seat rather than a flat fee.", "charge per seat"),
        extraction("m2", "Annual plans only for teams.", "Annual plans only"),
      ]),
      reasoning: new FakeProvider([newIdea, newIdea, newIdea]),
    });
    expect(r.extractionError ?? null).toBeNull();
    expect(r.extractionPending ?? 0).toBe(0);
    expect(deferredStatus(db).count).toBe(0);
    expect(loadIdeas(db)).toHaveLength(2);
  });

  test("history import is stored even when the AI is down", async () => {
    const db = openDb(":memory:");
    const events = [
      { id: "h1", conversationId: "imp1", source: "chatgpt" as const, role: "user" as const, text: "Let's make the newsletter biweekly.", createdAt: "2026-09-01T10:00:00.000Z", index: 0 },
    ];
    const s = await importIntoDb(db, events, { extraction: unpaid, reasoning: unpaid });
    expect(s.newCanonicalEvents).toBe(1);
    expect(s.extractionPending).toBe(1);
    expect(loadCanonicalEvents(db)).toHaveLength(1);
  });
});

describe("a big backlog drains in one pass", () => {
  test("a 30-conversation history import becomes 30 ideas in a single drain, oldest first", async () => {
    const db = openDb(":memory:");
    const topics = ["pricing tiers", "newsletter cadence", "security audit", "hiring plan", "book outline", "onboarding flow", "refund policy", "podcast guests", "tax filing", "garden layout", "kitchen remodel", "marathon training", "chess openings", "visa renewal", "sourdough starter", "solar panels", "piano practice", "tenant dispute", "wedding toast", "api versioning", "cold outreach", "meal prep", "board deck", "logo redesign", "patent filing", "travel itinerary", "budget review", "mentor intro", "code freeze", "sleep schedule"];
    for (let i = 0; i < 30; i++) {
      await ingestConversation(
        db,
        capture(`c${i}`, `m${i}`, `${topics[i]} needs a decision`),
        { extraction: unpaid, reasoning: unpaid },
      );
    }
    expect(deferredStatus(db).count).toBe(30);
    let calls = 0;
    const extractor: CompletionProvider = {
      async complete(_s, user) {
        calls++;
        const m = [...user.matchAll(/\[NEW\] \[([^\]]+)\] \(user, [^)]*\): (.+)/g)];
        return JSON.stringify({
          events: m.map(([, id, text]) => ({
            type: "new_idea",
            statement: text!.trim(),
            title: text!.trim().replace(/ needs a decision$/, ""),
            confidence: 0.9,
            persistence: "high",
            source_event_id: id,
            evidence_quote: text!.trim().slice(0, 20),
          })),
        });
      },
    };
    const reasoner: CompletionProvider = {
      async complete() {
        return JSON.stringify({ matched_idea_id: null, confidence: 0.1, reasoning: "unrelated", also_related_idea_id: null });
      },
    };
    const r = await drainDeferredExtraction(db, { extraction: extractor, reasoning: reasoner });
    expect(r).toEqual({ processed: 30, error: null, remaining: 0 });
    expect(loadIdeas(db)).toHaveLength(30);
    expect(calls).toBe(30); // one extraction call per conversation, none repeated
  });

  test("it stops at once when the AI is still unavailable, without burning the backlog", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 6; i++) await ingestConversation(db, capture(`d${i}`, `n${i}`, `Another thought ${i} entirely.`), { extraction: unpaid, reasoning: unpaid });
    const r = await drainDeferredExtraction(db, { extraction: unpaid, reasoning: unpaid });
    expect(r.processed).toBe(0);
    expect(r.error).toContain("credit balance");
    expect(r.remaining).toBe(6);
  });
});

describe("backlog pause", () => {
  const prev = process.env.THREAD_PAUSE_BACKLOG_USERS;
  const restore = () => {
    if (prev === undefined) delete process.env.THREAD_PAUSE_BACKLOG_USERS;
    else process.env.THREAD_PAUSE_BACKLOG_USERS = prev;
  };

  test("a paused account keeps its queue untouched while a live capture still extracts", async () => {
    // A real file named like a per-user database, so the pause can match the account id.
    const dir = mkdtempSync(join(tmpdir(), "pause-"));
    const db = openDb(join(dir, "user_aaaaaaaaaaaaaaaaaaaaaaaa.db"));
    try {
      await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
      expect(deferredStatus(db).count).toBe(1);

      process.env.THREAD_PAUSE_BACKLOG_USERS = "user_aaaaaaaaaaaaaaaaaaaaaaaa";
      const r = await ingestConversation(db, capture("c2", "m2", "Annual plans only for teams."), {
        extraction: new FakeProvider([extraction("m2", "Annual plans only for teams.", "Annual plans only")]),
        reasoning: new FakeProvider([newIdea]),
      });
      expect(r.extractionError ?? null).toBeNull();
      expect(loadIdeas(db)).toHaveLength(1); // the live capture became an idea...
      expect(deferredStatus(db).count).toBe(1); // ...and the old one is still waiting, unprocessed
    } finally {
      restore();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("another account is not paused, and `*` pauses everyone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pause-"));
    const db = openDb(join(dir, "user_bbbbbbbbbbbbbbbbbbbbbbbb.db"));
    try {
      process.env.THREAD_PAUSE_BACKLOG_USERS = "user_aaaaaaaaaaaaaaaaaaaaaaaa";
      expect(backlogPaused(db)).toBe(false);
      process.env.THREAD_PAUSE_BACKLOG_USERS = "*";
      expect(backlogPaused(db)).toBe(true);
      delete process.env.THREAD_PAUSE_BACKLOG_USERS;
      expect(backlogPaused(db)).toBe(false);
    } finally {
      restore();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("coding-assistant sessions wait for quiet", () => {
  // A live session: its newest message was just written.
  const agentCapture = (conversationId: string, id: string, text: string, createdAt = new Date().toISOString()) => {
    const c = capture(conversationId, id, text);
    return { ...c, source: "claude_code" as const, messages: c.messages.map((m) => ({ ...m, createdAt })) };
  };
  const countingProvider = () => {
    let n = 0;
    return { calls: () => n, provider: { async complete() { n++; return extraction("m1", "Charge per seat rather than a flat fee.", "charge per seat"); } } as CompletionProvider };
  };
  const prev = process.env.THREAD_AGENT_QUIET_MINUTES;
  const restore = () => { if (prev === undefined) delete process.env.THREAD_AGENT_QUIET_MINUTES; else process.env.THREAD_AGENT_QUIET_MINUTES = prev; };

  test("an active session is stored and queued without spending a model call", async () => {
    delete process.env.THREAD_AGENT_QUIET_MINUTES;
    const db = openDb(":memory:");
    const c = countingProvider();
    const r = await ingestConversation(db, agentCapture("s1", "m1", "We should charge per seat, not a flat fee."), { extraction: c.provider, reasoning: new FakeProvider([newIdea]) });
    expect(c.calls()).toBe(0);
    expect(r.extractionPending).toBe(1);
    expect(r.extractionError ?? null).toBeNull();
    expect(loadIdeas(db)).toHaveLength(0);
    expect(deferredStatus(db).count).toBe(1);
  });

  test("it is processed, once, after the quiet period -- and not before", async () => {
    delete process.env.THREAD_AGENT_QUIET_MINUTES;
    const db = openDb(":memory:");
    const c = countingProvider();
    const providers = { extraction: c.provider, reasoning: new FakeProvider([newIdea]) };
    await ingestConversation(db, agentCapture("s1", "m1", "We should charge per seat, not a flat fee."), providers);
    const early = await retryDeferredExtraction(db, providers, 10, Date.now() + 60_000);
    expect(early).toMatchObject({ processed: 0, waiting: 1 });
    expect(c.calls()).toBe(0);
    const later = await retryDeferredExtraction(db, providers, 10, Date.now() + 11 * 60_000);
    expect(later.processed).toBe(1);
    expect(c.calls()).toBe(1);
    expect(loadIdeas(db)).toHaveLength(1);
  });

  test("a session that is already quiet (history read later) is processed right away", async () => {
    delete process.env.THREAD_AGENT_QUIET_MINUTES;
    const db = openDb(":memory:");
    const c = countingProvider();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await ingestConversation(db, agentCapture("s1", "m1", "We should charge per seat, not a flat fee.", old), { extraction: c.provider, reasoning: new FakeProvider([newIdea]) });
    expect(c.calls()).toBe(1);
    expect(loadIdeas(db)).toHaveLength(1);
  });

  test("the drain loop stops when only active sessions are left (it does not spin)", async () => {
    delete process.env.THREAD_AGENT_QUIET_MINUTES;
    const db = openDb(":memory:");
    const c = countingProvider();
    const providers = { extraction: c.provider, reasoning: new FakeProvider([newIdea]) };
    await ingestConversation(db, agentCapture("s1", "m1", "We should charge per seat, not a flat fee."), providers);
    let ticks = 0;
    const r = await drainDeferredExtraction(db, providers, 240_000, 5, () => { ticks++; return Date.now() + ticks; });
    expect(r.processed).toBe(0);
    expect(r.remaining).toBe(1);
    expect(ticks).toBeLessThan(6); // a spinning loop would tick until the 4-minute budget ran out
  });

  test("browser chats are unaffected, and THREAD_AGENT_QUIET_MINUTES=0 turns the wait off", async () => {
    const db = openDb(":memory:");
    const c = countingProvider();
    await ingestConversation(db, capture("b1", "m1", "We should charge per seat, not a flat fee."), { extraction: c.provider, reasoning: new FakeProvider([newIdea]) });
    expect(c.calls()).toBe(1); // source "claude" (browser): immediate

    process.env.THREAD_AGENT_QUIET_MINUTES = "0";
    try {
      const db2 = openDb(":memory:");
      const c2 = countingProvider();
      await ingestConversation(db2, agentCapture("s2", "m1", "We should charge per seat, not a flat fee."), { extraction: c2.provider, reasoning: new FakeProvider([newIdea]) });
      expect(c2.calls()).toBe(1);
    } finally {
      restore();
    }
  });
});
