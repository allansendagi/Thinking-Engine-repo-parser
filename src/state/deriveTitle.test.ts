import { describe, expect, test } from "bun:test";
import { deriveTitle } from "./buildIdeaNode";

describe("deriveTitle", () => {
  test("uses the extractor's noun-phrase title when it's clean", () => {
    expect(deriveTitle("Authority must be independently verifiable.", "Computable authority")).toBe(
      "Computable authority",
    );
    expect(deriveTitle("some long rambling statement here", "Historical backfill boundary")).toBe(
      "Historical backfill boundary",
    );
  });

  test("ignores a model title that is itself narration, falls back to the statement", () => {
    expect(deriveTitle("Backfill should extract only what matters.", "The user wants backfill")).toBe(
      "Backfill should extract only what matters",
    );
  });

  test("strips third-person narration from the statement (the observed failure modes)", () => {
    // The framing "The user is seeking … whether" is gone; what's left reads as the thing itself.
    // (The real fix for narration is the prompt; this is the salvage path for when it slips.)
    expect(deriveTitle("The user is seeking the assistant's opinion on whether authority is verifiable")).toBe(
      "Authority is verifiable",
    );
    expect(deriveTitle("The human is asking why their approach to governance keeps failing")).toBe(
      "Approach to governance keeps failing",
    );
    expect(deriveTitle("The user model should be an email.", "The user wants an email-based account")).toBe(
      "The user model should be an email",
    );
    expect(deriveTitle("The user decides to request the export flow for old conversations")).toBe(
      "Request the export flow for old conversations",
    );
  });

  test("leaves a genuine first-person / imperative statement intact", () => {
    expect(deriveTitle("Authority itself needs to be machine-executable.")).toBe(
      "Authority itself needs to be machine-executable",
    );
    expect(deriveTitle("Who performs the independent verification?")).toBe(
      "Who performs the independent verification",
    );
  });

  test("does not mangle a sentence that merely opens with 'The user'", () => {
    // "The user" as the subject of a real claim, no narration pivot -> untouched.
    expect(deriveTitle("The user model should be an email, not a device id.")).toBe(
      "The user model should be an email, not…",
    );
  });

  test("truncates long statements to ~8 words with an ellipsis, no trailing punctuation", () => {
    expect(
      deriveTitle("Continuity should survive a restart, a new machine, and a fresh sign-in without any manual step."),
    ).toBe("Continuity should survive a restart, a new machine…");
    expect(deriveTitle("Recall by meaning.")).toBe("Recall by meaning");
  });
});
