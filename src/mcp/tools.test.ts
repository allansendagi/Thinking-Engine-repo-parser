import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { persistPipelineResult, runPipeline } from "../state/pipeline";
import { FakeProvider } from "../providers/fake";
import {
  buildContinuationPacket,
  CONTINUE_TOKEN,
  getIdea,
  getOpenLoops,
  getRecentChanges,
  getThreadState,
  renderPacket,
  resolveContinueToken,
  searchIdeas,
  traceIdea,
  type ContinuationPacket,
} from "./tools";
import type { CanonicalEvent } from "../types";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}
function identityResponse(matchedIdeaId: string | null): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence: 0.9, reasoning: "scripted", also_related_idea_id: null });
}

async function seedDb() {
  const events: CanonicalEvent[] = [
    { id: "u1", conversationId: "conv_1", source: "fixture", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
    { id: "u2", conversationId: "conv_2", source: "fixture", role: "user", text: "Authority boundaries need to be executable, per-agent.", createdAt: "2026-08-19T00:00:00.000Z", index: 0 },
  ];

  const extraction = new FakeProvider([
    extractionResponse([{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "u1", evidence_quote: "explicit boundaries" }]),
    extractionResponse([
      { type: "open_loop", statement: "Who enforces the boundaries?", confidence: 0.8, source_event_id: "u2", evidence_quote: "boundaries need to be executable" },
    ]),
  ]);
  const reasoning = new FakeProvider([identityResponse("idea_cog_u1_0")]);

  const result = await runPipeline(events, { extraction, reasoning });
  const db = openDb(":memory:");
  persistPipelineResult(db, events, result);
  return db;
}

describe("mcp/tools against a real persisted db", () => {
  test("searchIdeas finds the idea by keyword", async () => {
    const db = await seedDb();
    const results = searchIdeas(db, "authority boundaries");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toContain("Authority");
  });

  test("getIdea returns the full node with its open loop", async () => {
    const db = await seedDb();
    const idea = getIdea(db, "idea_cog_u1_0");
    expect(idea).not.toBeNull();
    expect(idea?.openLoops).toHaveLength(1);
    expect(idea?.openLoops[0]?.statement).toBe("Who enforces the boundaries?");
  });

  test("traceIdea attaches the original source text to each evolution step", async () => {
    const db = await seedDb();
    const trace = traceIdea(db, "idea_cog_u1_0");
    expect(trace).not.toBeNull();
    // Two steps: the founding new_idea event, and the open_loop event (which also updates the
    // idea's articulation, per buildIdeaNode -- every confident match appends an evolution step
    // regardless of type, not just refinements).
    expect(trace?.provenance).toHaveLength(2);
    expect(trace?.provenance[0]?.sourceText).toBe("Authority needs explicit boundaries.");
    expect(trace?.provenance[1]?.sourceText).toBe("Authority boundaries need to be executable, per-agent.");
    // Each step carries the tool it was captured from.
    expect(trace?.provenance[0]?.source).toBe("fixture");
    expect(trace?.provenance[1]?.source).toBe("fixture");
  });

  test("getThreadState and getOpenLoops/getRecentChanges are consistent with each other", async () => {
    const db = await seedDb();
    const state = getThreadState(db);
    const openLoops = getOpenLoops(db);
    const recent = getRecentChanges(db, 365);

    expect(state.currentIdeas).toHaveLength(1);
    expect(openLoops).toHaveLength(1);
    expect(recent.length).toBeGreaterThan(0);
  });

  test("getIdea returns null for an unknown id rather than throwing", async () => {
    const db = await seedDb();
    expect(getIdea(db, "idea_does_not_exist")).toBeNull();
  });
});

// --- Continuation packet ----------------------------------------------------------------------

async function seedAuthorityThread() {
  const events: CanonicalEvent[] = [
    { id: "u1", conversationId: "c1", source: "chatgpt", role: "user", text: "Authority needs explicit boundaries to mean anything.", createdAt: "2026-08-17T09:00:00.000Z", index: 0 },
    { id: "u2", conversationId: "c2", source: "cursor", role: "user", text: "Those boundaries should be executable, not just written policy.", createdAt: "2026-08-19T14:00:00.000Z", index: 0 },
    { id: "u3", conversationId: "c3", source: "claude", role: "user", text: "But who actually performs that verification, and why should we trust them?", createdAt: "2026-08-23T11:00:00.000Z", index: 0 },
    { id: "u4", conversationId: "c3", source: "claude", role: "user", text: "Independent verification needs a trusted third party or a portable proof.", createdAt: "2026-08-23T11:30:00.000Z", index: 1 },
  ];
  const extraction = new FakeProvider([
    extractionResponse([{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.95, source_event_id: "u1", evidence_quote: "explicit boundaries" }]),
    extractionResponse([{ type: "refinement", statement: "Authority boundaries must be executable, not just policy.", confidence: 0.9, source_event_id: "u2", evidence_quote: "executable" }]),
    extractionResponse([
      { type: "open_loop", statement: "Who performs the independent verification, and why trust them?", confidence: 0.85, source_event_id: "u3", evidence_quote: "who actually performs that verification" },
      { type: "refinement", statement: "Independent verification needs a trusted third party or a portable proof.", confidence: 0.9, source_event_id: "u4", evidence_quote: "trusted third party" },
    ]),
  ]);
  const reasoning = new FakeProvider([
    identityResponse("idea_cog_u1_0"), // u2
    identityResponse("idea_cog_u1_0"), // u3
    identityResponse("idea_cog_u1_0"), // u4
  ]);
  const result = await runPipeline(events, { extraction, reasoning });
  const db = openDb(":memory:");
  persistPipelineResult(db, events, result);
  return db;
}

describe("buildContinuationPacket", () => {
  test("assembles a source-backed packet for an idea id and renders paste-ready text", async () => {
    const db = await seedAuthorityThread();
    const nextLine = new FakeProvider([
      "Help me compare two or three concrete verification models, keeping the line between executable enforcement and independent verification.",
    ]);

    const r = await buildContinuationPacket(db, { ideaId: "idea_cog_u1_0" }, nextLine);
    expect(r).not.toBeNull();
    const { text, packet } = r!;

    expect(packet.idea.title).toContain("Authority");
    expect(packet.whereYouLeftOff).toBe("Independent verification needs a trusted third party or a portable proof.");
    expect(packet.evolution.map((e) => e.source)).toEqual(["ChatGPT", "Cursor", "Claude", "Claude"]);
    expect(packet.unresolvedQuestion).toContain("Who performs the independent verification");
    expect(packet.contested).toBe(false);
    expect(packet.suggestedNext).toContain("verification models");

    expect(text).toContain("Resume: ");
    expect(text).toContain("Where you left off");
    expect(text).toContain("How this evolved");
    expect(text).toContain("Aug 17, ChatGPT:");
    expect(text).toContain("Unresolved question");
    expect(text).toContain("Continue from here");
    // The suggested line is NOT baked into the render -- a token sits in its place.
    expect(text).toContain(CONTINUE_TOKEN);
    expect(text).not.toContain(packet.suggestedNext);
    expect(packet.evolutionUnverified).toBe(false);
    expect(resolveContinueToken(text, packet.suggestedNext)).toContain(packet.suggestedNext);
    expect(resolveContinueToken(text, packet.suggestedNext)).not.toContain(CONTINUE_TOKEN);

    // Eyeball the actual handoff -- fails nothing, but prints it so a human reads it once.
    console.log("\n----- continuation packet text -----\n" + text + "------------------------------------");
  });

  test("resolves a fuzzy topic to the single best-matching idea", async () => {
    const db = await seedAuthorityThread();
    const r = await buildContinuationPacket(db, { topic: "verification" });
    expect(r).not.toBeNull();
    expect(r!.packet.idea.id).toBe("idea_cog_u1_0");
    // no provider passed -> templated next step, still valid
    expect(r!.packet.suggestedNext.length).toBeGreaterThan(0);
  });

  test("returns null for an unknown idea id and for a topic that matches nothing", async () => {
    const db = await seedAuthorityThread();
    expect(await buildContinuationPacket(db, { ideaId: "idea_nope" })).toBeNull();
    expect(await buildContinuationPacket(db, { topic: "photosynthesis rates" })).toBeNull();
  });

  test("a resolved idea renders fine with no unresolved question", async () => {
    const db = await seedAuthorityThread();
    // resolve the open loop directly
    db.query("UPDATE open_loops SET resolved = 1").run();
    const r = await buildContinuationPacket(db, { ideaId: "idea_cog_u1_0" });
    expect(r!.packet.unresolvedQuestion).toBeNull();
    expect(r!.text).not.toContain("Unresolved question");
    expect(r!.text).toContain("Continue from here");
  });

  test("drops steps that aren't a verified user message; says so honestly", async () => {
    const db = await seedAuthorityThread();
    // Legacy shape: evolution steps exist but their source events are gone, so traceIdea can't
    // confirm a role -- sourceRole is null (unknown), which the strict filter must NOT treat as
    // the user.
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM canonical_events").run();
    db.exec("PRAGMA foreign_keys = ON");
    const r = await buildContinuationPacket(db, { ideaId: "idea_cog_u1_0" });
    expect(r).not.toBeNull();
    expect(r!.packet.evolution).toHaveLength(0);
    expect(r!.packet.evolutionUnverified).toBe(true);
    expect(r!.text).toContain("captured before source-role verification");
    expect(r!.text).not.toContain("Aug 17");
  });
});

describe("renderPacket", () => {
  const baseStep = (n: number): ContinuationPacket["evolution"][number] => ({
    when: `2026-08-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`,
    source: "ChatGPT",
    formulation: `Position ${n}`,
    sourceText: null,
  });
  const basePacket = (evolution: ContinuationPacket["evolution"]): ContinuationPacket => ({
    idea: { id: "i", title: "T", state: "developing" },
    whereYouLeftOff: "here",
    contested: false,
    evolution,
    evolutionUnverified: false,
    decisions: [],
    unresolvedQuestion: null,
    suggestedNext: "do the next thing",
  });

  test("abridges a long history to first + latest two, keeps the full list on the packet", () => {
    const packet = basePacket([1, 2, 3, 4, 5, 6].map(baseStep));
    const text = renderPacket(packet);
    expect(text).toContain("Position 1");
    expect(text).toContain("Position 5");
    expect(text).toContain("Position 6");
    expect(text).not.toContain("Position 2");
    expect(text).not.toContain("Position 3");
    expect(text).toContain("3 earlier steps — full history in Thread");
    expect(text).toContain(CONTINUE_TOKEN);
    expect(packet.evolution).toHaveLength(6); // structured data untouched
  });

  test("shows every step when there are four or fewer", () => {
    const text = renderPacket(basePacket([1, 2, 3, 4].map(baseStep)));
    for (const n of [1, 2, 3, 4]) expect(text).toContain(`Position ${n}`);
    expect(text).not.toContain("earlier step");
  });
});
