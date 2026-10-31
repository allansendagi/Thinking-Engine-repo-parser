import { describe, expect, test } from "bun:test";
import { isLookupQuestion, quickGate, strongMatchScore } from "./signalGate";
import { SIGNAL_GATE_STRONG_MATCH_SCORE } from "../types";
import type { CognitiveEvent, CognitiveEventType, PersistenceLevel } from "../types";

function ev(persistence: PersistenceLevel, type: CognitiveEventType = "claim"): CognitiveEvent {
  return {
    id: "cog_x",
    type,
    statement: "Some statement.",
    confidence: 0.9,
    persistence,
    persistenceReason: "test",
    sourceEventId: "src_x",
    evidenceQuote: "statement",
    additionalSourceEventIds: [],
  };
}

describe("quickGate", () => {
  test("high persistence always persists", () => {
    expect(quickGate(ev("high", "claim"), "lenient").decision).toBe("persist");
    expect(quickGate(ev("high", "question"), "lenient").decision).toBe("persist");
  });

  test("low persistence discards, and carries the reason", () => {
    const g = quickGate(ev("low", "claim"), "lenient");
    expect(g.decision).toBe("discard");
    if (g.decision === "discard") expect(g.reason).toContain("persistence=low");
  });

  test("medium + a state/fact type persists in lenient mode", () => {
    for (const t of ["decision", "resolution", "connection", "contradiction", "open_loop"] as const) {
      expect(quickGate(ev("medium", t), "lenient").decision).toBe("persist");
    }
  });

  test("v4: medium + rejection needs a match (it's about an idea, so it needs one to attach to)", () => {
    expect(quickGate(ev("medium", "rejection"), "lenient").decision).toBe("needs-match");
    expect(quickGate(ev("high", "rejection"), "lenient").decision).toBe("persist");
  });

  test("v2: medium + new_idea needs a match (a tentative idea doesn't auto-spawn a node)", () => {
    expect(quickGate(ev("medium", "new_idea"), "lenient").decision).toBe("needs-match");
  });

  test("medium + leaky type (claim/question/refinement) needs a match", () => {
    for (const t of ["claim", "question", "refinement"] as const) {
      expect(quickGate(ev("medium", t), "lenient").decision).toBe("needs-match");
    }
  });

  test("strict mode makes even structural medium events need a match", () => {
    expect(quickGate(ev("medium", "new_idea"), "strict").decision).toBe("needs-match");
    expect(quickGate(ev("low", "new_idea"), "strict").decision).toBe("discard");
  });

  test("off mode is a no-op: everything persists, including low", () => {
    expect(quickGate(ev("low", "claim"), "off").decision).toBe("persist");
    expect(quickGate(ev("medium", "question"), "off").decision).toBe("persist");
  });

  test("a missing persistence field is treated as high (pre-gate data)", () => {
    const legacy = { ...ev("high"), persistence: undefined as unknown as PersistenceLevel };
    expect(quickGate(legacy, "lenient").decision).toBe("persist");
  });
});

describe("strongMatchScore", () => {
  test("defaults to the constant and honors a positive explicit override", () => {
    expect(strongMatchScore()).toBe(SIGNAL_GATE_STRONG_MATCH_SCORE);
    expect(strongMatchScore(0.4)).toBe(0.4);
    expect(strongMatchScore(-1)).toBe(SIGNAL_GATE_STRONG_MATCH_SCORE);
    expect(strongMatchScore(Number.NaN)).toBe(SIGNAL_GATE_STRONG_MATCH_SCORE);
  });
});

describe("gate v3: lookup questions", () => {
  const q = (statement: string, persistence: "high" | "medium" | "low" = "high") =>
    ({ id: "c", type: "question", statement, confidence: 0.9, persistence, sourceEventId: "s", evidenceQuote: "x", additionalSourceEventIds: [] }) as never;

  test("plain information requests are discarded even when the model rated them high", () => {
    for (const s of ["What does Raycast do?", "Where is Codex?", "What does deny by default mean in the context of the NOMOS Protocol?", "Can you give me the exact clips with timestamps?"]) {
      const g = quickGate(q(s), "lenient");
      expect(g.decision).toBe("discard");
    }
  });

  test("the discard is permanent: its reason is not the replayable marker", () => {
    const g = quickGate(q("Where is Codex?"), "lenient");
    expect(g.decision === "discard" && g.reason.includes("persist only if it extends an existing idea")).toBe(false);
  });

  test("real questions survive: first-person, strategic, or long", () => {
    for (const s of [
      "What should we do about the verification layer?",
      "What is the minimum viable authority for my workshop?",
      "Should I separate Computable Authority and Make AI Work as distinct founder positions?",
      "How to distinguish between two statements made weeks apart that represent the same evolving idea?",
      "Who performs the independent verification?".padEnd(130, " and why does it matter for the whole architecture"),
    ])
      expect(quickGate(q(s), "lenient").decision).toBe("persist");
  });

  test("only questions are affected, and mode off still persists everything", () => {
    expect(isLookupQuestion({ type: "claim", statement: "What does Raycast do?" })).toBe(false);
    expect(quickGate(q("Where is Codex?"), "off").decision).toBe("persist");
  });
});
