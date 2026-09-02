import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatGptExport } from "../src/parser/chatgpt";
import { runPipeline, persistPipelineResult } from "../src/state/pipeline";
import { openDb, resetDb } from "../src/db/client";
import { createExtractionProvider, createReasoningProvider } from "../src/providers/anthropic";
import type { CanonicalEvent, CognitiveEvent, IdeaNode, IdentityResolution } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SubstantiveEventLabel {
  sourceEventId: string;
  required: boolean;
  acceptableTypes: string[];
  requiredSubstrings: string[];
  identityGroup: string;
  isFirstInGroup?: boolean;
}

interface Labels {
  excludedNodeIds: string[];
  expectedCanonicalEventCount: number;
  substantiveEvents: SubstantiveEventLabel[];
  expectedOpenLoop: { sourceEventId: string; requiredSubstrings: string[]; identityGroup: string };
  noiseSourceEventIds: string[];
  criticalNonMatches: { sourceEventId: string; mustNotMatchGroup: string }[];
}

interface GateResult {
  metric: string;
  value: number;
  threshold: number;
  comparator: ">=" | "<";
  pass: boolean;
}

function loadFixture(): { conversations: unknown; labels: Labels } {
  const conversations = JSON.parse(
    readFileSync(join(__dirname, "fixture/conversations.json"), "utf-8"),
  );
  const labels: Labels = JSON.parse(readFileSync(join(__dirname, "fixture/labels.json"), "utf-8"));
  return { conversations, labels };
}

function findIdeaContainingSourceEvent(
  ideas: Map<string, IdeaNode>,
  sourceEventId: string,
): IdeaNode | undefined {
  for (const idea of ideas.values()) {
    if (idea.evolution.some((step) => step.sourceEventId === sourceEventId)) return idea;
  }
  return undefined;
}

function eventsForSource(events: CognitiveEvent[], sourceEventId: string): CognitiveEvent[] {
  return events.filter((e) => e.sourceEventId === sourceEventId);
}

function resolutionFor(resolutions: IdentityResolution[], cognitiveEventId: string): IdentityResolution | undefined {
  return resolutions.find((r) => r.cognitiveEventId === cognitiveEventId);
}

function gate(metric: string, value: number, threshold: number, comparator: ">=" | "<"): GateResult {
  const pass = comparator === ">=" ? value >= threshold : value < threshold;
  return { metric, value, threshold, comparator, pass };
}

