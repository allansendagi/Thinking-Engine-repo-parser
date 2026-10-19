import { describe, expect, test } from "bun:test";
import { historyErrorText } from "./historyText";

describe("history error wording", () => {
  test("points at the real cause", () => {
    expect(historyErrorText("Request failed: 502")).toContain("server didn't answer (502)");
    expect(historyErrorText("Request failed: 401")).toContain("not signed in");
    expect(historyErrorText("Request failed: 429")).toContain("limiting requests");
    expect(historyErrorText("weird")).toContain("weird");
  });
});
