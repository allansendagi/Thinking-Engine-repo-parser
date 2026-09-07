import { describe, expect, test } from "bun:test";
import { resolveContinuationText, type ContinuePacketResponse } from "./api";

describe("resolveContinuationText", () => {
  const base: ContinuePacketResponse = {
    text: [
      "CURRENT IDEA",
      "Authority must be machine-executable and independently verifiable.",
      "",
      "THINKING EVOLUTION",
      "  {{THINKING_EVOLUTION}}",
      "",
      "{{THINKING_SHIFT}}",
      "",
      "TASK",
      "Continue the reasoning from this exact state.",
      "",
      "{{CONTINUE_FROM_HERE}}",
    ].join("\n"),
    packet: {
      suggestedNext: "Work out how a third party verifies the authority claim.",
      thinkingShift: "You moved from policy-as-prose to policy-as-executable-artifact.",
      trajectory: ["AI governance", "executable policy", "verifiable authority"],
    },
    tier: "pro",
  };

  test("bakes in every model-written slot -- no tokens left", () => {
    const out = resolveContinuationText(base);
    expect(out).not.toContain("{{");
    expect(out).toContain("Work out how a third party verifies the authority claim.");
    expect(out).toContain("You moved from policy-as-prose");
    expect(out).toContain("AI governance\n  ↓\n  executable policy\n  ↓\n  verifiable authority");
  });

  test("tolerates missing shift / trajectory (free tier)", () => {
    const out = resolveContinuationText({
      ...base,
      packet: { suggestedNext: "Keep going from here." },
      tier: "free",
    });
    expect(out).not.toContain("{{");
    expect(out).toContain("Keep going from here.");
    expect(out.endsWith("\n")).toBe(true);
  });
});
