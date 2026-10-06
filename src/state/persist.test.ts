import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { persistCanonicalEvents } from "./pipeline";
import type { CanonicalEvent } from "../types";

const events = (n: number, text = (i: number) => `Message number ${i} about pricing tiers`): CanonicalEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, conversationId: "c1", source: "chatgpt", role: i % 2 ? "assistant" : "user",
    text: text(i), createdAt: "2026-01-01T00:00:00.000Z", index: i,
  })) as CanonicalEvent[];

const changes = (db: ReturnType<typeof openDb>) => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;

describe("capturing is proportional to what changed, not to the transcript", () => {
  test("re-sending a transcript that hasn't changed writes nothing", () => {
    const db = openDb(":memory:");
    persistCanonicalEvents(db, events(40));
    const before = changes(db);
    persistCanonicalEvents(db, events(40));
    expect(changes(db) - before).toBe(0);
  });

  test("a transcript that grew by one message writes one row", () => {
    const db = openDb(":memory:");
    persistCanonicalEvents(db, events(40));
    const before = changes(db);
    persistCanonicalEvents(db, events(41));
    expect(changes(db) - before).toBe(1);
  });

  test("an edited message is rewritten", () => {
    const db = openDb(":memory:");
    persistCanonicalEvents(db, events(5));
    persistCanonicalEvents(db, events(5, (i) => (i === 2 ? "Edited text for the third message" : `Message number ${i} about pricing tiers`)));
    expect((db.query("SELECT text FROM canonical_events WHERE id = 'm2'").get() as { text: string }).text).toBe("Edited text for the third message");
  });
});
