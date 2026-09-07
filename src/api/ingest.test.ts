import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { loadEvidenceForConversation } from "../db/evidence";
import { ingestConversation } from "./ingest";
import { FakeProvider } from "../providers/fake";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}
function identityResponse(matchedIdeaId: string | null, confidence = 0.9): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence, reasoning: "scripted", also_related_idea_id: null });
}

describe("ingestConversation against a real DB (simulates repeated HTTP calls as a chat grows)", () => {
  test("re-sending the same transcript twice is a no-op the second time", async () => {
    const db = openDb(":memory:");
    const providers = {
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    };

    const input = {
      conversationId: "conv_1",
      source: "fixture" as const,
      messages: [{ id: "m1", role: "user" as const, text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
    };

    const first = await ingestConversation(db, input, providers);
    expect(first.newCanonicalEvents).toBe(1);
    expect(first.ideaCount).toBe(1);

    // Same exact call again -- extraction/reasoning providers have nothing left scripted, so if
    // ingestConversation tried to call either, this would throw. It shouldn't: no new messages.
    const second = await ingestConversation(db, input, providers);
    expect(second.newCanonicalEvents).toBe(0);
    expect(second.newCognitiveEvents).toBe(0);
    expect(loadIdeas(db)).toHaveLength(1); // still exactly one idea, not duplicated
  });

  test("a medium claim discarded for lack of a match is replayed once its idea arrives on a later call", async () => {
    const db = openDb(":memory:");

    // Call 1: a medium-persistence claim arrives BEFORE the idea it belongs to. Nothing to attach
    // to, so the signal gate discards it. newEventIds guarantees extraction never re-emits m1, so
    // without the replay pass this would be a permanent loss.
    const call1 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [{ id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" }],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "claim", statement: "Authority boundaries should be enforced at runtime.", confidence: 0.9, persistence: "medium", source_event_id: "m1", evidence_quote: "enforced at runtime" },
          ]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );
    expect(call1.ideaCount).toBe(0);
    expect(call1.discardedEvents).toBe(1);
    expect(loadIdeas(db)).toHaveLength(0);

    // Call 2: the founding idea arrives. The replay pass reconsiders the m1 discard against the
    // now-current idea set, finds a strong match, and promotes it.
    const call2 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user", text: "Authority boundaries must be explicit and enforced.", createdAt: "2026-08-18T00:00:00.000Z" },
        ],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "new_idea", statement: "Authority boundaries must be explicit and enforced.", confidence: 0.95, source_event_id: "m2", evidence_quote: "Authority boundaries" },
          ]),
        ]),
        // Exactly one identity call: the replay pass resolving the promoted m1 claim. The m2
        // new_idea has no candidates yet, so identity is skipped for it.
        reasoning: new FakeProvider([identityResponse("idea_cog_m2_0")]),
      },
    );

    expect(call2.promotedFromDiscard).toBe(1);
    expect(call2.ideaCount).toBe(1);
    const ideas = loadIdeas(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.evolution.map((e) => e.sourceEventId).sort()).toEqual(["m1", "m2"]);
  });

  test("replay does NOT promote a discard when identity still won't confirm the match", async () => {
    const db = openDb(":memory:");

    await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [{ id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" }],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "claim", statement: "Authority boundaries should be enforced at runtime.", confidence: 0.9, persistence: "medium", source_event_id: "m1", evidence_quote: "enforced at runtime" },
          ]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );
    expect(loadIdeas(db)).toHaveLength(0);

    // An idea arrives with strong lexical overlap -- replay re-examines m1 -- but identity
    // resolution says confidence 0.4 (below 0.75). m1 must NOT be promoted, and NOT become a
    // second idea; it stays in discarded_events for a future pass.
    const call2 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Authority boundaries should be enforced at runtime.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user", text: "Authority boundaries must be explicit and enforced.", createdAt: "2026-08-18T00:00:00.000Z" },
        ],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([
            { type: "new_idea", statement: "Authority boundaries must be explicit and enforced.", confidence: 0.95, source_event_id: "m2", evidence_quote: "Authority boundaries" },
          ]),
        ]),
        reasoning: new FakeProvider([identityResponse("idea_cog_m2_0", 0.4)]),
      },
    );

    expect(call2.promotedFromDiscard).toBe(0);
    expect(call2.ideaCount).toBe(1); // just the m2 idea, no thin thread for m1
    const ideas = loadIdeas(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.evolution.map((e) => e.sourceEventId)).toEqual(["m2"]);

    const stillDiscarded = db.query("SELECT id FROM discarded_events").all() as { id: string }[];
    expect(stillDiscarded.some((r) => r.id.includes("m1"))).toBe(true);
  });

  test("a growing conversation extends the same idea across three separate calls", async () => {
    const db = openDb(":memory:");

    const call1 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [{ id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" }]),
        ]),
        reasoning: new FakeProvider([]),
      },
    );
    expect(call1.ideaCount).toBe(1);
    const ideaId = loadIdeas(db)[0]?.id as string;

    const call2 = await ingestConversation(
      db,
      {
        conversationId: "conv_1",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user", text: "Those boundaries need to be executable.", createdAt: "2026-08-19T00:00:00.000Z" },
        ],
      },
      {
        extraction: new FakeProvider([
          extractionResponse([{ type: "refinement", statement: "Boundaries need to be executable.", confidence: 0.9, source_event_id: "m2", evidence_quote: "need to be executable" }]),
        ]),
        reasoning: new FakeProvider([identityResponse(ideaId)]),
      },
    );
    expect(call2.newCanonicalEvents).toBe(1); // only m2 was new
    expect(call2.ideaCount).toBe(1); // still one idea, extended

    const finalIdeas = loadIdeas(db);
    expect(finalIdeas).toHaveLength(1);
    expect(finalIdeas[0]?.evolution).toHaveLength(2);
    expect(finalIdeas[0]?.currentFormulation).toBe("Boundaries need to be executable.");
  });
});