export async function runEval(): Promise<void> {
  const { conversations, labels } = loadFixture();

  // --- Parser correctness ---------------------------------------------------------------
  const canonicalEvents: CanonicalEvent[] = parseChatGptExport(conversations);
  const canonicalIds = new Set(canonicalEvents.map((e) => e.id));

  const leakedBranches = labels.excludedNodeIds.filter((id) => canonicalIds.has(id));
  const countMatches = canonicalEvents.length === labels.expectedCanonicalEventCount;

  console.log("=== Parser correctness (branch resolution) ===");
  console.log(`Canonical events: ${canonicalEvents.length} (expected ${labels.expectedCanonicalEventCount})`);
  console.log(`Leaked abandoned-branch nodes: ${leakedBranches.length === 0 ? "none" : leakedBranches.join(", ")}`);
  if (!countMatches || leakedBranches.length > 0) {
    console.log("FAIL -- parser correctness is a precondition for every downstream metric. Stopping.");
    return;
  }
  console.log("PASS\n");

  // --- Run the pipeline --------------------------------------------------------------------
  const providers = { extraction: createExtractionProvider(), reasoning: createReasoningProvider() };
  const result = await runPipeline(canonicalEvents, providers);

  const db = openDb(join(__dirname, "out/eval.db"));
  resetDb(db);
  persistPipelineResult(db, canonicalEvents, result);
  db.close();
  console.log(`(Persisted to eval/out/eval.db -- inspect with the MCP tools or sqlite3 directly.)\n`);

  if (result.rejectedExtractions.length > 0) {
    console.log(`=== Rejected extractions (${result.rejectedExtractions.length}) -- failed the verbatim grounding check ===`);
    for (const r of result.rejectedExtractions) {
      console.log(`  [${r.event.type}] source=${r.event.source_event_id} reason=${r.reason}`);
      console.log(`    statement: ${r.event.statement}`);
      console.log(`    claimed evidence_quote: ${r.event.evidence_quote}`);
    }
    console.log("");
  }

  if (result.discardedEvents.length > 0) {
    console.log(`=== Signal-gate discards (${result.discardedEvents.length}) -- grounded but not worth persisting ===`);
    for (const d of result.discardedEvents) {
      console.log(`  [${d.event.type}] source=${d.event.sourceEventId} persistence=${d.event.persistence} -- ${d.gateReason}`);
      console.log(`    statement: ${d.event.statement}`);
    }
    console.log("");
  }

  // --- Idea-attribution precision / recall --------------------------------------------------
  const requiredLabels = labels.substantiveEvents.filter((s) => s.required);
  let recallHits = 0;
  for (const label of requiredLabels) {
    const matches = eventsForSource(result.cognitiveEvents, label.sourceEventId);
    // Checks the model's own statement OR the verbatim evidence quote -- the substance can land
    // in either, and grounding (is the quote actually verbatim) is already enforced separately
    // by the extraction-time hallucination guard, not re-checked here. Every requiredSubstring
    // must appear (content stems, not an exact phrase -- see labels.json's _comment).
    const hit = matches.some(
      (e) =>
        label.acceptableTypes.includes(e.type) &&
        label.requiredSubstrings.every(
          (s) => e.statement.toLowerCase().includes(s.toLowerCase()) || e.evidenceQuote.toLowerCase().includes(s.toLowerCase()),
        ),
    );
    if (hit) recallHits++;
    else console.log(`  MISSED required event: ${label.sourceEventId} (${JSON.stringify(label.requiredSubstrings)})`);
  }
  const recall = requiredLabels.length === 0 ? 1 : recallHits / requiredLabels.length;

  const noiseSet = new Set(labels.noiseSourceEventIds);
  const falsePositives = result.cognitiveEvents.filter((e) => noiseSet.has(e.sourceEventId));
  const precision =
    result.cognitiveEvents.length === 0
      ? 1
      : (result.cognitiveEvents.length - falsePositives.length) / result.cognitiveEvents.length;

  // --- Signal gate ---------------------------------------------------------------------------
  // Of the labeled noise events, how many the model extracted at all vs. how many the gate then
  // caught. A noise event that never reaches an idea is a win whether extraction omitted it or
  // the gate discarded it -- this just shows which layer is doing the work.
  const noiseExtracted = [...result.cognitiveEvents, ...result.discardedEvents.map((d) => d.event)].filter((e) =>
    noiseSet.has(e.sourceEventId),
  ).length;
  const noiseGated = result.discardedEvents.filter((d) => noiseSet.has(d.event.sourceEventId)).length;
  // A required event that the gate discarded is a false-discard -- the worst error class.
  const requiredDiscarded = result.discardedEvents.filter((d) =>
    requiredLabels.some((l) => l.sourceEventId === d.event.sourceEventId),
  );

  // --- Provenance accuracy / hallucination rate ----------------------------------------------
  // Discarded events are still GROUNDED (they passed the verbatim check; the signal gate dropped
  // them for value, not truth), so they count as correctly-attributed claims here -- otherwise
  // adding the gate would silently move the hallucination denominator.
  const groundedClaims = result.cognitiveEvents.length + result.discardedEvents.length;
  const totalModelClaims = groundedClaims + result.rejectedExtractions.length;
  const provenanceAccuracy = totalModelClaims === 0 ? 1 : groundedClaims / totalModelClaims;
  const hallucinationRate = totalModelClaims === 0 ? 0 : result.rejectedExtractions.length / totalModelClaims;

  // --- Identity resolution precision -----------------------------------------------------------
  const authorityIdea = findIdeaContainingSourceEvent(result.ideas, "c1_u1");
  let identityChecks = 0;
  let identityCorrect = 0;

  if (authorityIdea) {
    for (const label of labels.substantiveEvents) {
      if (label.isFirstInGroup) continue;
      if (label.identityGroup !== "authority") continue;
      const events = eventsForSource(result.cognitiveEvents, label.sourceEventId);
      for (const e of events) {
        const r = resolutionFor(result.resolutions, e.id);
        if (!r) continue;
        identityChecks++;
        if (r.matchedIdeaId === authorityIdea.id) identityCorrect++;
        else console.log(`  Identity miss: ${label.sourceEventId} did not merge into the authority idea`);
      }
    }
    for (const critical of labels.criticalNonMatches) {
      const events = eventsForSource(result.cognitiveEvents, critical.sourceEventId);
      for (const e of events) {
        const r = resolutionFor(result.resolutions, e.id);
        if (!r) continue;
        identityChecks++;
        const wronglyMatchedAuthority =
          critical.mustNotMatchGroup === "authority" && r.matchedIdeaId === authorityIdea.id;
        if (!wronglyMatchedAuthority) identityCorrect++;
        else console.log(`  CRITICAL identity false merge: ${critical.sourceEventId} was merged into the authority idea`);
      }
    }
  } else {
    console.log("  Could not locate the authority idea at all -- treating all identity checks as failed.");
  }
  const identityPrecision = identityChecks === 0 ? 0 : identityCorrect / identityChecks;

  // --- Open loop check --------------------------------------------------------------------------
  // All required substrings must appear (order-independent), not one exact phrase -- "who
  // performs" and "who should perform" are the same question asked differently.
  const openLoopFound =
    authorityIdea?.openLoops.some((loop) => {
      const text = loop.statement.toLowerCase();
      return labels.expectedOpenLoop.requiredSubstrings.every((s) => text.includes(s.toLowerCase()));
    }) ?? false;

  // --- Report -------------------------------------------------------------------------------------
  const results: GateResult[] = [
    gate("Idea-attribution recall", recall, 0.8, ">="),
    gate("Idea-attribution precision", precision, 0.9, ">="),
    gate("Identity-resolution precision", identityPrecision, 0.95, ">="),
    gate("Provenance accuracy", provenanceAccuracy, 0.98, ">="),
    gate("Hallucinated attribution rate", hallucinationRate, 0.02, "<"),
  ];

  console.log("\n=== Gate results (fixture-scale smoke test -- N is tiny, see caveat below) ===");
  for (const r of results) {
    const pct = (r.value * 100).toFixed(1);
    const thr = (r.threshold * 100).toFixed(1);
    console.log(
      `${r.pass ? "PASS" : "FAIL"}  ${r.metric}: ${pct}% (need ${r.comparator} ${thr}%)`,
    );
  }
  console.log(`${openLoopFound ? "PASS" : "FAIL"}  Open-loop captured ("who performs the verification")`);

  console.log(
    `\n=== Signal gate ===\n` +
      `Discarded ${result.discardedEvents.length} grounded event(s). ` +
      `Labeled noise: ${noiseExtracted} extracted, ${noiseGated} of those caught by the gate.\n` +
      `${requiredDiscarded.length === 0 ? "PASS" : "FAIL"}  No required event was discarded by the gate` +
      (requiredDiscarded.length > 0
        ? ` (lost: ${requiredDiscarded.map((d) => d.event.sourceEventId).join(", ")})`
        : ""),
  );

  console.log("\n=== Reconstructed idea (for human review) ===");
  if (authorityIdea) {
    console.log(`Title: ${authorityIdea.title}`);
    console.log(`State: ${authorityIdea.state}`);
    console.log(`Current formulation: ${authorityIdea.currentFormulation}`);
    console.log("Evolution:");
    for (const step of authorityIdea.evolution) {
      console.log(`  [${step.sourceEventId}] ${step.formulation}`);
    }
    console.log("Open loops:");
    for (const loop of authorityIdea.openLoops) {
      console.log(`  ${loop.resolved ? "[resolved]" : "[open]"} ${loop.statement}`);
    }
  } else {
    console.log("(no idea reconstructed)");
  }

  console.log(
    "\nCaveat: this fixture has ~6 substantive events, so each one is worth ~15-20 points of any " +
      "percentage above. These numbers prove the pipeline mechanics (branch resolution, grounding, " +
      "the authority/payments non-merge) work end to end -- they are not a statistically meaningful " +
      "measurement of the gate. Re-run this harness against a real export at the 50-100 conversation " +
      "scale before treating the gate numbers as real.",
  );
}
