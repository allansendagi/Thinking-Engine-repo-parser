import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./client";
import { loadConversationFingerprints } from "./queries";
import { applyRetention, setRetentionDays } from "./retention";
import { messageFingerprint } from "../state/resolveConversationIdentity";

describe("a database from before newer columns existed", () => {
  test("opens, is migrated, and old rows get their fingerprint", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-legacy-"));
    try {
      const path = join(dir, "old.db");
      // The oldest shape this table has had: none of the columns added since.
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE canonical_events (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, idx INTEGER NOT NULL);`);
      old.prepare("INSERT INTO canonical_events VALUES (?,?,?,?,?,?,?)").run(
        "m1", "c1", "chatgpt", "user", "Should we charge per seat or per workspace?", "2026-01-01T00:00:00Z", 0,
      );
      old.close();

      const db = openDb(path); // must not throw on indexes over columns the old table lacks
      const known = loadConversationFingerprints(db);
      expect(known).toHaveLength(1);
      expect([...known[0]!.fingerprint]).toEqual([messageFingerprint("Should we charge per seat or per workspace?")!]);

      // The fingerprint is a hash kept with the message, so it outlives the text.
      setRetentionDays(db, 0);
      expect(applyRetention(db).messages).toBe(1);
      expect((db.query("SELECT text FROM canonical_events").get() as { text: string }).text).toBe("");
      expect(loadConversationFingerprints(db)[0]!.fingerprint.size).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