describe("capture provenance (THREAD.md §7)", () => {
  const oneMessage = (id: string, text: string) => ({
    conversationId: "conv_cap",
    source: "fixture" as const,
    messages: [{ id, role: "user" as const, text, createdAt: "2026-08-17T00:00:00.000Z" }],
  });
  const providersFor = (statement: string, sourceId: string) => ({
    extraction: new FakeProvider([
      extractionResponse([
        { type: "new_idea", statement, confidence: 0.9, source_event_id: sourceId, evidence_quote: statement.slice(0, 12) },
      ]),
    ]),
    reasoning: new FakeProvider([]),
  });

  test("a capture stamp is persisted onto every canonical event of the conversation", async () => {
    const db = openDb(":memory:");
    await ingestConversation(
      db,
      { ...oneMessage("m1", "Native capture beats an adapter."), capture: { method: "browser_extension", fidelity: "high" } },
      providersFor("Native capture beats an adapter.", "m1"),
    );
    const [event] = loadCanonicalEvents(db);
    expect(event?.capture).toEqual({ method: "browser_extension", fidelity: "high" });
  });

  test("a later call without a capture stamp does NOT clobber an already-stamped row (COALESCE)", async () => {
    const db = openDb(":memory:");
    // First call: m1, stamped desktop_agent/medium.
    await ingestConversation(
      db,
      {
        conversationId: "conv_cap",
        source: "fixture" as const,
        messages: [{ id: "m1", role: "user" as const, text: "Fidelity is part of provenance.", createdAt: "2026-08-17T00:00:00.000Z" }],
        capture: { method: "desktop_agent", fidelity: "medium" },
      },
      providersFor("Fidelity is part of provenance.", "m1"),
    );
    // Second call adds m2 and carries NO capture field. persistPipelineResult REPLACEs every row
    // of the conversation, so this is the real COALESCE path -- m1's stamp must survive.
    await ingestConversation(
      db,
      {
        conversationId: "conv_cap",
        source: "fixture" as const,
        messages: [
          { id: "m1", role: "user" as const, text: "Fidelity is part of provenance.", createdAt: "2026-08-17T00:00:00.000Z" },
          { id: "m2", role: "user" as const, text: "So the pipeline can weight it.", createdAt: "2026-08-19T00:00:00.000Z" },
        ],
      },
      // Extraction finds nothing new worth promoting -- keeps the test on the persist/COALESCE
      // path without also needing a scripted identity-resolution response.
      { extraction: new FakeProvider([extractionResponse([])]), reasoning: new FakeProvider([]) },
    );
    const byId = Object.fromEntries(loadCanonicalEvents(db).map((e) => [e.id, e]));
    expect(byId.m1?.capture).toEqual({ method: "desktop_agent", fidelity: "medium" }); // survived
    expect(byId.m2?.capture).toBeNull(); // this call carried no stamp
  });

  test("no capture stamp at all stays null -- read downstream as extension/high, not stored as a guess", async () => {
    const db = openDb(":memory:");
    await ingestConversation(db, oneMessage("m1", "Legacy client sends nothing."), providersFor("Legacy client sends nothing.", "m1"));
    const [event] = loadCanonicalEvents(db);
    expect(event?.capture).toBeNull();
  });
});

