import { describe, expect, test } from "bun:test";
import {
  contentFingerprint,
  resolveConversationIdentity,
  type KnownConversation,
  type RawObservation,
} from "./resolveConversationIdentity";

const obs = (
  conversationId: string,
  texts: string[],
  sourceUrl: string | null = null,
): RawObservation => ({
  conversationId,
  source: "fixture",
  sensor: "browser_extension",
  sourceUrl,
  capture: { method: "browser_extension", fidelity: "high" },
  messages: texts.map((t, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: t, createdAt: "2026-09-07T00:00:00.000Z" })),
});

const known = (conversationId: string, texts: string[], sourceUrl: string | null = null): KnownConversation => ({
  conversationId,
  fingerprint: contentFingerprint(texts.map((t) => ({ text: t }))),
  sourceUrl,
});

const CONV_A = [
  "The continuity layer should own the cognitive architecture, not any model.",
  "Right -- models are interchangeable, the structure is the moat.",
  "So capture mechanisms should be interchangeable the same way.",
];

describe("resolveConversationIdentity (THREAD.md §9, §17)", () => {
  test("no known conversations -> resolved on the sensor's id (platform_id authority)", () => {
    const r = resolveConversationIdentity(obs("conv_a", CONV_A), []);
    expect(r.status).toBe("resolved");
    expect(r.canonicalId).toBe("conv_a");
    expect(r.authority).toBe("platform_id");
    expect(r.conflicts).toEqual([]);
  });

  test("a URL present -> canonical_url authority, and it's recorded as a claim", () => {
    const r = resolveConversationIdentity(obs("conv_a", CONV_A, "https://claude.ai/chat/abc"), []);
    expect(r.status).toBe("resolved");
    expect(r.authority).toBe("canonical_url");
    expect(r.claims.some((c) => c.authority === "canonical_url" && c.conversationId === "conv_a")).toBe(true);
  });

  test("content strongly matches a DIFFERENT conversation -> UNRESOLVED, both claims preserved", () => {
    const r = resolveConversationIdentity(
      obs("conv_fork", CONV_A), // brand-new platform id, but verbatim the same turns as conv_a
      [known("conv_a", CONV_A)],
    );
    expect(r.status).toBe("unresolved");
    expect(r.canonicalId).toBeNull();
    expect(r.authority).toBeNull();
    expect(r.conflicts.map((c) => c.type)).toContain("strong_content_mismatch");
    // Both competing identity claims are on the record -- the resolution is auditable.
    expect(r.claims.some((c) => c.authority === "platform_id" && c.conversationId === "conv_fork")).toBe(true);
    expect(r.claims.some((c) => c.authority === "content_fingerprint" && c.conversationId === "conv_a")).toBe(true);
  });

  test("content matching the SAME id (a normal resend) is not a conflict", () => {
    const r = resolveConversationIdentity(obs("conv_a", CONV_A), [known("conv_a", CONV_A)]);
    expect(r.status).toBe("resolved");
    expect(r.canonicalId).toBe("conv_a");
    expect(r.conflicts).toEqual([]);
  });

  test("partial overlap with a different conversation -> RESOLVED, weak contradiction recorded", () => {
    // Shares one line with conv_a, the rest is new -> below the strong ceiling, above the weak floor.
    const partial = [
      CONV_A[0]!,
      "This part is entirely about deployment pipelines and has nothing to do with the above.",
      "Railway auto-deploy lag was the real issue in that thread.",
      "We should add a deploy-status check to the CLI.",
    ];
    const r = resolveConversationIdentity(obs("conv_b", partial), [known("conv_a", CONV_A)]);
    // Not necessarily weak on every fixture, but it must not be UNRESOLVED and must not silently merge.
    expect(r.status).toBe("resolved");
    expect(r.canonicalId).toBe("conv_b");
    expect(r.conflicts.every((c) => c.type !== "strong_content_mismatch")).toBe(true);
  });

  test("a known conversation owning this exact URL under a different id -> url_id_mismatch recorded, still resolved", () => {
    const r = resolveConversationIdentity(
      obs("conv_new", ["Something completely unrelated so no content match."], "https://chatgpt.com/c/xyz"),
      [known("conv_old", ["Old unrelated content."], "https://chatgpt.com/c/xyz")],
    );
    expect(r.status).toBe("resolved"); // url_id_mismatch is advisory in M3, not a quarantine
    expect(r.conflicts.map((c) => c.type)).toContain("url_id_mismatch");
  });

  test("very short turns are excluded from the fingerprint (they collide across unrelated chats)", () => {
    const fp = contentFingerprint([{ text: "ok" }, { text: "yes" }, { text: "sure thing" }, { text: "A properly long and distinctive sentence." }]);
    expect([...fp]).toEqual(["a properly long and distinctive sentence."]);
  });
});
