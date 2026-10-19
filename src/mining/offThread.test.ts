import { describe, expect, test } from "bun:test";
import { consolidate, type MiningThought } from "./consolidate";
import { consolidateOffThread } from "./offThread";

describe("consolidation off the main thread", () => {
  test("gives exactly the inline result", async () => {
    const t = (id: string, conv: string, statement: string, type: MiningThought["type"] = "new_idea"): MiningThought => ({
      id, type, statement, persistence: "high", sourceEventId: `m_${id}`, conversationId: conv, position: id.length, createdAt: `2026-09-0${id.length}T00:00:00Z`,
    });
    const thoughts = [
      t("a", "c1", "Charge per seat with annual discounts."),
      t("bb", "c1", "Do guests count toward the per seat bill?", "question"),
      t("ccc", "c2", "Onboarding should show value in five minutes."),
    ];
    const vectors = new Map<string, Float32Array>([["a", Float32Array.of(1, 0.3, 0)], ["bb", Float32Array.of(1, -0.3, 0)], ["ccc", Float32Array.of(-1, 0, 1)]]);
    const options = { vectors, themeThreshold: 0.15, constraints: { cannotLink: [["a", "ccc"]] as [string, string][] } };
    expect(await consolidateOffThread(thoughts, options)).toEqual(consolidate(thoughts, options));
  });
});
