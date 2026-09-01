import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFromStateDb, scanForMessages } from "./cursor";

/**
 * These tests prove the SCANNING LOGIC works correctly against a plausible state.vscdb --
 * they cannot prove a real Cursor install's actual current schema matches what's constructed
 * here. See cursor.ts's module doc.
 */

function makeFakeStateDb(rows: { key: string; value: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "thread-cursor-test-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const row of rows) insert.run(row.key, row.value);
  db.close();
  return dbPath;
}

describe("scanForMessages", () => {
  test("finds a message-shaped array using role/text field naming", () => {
    const data = { someWrapper: { messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] } };
    expect(scanForMessages(data)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
  });

  test("recognizes alternate field names (type/author/sender, content/message)", () => {
    const data = [{ type: "human", content: "a" }, { author: "ai", message: "b" }];
    expect(scanForMessages(data)).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]);
  });

  test("does not mistake an incidental array for a message list", () => {
    const data = { filePaths: ["/a/b.ts", "/c/d.ts", "/e/f.ts"] };
    expect(scanForMessages(data)).toEqual([]);
  });

  test("returns an empty array for data with no message-shaped content anywhere", () => {
    expect(scanForMessages({ settings: { theme: "dark", fontSize: 14 } })).toEqual([]);
  });
});

describe("extractFromStateDb", () => {
  test("extracts conversations from chat-related keys, ignores unrelated keys", () => {
    const dbPath = makeFakeStateDb([
      {
        key: "workbench.panel.aichat.chatdata",
        value: JSON.stringify({
          tabs: [{ messages: [{ role: "user", text: "Authority needs explicit boundaries." }, { role: "assistant", text: "Tell me more." }] }],
        }),
      },
      { key: "workbench.colorTheme", value: JSON.stringify({ theme: "dark" }) }, // unrelated key, ignored
    ]);

    const conversations = extractFromStateDb(dbPath);
    rmSync(dbPath, { force: true });

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messages).toHaveLength(2);
    expect(conversations[0]?.messages[0]).toMatchObject({ role: "user", text: "Authority needs explicit boundaries." });
  });

  test("skips values that aren't valid JSON without crashing", () => {
    const dbPath = makeFakeStateDb([{ key: "composer.somethingChatRelated", value: "not json at all {{{" }]);
    expect(extractFromStateDb(dbPath)).toEqual([]);
    rmSync(dbPath, { force: true });
  });

  test("returns an empty array when no chat-related keys exist at all", () => {
    const dbPath = makeFakeStateDb([{ key: "workbench.colorTheme", value: "{}" }]);
    expect(extractFromStateDb(dbPath)).toEqual([]);
    rmSync(dbPath, { force: true });
  });
});
