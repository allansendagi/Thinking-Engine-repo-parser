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
  resolvePacketText,
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
      "You moved from wanting institutional authority to be machine-executable toward needing that execution independently verified.",
      "authority as policy\nauthority as executable\nexecution can diverge\nindependent verification needed",
    ]);

    const r = await buildContinuationPacket(db, { ideaId: "idea_cog_u1_0" }, nextLine);
    expect(r).not.toBeNull();
    const { text, packet } = r!;

    expect(packet.idea.title).toContain("Authority");
    expect(packet.whereYouLeftOff).toBe("Independent verification needs a trusted third party or a portable proof.");
    expect(packet.evolution.map((e) => e.source)).toEqual(["ChatGPT", "Cursor", "Claude", "Claude"]);
    expect(packet.unresolvedQuestion).toContain("Who performs the independent verification");
    expect(packet.unresolvedQuestions.length).toBeGreaterThan(0);
    expect(packet.contested).toBe(false);
    expect(packet.suggestedNext).toContain("verification models");
    expect(packet.trajectory).toEqual([
      "authority as policy",
      "authority as executable",
      "execution can diverge",
      "independent verification needed",
    ]);

    // The machine handoff: ALL-CAPS field labels, a TASK directive, model slots as tokens.
    expect(text).toContain("CURRENT IDEA");
    expect(text).toContain("CURRENT FORMULATION");
    expect(text).toContain("THINKING EVOLUTION");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("RECENT EVIDENCE");
    expect(text).toContain("Claude — Aug 23");
    expect(text).toContain("TASK");
    expect(text).toContain("Do not restart the exploration.");
    expect(text).toContain(CONTINUE_TOKEN);
    expect(text).toContain("{{THINKING_EVOLUTION}}");
    expect(text).not.toContain(packet.suggestedNext);
    expect(text).not.toContain("authority as policy"); // trajectory is a token, not baked in
    expect(packet.evolutionUnverified).toBe(false);
    expect(packet.thinkingShift).toMatch(/^You moved from/); // still on the packet for the human card
    expect(packet.lastExploredSource).toBe("Claude");

    const filled = resolvePacketText(text, {
      nextStep: packet.suggestedNext,
      thinkingShift: packet.thinkingShift,
      trajectory: packet.trajectory,
    });
    expect(filled).toContain(packet.suggestedNext);
    expect(filled).toContain("authority as policy\n  ↓\n  authority as executable");
    expect(filled).not.toContain(CONTINUE_TOKEN);
    expect(filled).not.toContain("{{THINKING_EVOLUTION}}");

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
    expect(r!.packet.unresolvedQuestions).toHaveLength(0);
    expect(r!.text).not.toContain("UNRESOLVED");
    expect(r!.text).toContain("TASK");
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

  test("carries each step's conversation URL as a structured field, never into the paste text", async () => {
    const db = await seedAuthorityThread();
    db.query("UPDATE canonical_events SET source_url = ? WHERE conversation_id = 'c1'").run("https://chatgpt.com/c/c1");
    db.query("UPDATE canonical_events SET source_url = ? WHERE conversation_id = 'c3'").run("https://claude.ai/chat/c3");

    const trace = traceIdea(db, "idea_cog_u1_0")!;
    expect(trace.provenance[0]?.sourceUrl).toBe("https://chatgpt.com/c/c1");
    expect(trace.provenance[1]?.sourceUrl).toBeNull(); // c2 (cursor) never got a URL
    expect(trace.provenance[2]?.sourceUrl).toBe("https://claude.ai/chat/c3");

    const r = await buildContinuationPacket(db, { ideaId: "idea_cog_u1_0" });
    expect(r!.packet.evolution[0]?.sourceUrl).toBe("https://chatgpt.com/c/c1");
    expect(r!.packet.evolution[2]?.sourceUrl).toBe("https://claude.ai/chat/c3");
    // A link to another chat is noise for the model the text is pasted into -- keep it out.
    expect(r!.text).not.toContain("https://");
  });

  test("a null source_url on a later capture never clears one already stored", async () => {
    const db = await seedAuthorityThread();
    db.query("UPDATE canonical_events SET source_url = 'https://claude.ai/chat/c3' WHERE id = 'u3'").run();
    // A later flush re-persists the same row with no URL (mid-navigation). COALESCE must keep it.
    const u3: CanonicalEvent = { id: "u3", conversationId: "c3", source: "claude", role: "user", text: "But who actually performs that verification, and why should we trust them?", createdAt: "2026-08-23T11:00:00.000Z", index: 0 };
    persistPipelineResult(db, [u3], { ideas: new Map(), cognitiveEvents: [], discardedEvents: [], resolutions: [], rejectedExtractions: [] });
    const row = db.query("SELECT source_url AS u FROM canonical_events WHERE id = 'u3'").get() as { u: string | null };
    expect(row.u).toBe("https://claude.ai/chat/c3");
  });
});

