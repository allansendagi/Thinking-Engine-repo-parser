import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { REPAIR_NAMES, repairMessageTimes, repairProvenance, runDataRepairs } from "../db/repairs";
import { textHash } from "../db/thoughts";
import { FakeProvider } from "../providers/fake";
import { ingestConversation } from "./ingest";

const extraction = (events: object[]) => JSON.stringify({ events });
const at = "2026-08-17T00:00:00.000Z";
const msg = (id: string, text: string) => ({ id, role: "user" as const, text, createdAt: at });
const textOf = (db: ReturnType<typeof openDb>, id: string) =>
  (db.query("SELECT text FROM canonical_events WHERE id = ?").get(id) as { text: string } | null)?.text;

describe("a stored message is fixed: a reused id never changes what it says", () => {
  const first = (db: ReturnType<typeof openDb>) =>
    ingestConversation(
      db,
      { conversationId: "c", source: "fixture", messages: [msg("c::1", "Pricing should be per outcome, not per seat.")] },
      {
        extraction: new FakeProvider([
          extraction([{ type: "new_idea", statement: "Pricing should be per outcome.", confidence: 0.9, source_event_id: "c::1", evidence_quote: "per outcome, not per seat" }]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );

  test("different words under the same id become a new message; the old one and its thought stay", async () => {
    const db = openDb(":memory:");
    await first(db);
    const other = "Can you make the logo bigger?";
    const r = await ingestConversation(
      db,
      { conversationId: "c", source: "fixture", messages: [msg("c::1", other)] },
      { extraction: new FakeProvider([extraction([])]), reasoning: new FakeProvider([]) },
    );
    expect(r.newCanonicalEvents).toBe(1); // the new words are a new message, and get extracted
    expect(textOf(db, "c::1")).toBe("Pricing should be per outcome, not per seat.");
    expect(textOf(db, `c::1~${textHash(other).slice(0, 8)}`)).toBe(other);

    // Re-sending the same thing lands on the same derived id: nothing new.
    const again = await ingestConversation(db, { conversationId: "c", source: "fixture", messages: [msg("c::1", other)] }, {
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    expect(again.newCanonicalEvents).toBe(0);
  });

  test("a person's message that grew is still a new message: its new words get extracted", async () => {
    const db = openDb(":memory:");
    await first(db);
    const grown = "Pricing should be per outcome, not per seat. Small teams overpay otherwise.";
    const r = await ingestConversation(db, { conversationId: "c", source: "fixture", messages: [msg("c::1", grown)] }, {
      extraction: new FakeProvider([extraction([])]),
      reasoning: new FakeProvider([]),
    });
    expect(r.newCanonicalEvents).toBe(1);
    expect(textOf(db, "c::1")).toBe("Pricing should be per outcome, not per seat.");
    expect(textOf(db, `c::1~${textHash(grown).slice(0, 8)}`)).toBe(grown);
  });

  test("an AI reply that only grew (captured mid-stream, then finished) updates in place", async () => {
    const db = openDb(":memory:");
    const reply = (text: string) => ({ id: "c::a", role: "assistant" as const, text, createdAt: at });
    await ingestConversation(db, { conversationId: "c", source: "fixture", messages: [reply("Here are three options:")] }, {
      extraction: new FakeProvider([extraction([])]),
      reasoning: new FakeProvider([]),
    });
    // The finished reply arrives with the person's next turn, as it does from every client.
    await ingestConversation(db, { conversationId: "c", source: "fixture", messages: [reply("Here are three options: A, B and C."), msg("c::2", "Let's go with B.")] }, {
      extraction: new FakeProvider([extraction([])]),
      reasoning: new FakeProvider([]),
    });
    expect(textOf(db, "c::a")).toBe("Here are three options: A, B and C.");
  });
});

describe("repairProvenance", () => {
  function seed() {
    const db = openDb(":memory:");
    const put = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx, status) VALUES (?, 'c', 'fixture', ?, ?, ?, ?, 'committed')");
    put.run("c::0", "user", "Authority must be independently verifiable.", at, 0);
    put.run("c::1", "assistant", "I read the whole exchange carefully.", at, 1); // overwrote the thought's message
    put.run("c::2", "user", "Authority must be independently verifiable.", at, 2); // same words said again later
    const thought = db.prepare("INSERT INTO cognitive_events (id, type, statement, confidence, source_event_id, evidence_quote) VALUES (?, 'new_idea', ?, 0.9, 'c::1', ?)");
    thought.run("t1", "Authority must be independently verifiable.", "independently verifiable");
    thought.run("t2", "Lost words.", "words that survive nowhere");
    db.prepare("INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES ('i1', 'Authority', 'developing', 'x', ?, ?)").run(at, at);
    db.prepare("INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES ('i1', 't1', 'x', ?, 'c::1')").run(at);
    return db;
  }

  test("re-points a thought to the earliest message of the person's that holds its quote; leaves the unrecoverable one", () => {
    const db = seed();
    expect(repairProvenance(db)).toEqual({ repointed: 1, unrecoverable: 1 });
    const src = (id: string) => (db.query("SELECT source_event_id AS s FROM cognitive_events WHERE id = ?").get(id) as { s: string }).s;
    expect(src("t1")).toBe("c::0");
    expect(src("t2")).toBe("c::1"); // nothing to point at: kept as it was, never deleted
    expect((db.query("SELECT source_event_id AS s FROM evolution_steps WHERE cognitive_event_id = 't1'").get() as { s: string }).s).toBe("c::0");
    // Idempotent: a second pass finds nothing left to move.
    expect(repairProvenance(db)).toEqual({ repointed: 0, unrecoverable: 1 });
  });

  test("runDataRepairs runs each repair once per database", () => {
    const db = seed();
    db.exec("DELETE FROM data_repairs"); // openDb already ran it on the empty database
    runDataRepairs(db);
    runDataRepairs(db);
    const rows = db.query("SELECT name, detail FROM data_repairs").all() as { name: string; detail: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual([...REPAIR_NAMES()].sort()); // each exactly once
    expect(JSON.parse(rows.find((r) => r.name === "2026-11-provenance")!.detail)).toEqual({ repointed: 1, unrecoverable: 1 });
  });
});

describe("when a message was said is fixed too", () => {
  const ingest = (db: ReturnType<typeof openDb>, messages: ReturnType<typeof msg>[]) =>
    ingestConversation(db, { conversationId: "c", source: "fixture", messages }, {
      extraction: new FakeProvider([extraction([]), extraction([]), extraction([])]),
      reasoning: new FakeProvider([]),
    });
  const timeOf = (db: ReturnType<typeof openDb>, id: string) =>
    (db.query("SELECT created_at AS t FROM canonical_events WHERE id = ?").get(id) as { t: string }).t;

  test("re-capturing a conversation (a browser re-stamps every message) never re-dates what's stored", async () => {
    const db = openDb(":memory:");
    await ingest(db, [{ ...msg("m1", "First thought."), createdAt: "2026-10-01T09:00:00Z" }]);
    // Opened again a month later: the page is captured whole, every message stamped "now".
    await ingest(db, [
      { ...msg("m1", "First thought."), createdAt: "2026-11-01T09:00:00.000Z" },
      { ...msg("m2", "A new thought."), createdAt: "2026-11-01T09:00:00.000Z" },
    ]);
    expect(timeOf(db, "m1")).toBe("2026-10-01T09:00:00.000Z"); // kept, in one exact format
    expect(timeOf(db, "m2")).toBe("2026-11-01T09:00:00.000Z");
  });

  test("Activity is ordered by when you last wrote, not by an AI reply", async () => {
    const { listConversations } = await import("../db/queries");
    const db = openDb(":memory:");
    await ingestConversation(db, { conversationId: "a", source: "fixture", messages: [
      { id: "a1", role: "user", text: "Mine, recent.", createdAt: "2026-11-01T10:00:00Z" },
    ] }, { extraction: new FakeProvider([extraction([])]), reasoning: new FakeProvider([]) });
    await ingestConversation(db, { conversationId: "b", source: "fixture", messages: [
      { id: "b1", role: "user", text: "Mine, older.", createdAt: "2026-10-01T10:00:00Z" },
      { id: "b2", role: "assistant", text: "A late reply.", createdAt: "2026-11-02T10:00:00Z" },
    ] }, { extraction: new FakeProvider([extraction([])]), reasoning: new FakeProvider([]) });
    expect(listConversations(db).map((c) => c.conversationId)).toEqual(["a", "b"]);
  });

  test("the repair restores each message's first-seen time from the evidence log, never later", () => {
    const db = openDb(":memory:");
    const put = db.prepare("INSERT INTO canonical_events (id, conversation_id, source, role, text, created_at, idx, status) VALUES (?, 'c', 'chatgpt', 'user', ?, ?, ?, 'committed')");
    put.run("m1", "old", "2026-11-01T09:00:00.000Z", 0); // re-dated by a later capture
    put.run("m2", "new", "2026-11-01T09:00:00.000Z", 1);
    const ev = db.prepare("INSERT INTO evidence (id, conversation_id, sensor, observed_at, observed_count, accepted_count, integrity_ok, payload) VALUES (?, 'c', 'browser_extension', ?, 1, 1, 1, ?)");
    ev.run("e1", "2026-10-01T09:00:00.000Z", JSON.stringify({ form: "delta", messages: [{ id: "m1", role: "user", text: "old", createdAt: "2026-10-01T09:00:00Z" }] }));
    ev.run("e2", "2026-11-01T09:00:00.000Z", JSON.stringify({ form: "delta", messages: [{ id: "m2", role: "user", text: "new", createdAt: "2026-11-01T09:00:00.000Z" }] }));
    ev.run("e3", "2026-12-01T09:00:00.000Z", "not json");
    expect(repairMessageTimes(db)).toEqual({ restored: 1 });
    expect(timeOf(db, "m1")).toBe("2026-10-01T09:00:00.000Z");
    expect(timeOf(db, "m2")).toBe("2026-11-01T09:00:00.000Z");
    expect(repairMessageTimes(db)).toEqual({ restored: 0 }); // idempotent
  });
});
