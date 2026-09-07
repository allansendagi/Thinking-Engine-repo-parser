import { describe, expect, test } from "bun:test";
import { canonicalize, provisionalReason, type RawObservation } from "./canonicalize";

const obs = (
  messages: RawObservation["messages"],
  sensor: RawObservation["sensor"] = "browser_extension",
): RawObservation => ({
  conversationId: "conv_1",
  source: "fixture",
  sensor,
  messages,
  sourceUrl: null,
  capture: { method: sensor, fidelity: "high" },
});

const m = (id: string, role: "user" | "assistant", text: string, createdAt = "2026-09-07T00:00:00.000Z") => ({
  id,
  role,
  text,
  createdAt,
});

describe("canonicalize -- structure validation (THREAD.md §7)", () => {
  test("a clean observation canonicalizes to exactly the positional map, 0..n-1", () => {
    const r = canonicalize(
      obs([
        m("a", "user", "one", "2026-09-07T00:00:00.000Z"),
        m("b", "assistant", "two", "2026-09-07T00:01:00.000Z"),
        m("c", "user", "three", "2026-09-07T00:02:00.000Z"),
      ]),
    );
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.issues).toEqual([]);
    expect(r.integrity.observed).toBe(3);
    expect(r.integrity.accepted).toBe(3);
    expect(r.events.map((e) => [e.id, e.role, e.index])).toEqual([
      ["a", "user", 0],
      ["b", "assistant", 1],
      ["c", "user", 2],
    ]);
    expect(r.events[0]?.capture).toEqual({ method: "browser_extension", fidelity: "high" });
  });

  test("a blank id is dropped and re-indexed, ok flips false", () => {
    const r = canonicalize(obs([m("", "user", "no id"), m("b", "assistant", "kept"), m("c", "user", "kept")]));
    expect(r.integrity.ok).toBe(false);
    expect(r.integrity.issues.map((i) => i.code)).toEqual(["empty_id"]);
    expect(r.events.map((e) => [e.id, e.index])).toEqual([
      ["b", 0],
      ["c", 1],
    ]);
  });

  test("blank text and an unknown role are each dropped", () => {
    const r = canonicalize(
      obs([
        m("a", "user", "   "),
        { id: "b", role: "system" as unknown as "user", text: "tool preamble", createdAt: "2026-09-07T00:00:00.000Z" },
        m("c", "assistant", "kept"),
      ]),
    );
    expect(r.integrity.ok).toBe(false);
    expect(r.integrity.issues.map((i) => i.code).sort()).toEqual(["bad_role", "empty_text"]);
    expect(r.events.map((e) => e.id)).toEqual(["c"]);
  });

  test("a duplicate id within one observation drops the later occurrence", () => {
    const r = canonicalize(obs([m("a", "user", "first"), m("a", "user", "same id again"), m("b", "assistant", "kept")]));
    expect(r.integrity.issues.map((i) => i.code)).toEqual(["duplicate_id"]);
    expect(r.events.map((e) => [e.id, e.text])).toEqual([
      ["a", "first"],
      ["b", "kept"],
    ]);
  });

  test("every message unusable -> no_messages, empty events, ok false", () => {
    const r = canonicalize(obs([m("", "user", "x"), m("y", "user", "")]));
    expect(r.events).toEqual([]);
    expect(r.integrity.ok).toBe(false);
    expect(r.integrity.issues.map((i) => i.code)).toContain("no_messages");
  });

  test("timestamp regression is advisory -- flagged, kept, ok stays true", () => {
    const r = canonicalize(
      obs([
        m("a", "user", "later", "2026-09-07T00:05:00.000Z"),
        m("b", "assistant", "earlier", "2026-09-07T00:01:00.000Z"),
      ]),
    );
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.issues.map((i) => i.code)).toEqual(["timestamp_regression"]);
    expect(r.events).toHaveLength(2);
  });

  test("an all-one-role multi-message observation from a role-aware sensor is advisory single_role", () => {
    const r = canonicalize(obs([m("a", "user", "one"), m("b", "user", "two"), m("c", "user", "three")]));
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.issues.map((i) => i.code)).toEqual(["single_role"]);
    expect(r.events).toHaveLength(3);
  });

  test("single_role is NOT flagged for a sensor without real role labels (desktop_agent)", () => {
    const r = canonicalize(
      obs([m("a", "user", "one"), m("b", "user", "two"), m("c", "user", "three")], "desktop_agent"),
    );
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.issues).toEqual([]);
    expect(r.events).toHaveLength(3);
  });

  test("a single message is never flagged single_role", () => {
    const r = canonicalize(obs([m("a", "user", "just one")]));
    expect(r.integrity.issues).toEqual([]);
  });

  test("an empty observation is ok with no issues", () => {
    const r = canonicalize(obs([]));
    expect(r.events).toEqual([]);
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.issues).toEqual([]);
  });
});

describe("provisional / committed status (THREAD.md §17)", () => {
  test("a clean high-fidelity observation is committed; every event carries status", () => {
    const r = canonicalize(obs([m("a", "user", "one"), m("b", "assistant", "two")]));
    expect(r.integrity.status).toBe("committed");
    expect(r.integrity.provisionalReason).toBeNull();
    expect(r.events.every((e) => e.status === "committed")).toBe(true);
  });

  test("an observation that dropped content is provisional, reason names the drop codes", () => {
    const r = canonicalize(obs([m("", "user", "no id"), m("b", "assistant", "kept")]));
    expect(r.integrity.status).toBe("provisional");
    expect(r.integrity.provisionalReason).toContain("empty_id");
    expect(r.events.every((e) => e.status === "provisional")).toBe(true);
  });

  test("a structurally-clean but low-fidelity observation is provisional", () => {
    const o: RawObservation = {
      ...obs([m("a", "user", "one"), m("b", "assistant", "two")]),
      capture: { method: "screen_ocr", fidelity: "low" },
    };
    const r = canonicalize(o);
    expect(r.integrity.ok).toBe(true);
    expect(r.integrity.status).toBe("provisional");
    expect(r.integrity.provisionalReason).toBe("capture fidelity is low");
  });

  test("provisionalReason: advisory-only issues (timestamp regression) do NOT make it provisional", () => {
    expect(provisionalReason({ method: "browser_extension", fidelity: "high" }, { ok: true, issues: [{ code: "timestamp_regression", detail: "" }] })).toBeNull();
  });
});
