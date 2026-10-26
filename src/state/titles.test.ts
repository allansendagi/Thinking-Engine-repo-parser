import { describe, expect, test } from "bun:test";
import { deriveTitle, isPersonTitle } from "./buildIdeaNode";

describe("idea titles", () => {
  test("a quoted name the person gives is the title", () => {
    expect(deriveTitle("They are naming 'computable Authority'")).toBe("Computable Authority");
    expect(deriveTitle("We could call it “the Nanny Pattern” from now on.")).toBe("The Nanny Pattern");
  });

  test("how the person opens a sentence isn't part of the name", () => {
    expect(deriveTitle("I need to merge these two strategic plans")).toBe("Merge these two strategic plans");
    expect(deriveTitle("We should mention why the typical approaches fail")).toBe("Mention why the typical approaches fail");
    expect(deriveTitle("I'll create my own subreddit")).toBe("Create my own subreddit");
    expect(deriveTitle("Let's draft the proposal for Amazon")).toBe("Draft the proposal for Amazon");
    expect(deriveTitle("I think I do have something here")).toBe("I do have something here");
  });

  test("an idea that is already a name is left alone", () => {
    expect(deriveTitle("Price increase for workshop")).toBe("Price increase for workshop");
    expect(deriveTitle("Portability as defining primitive difference")).toBe("Portability as defining primitive difference");
  });

  test("narration about the person is recognised", () => {
    expect(isPersonTitle("They are naming things")).toBe(true);
    expect(isPersonTitle("The user claims they have triangulation")).toBe(true);
    expect(isPersonTitle("Theory of authority")).toBe(false);
  });

  test("the extractor's own name wins when it's clean", () => {
    expect(deriveTitle("I think authority should be verifiable by anyone.", "Verifiable authority")).toBe("Verifiable authority");
  });
});
