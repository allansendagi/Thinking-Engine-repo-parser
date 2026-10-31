import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { repairProvenance, runDataRepairs } from "../db/repairs";
import { textHash } from "../db/thoughts";
import { FakeProvider } from "../providers/fake";
import { ingestConversation } from "./ingest";

const extraction = (events: object[]) => JSON.stringify({ events });
const at = "2026-08-17T00:00:00.000Z";
const msg = (id: string, text: string) => ({ id, role: "user" as const, text, createdAt: at });
const textOf = (db: ReturnType<typeof openDb>, id: string) =>
  (db.query("SELECT text FROM canonical_events WHERE id = ?").get(id) as { text: string } | null)?.text;

describe("provenance guard: a reused message id never changes what a thought was taken from", () => {
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

  test("text that still holds every quote (it grew) updates in place, as before", async () => {
    const db = openDb(":memory:");
    await first(db);
    const grown = "Pricing should be per outcome, not per seat. Small teams overpay otherwise.";
    await ingestConversation(db, { conversationId: "c", source: "fixture", messages: [msg("c::1", grown), msg("c::2", "And one more thing.")] }, {
      extraction: new FakeProvider([extraction([])]),
      reasoning: new FakeProvider([]),
    });
    expect(textOf(db, "c::1")).toBe(grown);
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
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail)).toEqual({ repointed: 1, unrecoverable: 1 });
  });
});