describe("evidence layer (THREAD.md §7 -- raw observation below canonical events)", () => {
  const providersFor = (statement: string, sourceId: string) => ({
    extraction: new FakeProvider([
      extractionResponse([
        { type: "new_idea", statement, confidence: 0.9, source_event_id: sourceId, evidence_quote: statement.slice(0, 12) },
      ]),
    ]),
    reasoning: new FakeProvider([]),
  });

  test("an advancing observation records one evidence row with the sensor + accepted/observed counts", async () => {
    const db = openDb(":memory:");
    const res = await ingestConversation(
      db,
      {
        conversationId: "conv_ev",
        source: "fixture",
        messages: [
          { id: "m1", role: "user", text: "Evidence sits below canonical events.", createdAt: "2026-09-07T00:00:00.000Z" },
          { id: "m2", role: "assistant", text: "Yes -- three epistemic levels.", createdAt: "2026-09-07T00:01:00.000Z" },
        ],
        capture: { method: "browser_extension", fidelity: "high" },
      },
      providersFor("Evidence sits below canonical events.", "m1"),
    );
    expect(res.integrityOk).toBe(true);
    expect(res.integrityIssues).toEqual([]);

    const evidence = loadEvidenceForConversation(db, "conv_ev");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sensor: "browser_extension",
      observedCount: 2,
      acceptedCount: 2,
      integrityOk: true,
    });
    // Clean observation -> delta payload -- here both turns are new, so the delta is both.
    expect(evidence[0]?.payload.form).toBe("delta");
    expect(evidence[0]?.payload.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("a clean advancing resend stores only the NEW turn in the payload (delta, not O(n^2))", async () => {
    const db = openDb(":memory:");
    const base = {
      conversationId: "conv_delta",
      source: "fixture" as const,
      capture: { method: "browser_extension" as const, fidelity: "high" as const },
    };
    await ingestConversation(
      db,
      { ...base, messages: [{ id: "m1", role: "user", text: "Turn one.", createdAt: "2026-09-07T00:00:00.000Z" }] },
      providersFor("Turn one.", "m1"),
    );
    // Full resend: m1 (already seen) + m2 (new). Only m2 should land in the evidence payload.
    await ingestConversation(
      db,
      {
        ...base,
        messages: [
          { id: "m1", role: "user", text: "Turn one.", createdAt: "2026-09-07T00:00:00.000Z" },
          { id: "m2", role: "assistant", text: "Turn two.", createdAt: "2026-09-07T00:01:00.000Z" },
        ],
      },
      { extraction: new FakeProvider([extractionResponse([])]), reasoning: new FakeProvider([]) },
    );
    const evidence = loadEvidenceForConversation(db, "conv_delta");
    expect(evidence).toHaveLength(2);
    expect(evidence[1]?.payload.form).toBe("delta");
    expect(evidence[1]?.payload.messages.map((m) => m.id)).toEqual(["m2"]); // not ["m1","m2"]
    expect(evidence[1]).toMatchObject({ observedCount: 2, acceptedCount: 2 }); // counts still describe the whole observation
  });

  test("a malformed observation still ingests the valid messages AND records the issue", async () => {
    const db = openDb(":memory:");
    const res = await ingestConversation(
      db,
      {
        conversationId: "conv_bad",
        source: "fixture",
        messages: [
          { id: "", role: "user", text: "no id -- cannot be a canonical event", createdAt: "2026-09-07T00:00:00.000Z" },
          { id: "ok1", role: "user", text: "this one is fine", createdAt: "2026-09-07T00:01:00.000Z" },
        ],
        capture: { method: "browser_extension", fidelity: "high" },
      },
      providersFor("this one is fine", "ok1"),
    );
    expect(res.integrityOk).toBe(false);
    expect(res.integrityIssues.map((i) => i.code)).toEqual(["empty_id"]);
    // The good message still became a canonical event and an idea.
    expect(loadCanonicalEvents(db).map((e) => e.id)).toEqual(["ok1"]);
    expect(loadIdeas(db)).toHaveLength(1);

    const evidence = loadEvidenceForConversation(db, "conv_bad");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ observedCount: 2, acceptedCount: 1, integrityOk: false });
    expect(evidence[0]?.integrityIssues[0]?.code).toBe("empty_id");
    // A broken observation keeps the whole raw transcript, not a delta -- inspect it whole.
    expect(evidence[0]?.payload.form).toBe("full");
    expect(evidence[0]?.payload.messages).toHaveLength(2);
  });

  test("a clean no-op resend records NO new evidence row; a now-broken resend DOES", async () => {
    const db = openDb(":memory:");
    const clean = {
      conversationId: "conv_resend",
      source: "fixture" as const,
      messages: [{ id: "m1", role: "user" as const, text: "First observation.", createdAt: "2026-09-07T00:00:00.000Z" }],
      capture: { method: "browser_extension" as const, fidelity: "high" as const },
    };
    await ingestConversation(db, clean, providersFor("First observation.", "m1"));
    expect(loadEvidenceForConversation(db, "conv_resend")).toHaveLength(1);

    // Exact same transcript again, no new messages, still structurally clean -> no signal, no row.
    await ingestConversation(db, clean, { extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    expect(loadEvidenceForConversation(db, "conv_resend")).toHaveLength(1);

    // Same conversation, no new messages, but the sensor now returns a broken transcript
    // (duplicate id) -> a health signal worth keeping even though nothing advanced.
    await ingestConversation(
      db,
      {
        ...clean,
        messages: [
          { id: "m1", role: "user", text: "First observation.", createdAt: "2026-09-07T00:00:00.000Z" },
          { id: "m1", role: "user", text: "First observation.", createdAt: "2026-09-07T00:00:00.000Z" },
        ],
      },
      { extraction: new FakeProvider([]), reasoning: new FakeProvider([]) },
    );
    const evidence = loadEvidenceForConversation(db, "conv_resend");
    expect(evidence).toHaveLength(2);
    expect(evidence[1]).toMatchObject({ integrityOk: false });
    expect(evidence[1]?.integrityIssues.map((i) => i.code)).toContain("duplicate_id");
  });
});