describe("renderPacket", () => {
  const baseStep = (n: number): ContinuationPacket["evolution"][number] => ({
    when: `2026-08-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`,
    source: "ChatGPT",
    formulation: `Position ${n}`,
    sourceText: null,
    sourceUrl: null,
  });
  const basePacket = (evolution: ContinuationPacket["evolution"]): ContinuationPacket => ({
    idea: { id: "i", title: "T", state: "developing" },
    whereYouLeftOff: "here",
    contested: false,
    evolution,
    evolutionUnverified: false,
    decisions: [],
    unresolvedQuestion: null,
    unresolvedQuestions: [],
    suggestedNext: "do the next thing",
    trajectory: [],
    thinkingShift: null,
    lastExploredSource: null,
    lastExploredAt: null,
  });

  test("the full machine handoff: labelled sections, trajectory as a token, a TASK directive", () => {
    const p: ContinuationPacket = {
      ...basePacket([1, 2].map(baseStep)),
      idea: { id: "i", title: "Computable Authority", state: "contested" },
      whereYouLeftOff: "Institutional authority should be machine-executable and independently verified.",
      contested: true,
      decisions: [{ statement: "Frame NOMOS as a protocol, not infrastructure.", decidedAt: "x" }],
      unresolvedQuestions: ["Who performs verification?", "Why trust that verifier?"],
      trajectory: ["AI governance", "policy/execution gap", "authority must be executable"],
    };
    const text = renderPacket(p);
    expect(text).toStartWith("CURRENT IDEA\nComputable Authority");
    expect(text).toContain("CURRENT FORMULATION\nInstitutional authority should be machine-executable");
    expect(text).toContain("(contested — a later point conflicts with the above)");
    expect(text).toContain("ESTABLISHED\nFrame NOMOS as a protocol, not infrastructure.");
    expect(text).toContain(`THINKING EVOLUTION\n  ${"{{THINKING_EVOLUTION}}"}`);
    expect(text).toContain("UNRESOLVED\nWho performs verification?\nWhy trust that verifier?");
    expect(text).toContain("RECENT EVIDENCE\nChatGPT — Aug 12"); // newest first, capped at 2
    expect(text).toContain("TASK\nContinue the reasoning from this exact state. Do not restart the exploration.");
    expect(text.trimEnd()).toEndWith(CONTINUE_TOKEN);

    const filled = resolvePacketText(text, { nextStep: p.suggestedNext, trajectory: p.trajectory });
    expect(filled).toContain("  AI governance\n  ↓\n  policy/execution gap\n  ↓\n  authority must be executable");
    expect(filled).toContain("do the next thing");
    expect(filled).not.toContain("{{");
  });

  test("RECENT EVIDENCE keeps only the two newest, deduped", () => {
    const text = renderPacket(basePacket([1, 2, 3, 4].map(baseStep)));
    expect(text).toContain("ChatGPT — Aug 14"); // step 4
    expect(text).toContain("ChatGPT — Aug 13"); // step 3
    expect(text).not.toContain("Aug 12");
    expect(text).not.toContain("Aug 11");
  });

  test("every optional section is dropped when empty", () => {
    const text = renderPacket(basePacket([]));
    for (const label of ["ESTABLISHED", "THINKING EVOLUTION", "UNRESOLVED", "RECENT EVIDENCE"]) {
      expect(text).not.toContain(label);
    }
    expect(text).toContain("CURRENT IDEA");
    expect(text).toContain("TASK");
  });

  test("an unverified history is stated, not shown", () => {
    const text = renderPacket({ ...basePacket([]), evolutionUnverified: true });
    expect(text).toContain("THINKING EVOLUTION");
    expect(text).toContain("captured before source-role verification");
  });
});
