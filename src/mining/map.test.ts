import { describe, expect, test } from "bun:test";
import type { CognitiveEventType, IdeaNode } from "../types";
import { buildThinkingMap, scqaHandoff } from "./map";

const step = (id: string, formulation: string, day: number) => ({
  cognitiveEventId: id, formulation, createdAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`, sourceEventId: `m_${id}`,
});

const idea: IdeaNode = {
  id: "idea_1",
  title: "Pricing model",
  state: "established",
  currentFormulation: "Annual plans only, billed per active member.",
  evolution: [
    step("a", "Charge per seat, not a flat fee.", 1),
    step("q", "Do guest collaborators count toward the bill?", 1),
    step("r", "No to workspace billing, it punishes small teams.", 2),
    step("c", "The bill should grow with headcount.", 4),
    step("ans", "Five guests free per account, then billed.", 5),
    step("d", "Annual plans only, billed per active member.", 6),
  ],
  openLoops: [{ id: "loop_q", statement: "Do guest collaborators count toward the bill?", createdAt: "2026-09-01T00:00:00.000Z", resolved: true }],
  decisions: [{ id: "dec_d", statement: "Annual plans only, billed per active member.", decidedAt: "2026-09-06T00:00:00.000Z", sourceEventId: "m_d" }],
  relatedIdeaIds: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const types = new Map<string, CognitiveEventType>([
  ["a", "new_idea"], ["q", "question"], ["r", "rejection"], ["c", "claim"], ["ans", "resolution"], ["d", "decision"],
]);

describe("thinking map", () => {
  test("builds the pyramid: governing thought, answered question, options, reasons, decisions, history", () => {
    const map = buildThinkingMap(idea, types, new Date("2026-09-10"));
    expect(map.governingThought).toBe("Annual plans only, billed per active member.");
    expect(map.questions).toEqual([{ statement: "Do guest collaborators count toward the bill?", raisedAt: "2026-09-01T00:00:00.000Z", status: "answered", answer: "Five guests free per account, then billed." }]);
    expect(map.options.map((o) => o.status)).toEqual(["rejected", "chosen"]);
    expect(map.reasons).toEqual(["The bill should grow with headcount."]);
    expect(map.history.map((h) => h.supersededAt === null)).toEqual([false, false, true]);
    expect(map.gaps).toEqual([]);
  });

  test("flags a decision with nothing under it, and a question left open with no options", () => {
    const bare: IdeaNode = {
      ...idea,
      evolution: [step("a", "Move the offsite to May.", 1), step("q", "Who books the venue?", 1), step("d", "We're doing May.", 2)],
      openLoops: [{ id: "loop_q", statement: "Who books the venue?", createdAt: "2026-09-01T00:00:00.000Z", resolved: false }],
      decisions: [],
      currentFormulation: "Move the offsite to May.",
    };
    const m1 = buildThinkingMap(bare, new Map([["a", "new_idea"], ["q", "question"], ["d", "claim"]]), new Date("2026-10-01"));
    expect(m1.gaps.map((g) => g.kind)).toContain("question-without-options");
    const m2 = buildThinkingMap({ ...bare, decisions: [{ id: "dec_d", statement: "We're doing May.", decidedAt: "2026-09-02", sourceEventId: "m_d" }] }, new Map([["a", "new_idea"], ["q", "question"], ["d", "decision"]]));
    expect(m2.gaps.map((g) => g.kind)).toContain("decision-without-reasons");
  });

  test("the hand-off reads top-down: situation, complication, (no open question), answer, because", () => {
    const text = scqaHandoff(buildThinkingMap(idea, types));
    expect(text.split("\n").map((l) => l.split(":")[0])).toEqual(["Situation", "Complication", "Answer so far", "Because"]);
    expect(text).toContain("Where it stands: Annual plans only, billed per active member.");
  });
});

describe("thinking map with claim roles", () => {
  test("an option claim is weighed, not where the idea stands; a reason claim sits under it", () => {
    const withOption: IdeaNode = {
      ...idea,
      evolution: [...idea.evolution.slice(0, 3), step("o", "Or bill per workspace.", 3), ...idea.evolution.slice(3)],
    };
    const roles = new Map<string, "position" | "option" | "reason">([["o", "option"], ["c", "reason"]]);
    const map = buildThinkingMap(withOption, new Map([...types, ["o", "claim"]]), new Date("2026-09-10"), roles);
    expect(map.options).toContainEqual({ statement: "Or bill per workspace.", status: "open" });
    expect(map.reasons).toEqual(["The bill should grow with headcount."]);
    expect(map.history.map((h) => h.statement)).not.toContain("Or bill per workspace.");
  });
});
