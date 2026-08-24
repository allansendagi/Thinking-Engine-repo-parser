import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChatGptExport } from "./chatgpt";

const FIXTURE_PATH = join(import.meta.dir, "../../eval/fixture/conversations.json");

describe("parseChatGptExport", () => {
  test("resolves the kept branch and excludes abandoned regenerations", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const events = parseChatGptExport(raw);

    const ids = new Set(events.map((e) => e.id));
    expect(ids.has("c1_u1_orig")).toBe(false);
    expect(ids.has("c1_a1_orig")).toBe(false);
    expect(ids.has("c1_u1")).toBe(true);

    const kept = events.find((e) => e.id === "c1_u1");
    expect(kept?.text).toContain("explicit authority boundaries");
  });

  test("drops system/tool turns and preserves per-conversation order", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    const events = parseChatGptExport(raw);
    const conv1 = events.filter((e) => e.conversationId === "conv_1");
    expect(conv1.map((e) => e.id)).toEqual(["c1_u1", "c1_a1", "c1_u2", "c1_a2"]);
    expect(conv1.every((e, i) => e.index === i)).toBe(true);
  });

  test("throws on a cyclical mapping instead of looping forever", () => {
    const cyclic = [
      {
        id: "c",
        current_node: "a",
        mapping: {
          a: { id: "a", parent: "b", children: [], message: null },
          b: { id: "b", parent: "a", children: [], message: null },
        },
      },
    ];
    expect(() => parseChatGptExport(cyclic)).toThrow(/Cycle detected/);
  });
});
