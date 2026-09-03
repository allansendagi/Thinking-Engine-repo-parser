import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChatGptExport } from "../src/parser/chatgpt";
import { runPipeline, persistPipelineResult } from "../src/state/pipeline";
import { openDb, resetDb } from "../src/db/client";
import { createExtractionProvider, createReasoningProvider } from "../src/providers/anthropic";
import type { CanonicalEvent, CognitiveEvent, IdeaNode, IdentityResolution } from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "cases");
const OUT_DIR = join(__dirname, "out");

// --- Label schema -----------------------------------------------------------------------------
//
// One directory per case under eval/cases/<name>/ with conversations.json + labels.json. The
// anchors that used to be hardcoded in this file (which idea is "authority", which source event
// founds it) now live in each case's labels.identityGroups, so a new case needs no code change.
// See eval/README.md for the full schema and how to add a real export.

interface SubstantiveEventLabel {
  sourceEventId: string;
  required: boolean;
  acceptableTypes: string[];
  requiredSubstrings: string[];
  identityGroup: string;
  isFirstInGroup?: boolean;
}

interface IdentityGroup {
  /** Referenced by substantiveEvents[].identityGroup, criticalNonMatches[].mustNotMatchGroup,
   *  expectedOpenLoop.identityGroup. */
  name: string;
  /** A source event id that, after the pipeline runs, must land in this group's idea. Used to
   *  locate the reconstructed idea for every downstream check on the group. */
  anchorSourceEventId: string;
}

interface Labels {
  /** Only "chatgpt-export" is understood today -- a Claude export won't parse (see parseCase). */
  format: string;
  identityGroups: IdentityGroup[];
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

/** Everything one case contributes to the aggregate, as raw numerator/denominator pairs so the
 *  cross-case number is a true micro-average, not a mean-of-means that over-weights small cases. */
interface CaseCounts {
  recallHits: number;
  recallTotal: number;
  precisionKept: number;
  precisionTotal: number;
  identityCorrect: number;
  identityChecks: number;
  groundedClaims: number;
  totalModelClaims: number;
  openLoopHits: number;
  openLoopTotal: number;
  requiredDiscarded: string[];
  belowHigh: number;
  scoredTotal: number;
  noiseExtracted: number;
  noiseGated: number;
  discarded: number;
  rejected: number;
}

function gate(metric: string, value: number, threshold: number, comparator: ">=" | "<"): GateResult {
  const pass = comparator === ">=" ? value >= threshold : value < threshold;
  return { metric, value, threshold, comparator, pass };
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

function resolutionFor(
  resolutions: IdentityResolution[],
  cognitiveEventId: string,
): IdentityResolution | undefined {
  return resolutions.find((r) => r.cognitiveEventId === cognitiveEventId);
}

function discoverCases(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(CASES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        return statSync(join(CASES_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function parseCase(labels: Labels, conversations: unknown): CanonicalEvent[] {
  switch (labels.format) {
    case "chatgpt-export":
      return parseChatGptExport(conversations);
    default:
      throw new Error(
        `Unsupported case format "${labels.format}". Only "chatgpt-export" is understood -- ` +
          `a Claude export needs parseClaudeExport wiring here first (see eval/README.md).`,
      );
  }
}

interface CaseRun {
  name: string;
  ok: boolean; // parser precondition + format understood
  counts: CaseCounts | null;
  lines: string[]; // human-readable per-case block, printed verbatim
}

async function runCase(name: string): Promise<CaseRun> {
  const dir = join(CASES_DIR, name);
  const out: string[] = [`\n========== case: ${name} ==========`];

  let labels: Labels;
  let conversations: unknown;
  try {
    labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf-8"));
    conversations = JSON.parse(readFileSync(join(dir, "conversations.json"), "utf-8"));
  } catch (err) {
    out.push(`FAIL -- could not load case files: ${(err as Error).message}`);
    return { name, ok: false, counts: null, lines: out };
  }

  let canonicalEvents: CanonicalEvent[];
  try {
    canonicalEvents = parseCase(labels, conversations);
  } catch (err) {
    out.push(`FAIL -- ${(err as Error).message}`);
    return { name, ok: false, counts: null, lines: out };
  }

  // --- Parser correctness (precondition for every downstream metric) --------------------------
  const canonicalIds = new Set(canonicalEvents.map((e) => e.id));
  const leakedBranches = labels.excludedNodeIds.filter((id) => canonicalIds.has(id));
  const countMatches = canonicalEvents.length === labels.expectedCanonicalEventCount;
  out.push(
    `Parser: ${canonicalEvents.length} canonical events (expected ${labels.expectedCanonicalEventCount}); ` +
      `leaked abandoned-branch nodes: ${leakedBranches.length === 0 ? "none" : leakedBranches.join(", ")}`,
  );
  if (!countMatches || leakedBranches.length > 0) {
    out.push("FAIL -- parser correctness is a precondition; skipping this case's downstream metrics.");
    return { name, ok: false, counts: null, lines: out };
  }

  // --- Run the pipeline ---------------------------------------------------------------------
  const providers = { extraction: createExtractionProvider(), reasoning: createReasoningProvider() };
  const result = await runPipeline(canonicalEvents, providers);

  const db = openDb(join(OUT_DIR, `${name}.db`));
  resetDb(db);
  persistPipelineResult(db, canonicalEvents, result);
  db.close();
  out.push(`(persisted to eval/out/${name}.db)`);

  if (result.rejectedExtractions.length > 0) {
    out.push(`Rejected extractions (${result.rejectedExtractions.length}) -- failed the verbatim grounding check:`);
    for (const r of result.rejectedExtractions) {
      out.push(`  [${r.event.type}] source=${r.event.source_event_id} reason=${r.reason}`);
    }
  }

  // --- Idea-attribution recall / precision --------------------------------------------------
  const requiredLabels = labels.substantiveEvents.filter((s) => s.required);
  let recallHits = 0;
  for (const label of requiredLabels) {
    const matches = eventsForSource(result.cognitiveEvents, label.sourceEventId);
    const hit = matches.some(
      (e) =>
        label.acceptableTypes.includes(e.type) &&
        label.requiredSubstrings.every(
          (s) =>
            e.statement.toLowerCase().includes(s.toLowerCase()) ||
            e.evidenceQuote.toLowerCase().includes(s.toLowerCase()),
        ),
    );
    if (hit) recallHits++;
    else out.push(`  MISSED required event: ${label.sourceEventId} (${JSON.stringify(label.requiredSubstrings)})`);
  }

  const noiseSet = new Set(labels.noiseSourceEventIds);
  const falsePositives = result.cognitiveEvents.filter((e) => noiseSet.has(e.sourceEventId));
  const precisionKept = result.cognitiveEvents.length - falsePositives.length;

  // --- Signal gate ------------------------------------------------------------------------------
  const noiseExtracted = [...result.cognitiveEvents, ...result.discardedEvents.map((d) => d.event)].filter((e) =>
    noiseSet.has(e.sourceEventId),
  ).length;
  const noiseGated = result.discardedEvents.filter((d) => noiseSet.has(d.event.sourceEventId)).length;
  const requiredDiscarded = result.discardedEvents
    .filter((d) => requiredLabels.some((l) => l.sourceEventId === d.event.sourceEventId))
    .map((d) => d.event.sourceEventId);

  const allScored = [...result.cognitiveEvents, ...result.discardedEvents.map((d) => d.event)];
  const belowHigh = allScored.filter((e) => e.persistence !== "high").length;

  // --- Provenance accuracy / hallucination rate -------------------------------------------------
  const groundedClaims = result.cognitiveEvents.length + result.discardedEvents.length;
  const totalModelClaims = groundedClaims + result.rejectedExtractions.length;

  // --- Identity-resolution precision, per labelled group --------------------------------------
  const groupIdeas = new Map<string, IdeaNode | undefined>();
  for (const g of labels.identityGroups) {
    groupIdeas.set(g.name, findIdeaContainingSourceEvent(result.ideas, g.anchorSourceEventId));
    if (!groupIdeas.get(g.name)) {
      out.push(`  Could not locate the "${g.name}" idea (anchor ${g.anchorSourceEventId}) -- its identity checks all count as failed.`);
    }
  }

  let identityChecks = 0;
  let identityCorrect = 0;
  const anchorEventIds = new Set(labels.identityGroups.map((g) => g.anchorSourceEventId));
  for (const label of labels.substantiveEvents) {
    // A group's founding event has nothing earlier to merge into -- skip it whether the label
    // marked isFirstInGroup or just happens to be the group's anchor.
    if (label.isFirstInGroup || anchorEventIds.has(label.sourceEventId)) continue;
    const anchorIdea = groupIdeas.get(label.identityGroup);
    for (const e of eventsForSource(result.cognitiveEvents, label.sourceEventId)) {
      const r = resolutionFor(result.resolutions, e.id);
      if (!r) continue;
      identityChecks++;
      if (anchorIdea && r.matchedIdeaId === anchorIdea.id) identityCorrect++;
      else out.push(`  Identity miss: ${label.sourceEventId} did not merge into the "${label.identityGroup}" idea`);
    }
  }
  for (const critical of labels.criticalNonMatches) {
    const forbiddenIdea = groupIdeas.get(critical.mustNotMatchGroup);
    for (const e of eventsForSource(result.cognitiveEvents, critical.sourceEventId)) {
      const r = resolutionFor(result.resolutions, e.id);
      if (!r) continue;
      identityChecks++;
      const wronglyMerged = !!forbiddenIdea && r.matchedIdeaId === forbiddenIdea.id;
      if (!wronglyMerged) identityCorrect++;
      else out.push(`  CRITICAL identity false merge: ${critical.sourceEventId} was merged into the "${critical.mustNotMatchGroup}" idea`);
    }
  }

  // --- Open loop ------------------------------------------------------------------------------
  const openLoopAnchor = groupIdeas.get(labels.expectedOpenLoop.identityGroup);
  const openLoopFound =
    openLoopAnchor?.openLoops.some((loop) => {
      const text = loop.statement.toLowerCase();
      return labels.expectedOpenLoop.requiredSubstrings.every((s) => text.includes(s.toLowerCase()));
    }) ?? false;
  if (!openLoopFound) {
    out.push(`  Open-loop not captured on "${labels.expectedOpenLoop.identityGroup}" (${JSON.stringify(labels.expectedOpenLoop.requiredSubstrings)})`);
  }

  const counts: CaseCounts = {
    recallHits,
    recallTotal: requiredLabels.length,
    precisionKept,
    precisionTotal: result.cognitiveEvents.length,
    identityCorrect,
    identityChecks,
    groundedClaims,
    totalModelClaims,
    openLoopHits: openLoopFound ? 1 : 0,
    openLoopTotal: 1,
    requiredDiscarded,
    belowHigh,
    scoredTotal: allScored.length,
    noiseExtracted,
    noiseGated,
    discarded: result.discardedEvents.length,
    rejected: result.rejectedExtractions.length,
  };

  out.push(
    `recall ${recallHits}/${requiredLabels.length} | ` +
      `precision ${precisionKept}/${result.cognitiveEvents.length} | ` +
      `identity ${identityCorrect}/${identityChecks} | ` +
      `grounded ${groundedClaims}/${totalModelClaims} | ` +
      `open-loop ${openLoopFound ? "yes" : "no"} | ` +
      `gate discarded ${result.discardedEvents.length} (noise caught ${noiseGated}/${noiseExtracted}) | ` +
      `persistence<high ${belowHigh}/${allScored.length}` +
      (requiredDiscarded.length > 0 ? ` | REQUIRED DISCARDED: ${requiredDiscarded.join(", ")}` : ""),
  );

  return { name, ok: true, counts, lines: out };
}

const ratio = (num: number, den: number, whenEmpty = 1): number => (den === 0 ? whenEmpty : num / den);

export async function runEval(): Promise<void> {
  const names = discoverCases();
  if (names.length === 0) {
    console.log(
      `No cases found under eval/cases/. Add a directory with conversations.json + labels.json ` +
        `(see eval/README.md), or restore eval/cases/authority-payments.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${names.length} eval case(s): ${names.join(", ")}`);

  const runs: CaseRun[] = [];
  for (const name of names) {
    const run = await runCase(name);
    for (const line of run.lines) console.log(line);
    runs.push(run);
  }

  const scored = runs.filter((r) => r.ok && r.counts).map((r) => r.counts!);
  const skipped = runs.filter((r) => !r.ok).map((r) => r.name);

  if (scored.length === 0) {
    console.log(`\nEvery case failed its parser precondition (${skipped.join(", ")}). No aggregate to report.`);
    process.exitCode = 1;
    return;
  }

  const sum = (pick: (c: CaseCounts) => number) => scored.reduce((acc, c) => acc + pick(c), 0);

  const recall = ratio(sum((c) => c.recallHits), sum((c) => c.recallTotal));
  const precision = ratio(sum((c) => c.precisionKept), sum((c) => c.precisionTotal));
  const identityPrecision = sum((c) => c.identityChecks) === 0 ? 0 : sum((c) => c.identityCorrect) / sum((c) => c.identityChecks);
  const provenanceAccuracy = ratio(sum((c) => c.groundedClaims), sum((c) => c.totalModelClaims));
  const hallucinationRate = ratio(sum((c) => c.rejected), sum((c) => c.totalModelClaims), 0);
  const openLoopRate = sum((c) => c.openLoopHits) / sum((c) => c.openLoopTotal);
  const requiredDiscarded = scored.flatMap((c) => c.requiredDiscarded);
  const totalBelowHigh = sum((c) => c.belowHigh);
  const totalScored = sum((c) => c.scoredTotal);
  const totalSubstantive = sum((c) => c.recallTotal);

  const gates: GateResult[] = [
    gate("Idea-attribution recall", recall, 0.8, ">="),
    gate("Idea-attribution precision", precision, 0.9, ">="),
    gate("Identity-resolution precision", identityPrecision, 0.95, ">="),
    gate("Provenance accuracy", provenanceAccuracy, 0.98, ">="),
    gate("Hallucinated attribution rate", hallucinationRate, 0.02, "<"),
  ];

  console.log(`\n=== Aggregate gate results (micro-averaged across ${scored.length} case(s)) ===`);
  for (const r of gates) {
    const pct = (r.value * 100).toFixed(1);
    const thr = (r.threshold * 100).toFixed(1);
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.metric}: ${pct}% (need ${r.comparator} ${thr}%)`);
  }
  console.log(
    `${openLoopRate === 1 ? "PASS" : "FAIL"}  Expected open loop captured in ${sum((c) => c.openLoopHits)}/${sum((c) => c.openLoopTotal)} case(s)`,
  );
  console.log(
    `${requiredDiscarded.length === 0 ? "PASS" : "FAIL"}  No required event discarded by the gate` +
      (requiredDiscarded.length > 0 ? ` (lost: ${requiredDiscarded.join(", ")})` : ""),
  );

  console.log(
    `\n=== Signal gate ===\n` +
      `Discarded ${sum((c) => c.discarded)} grounded event(s) across all cases. ` +
      `Labeled noise: ${sum((c) => c.noiseExtracted)} extracted, ${sum((c) => c.noiseGated)} caught by the gate.\n` +
      `Persistence scored below "high" on ${totalBelowHigh}/${totalScored} events` +
      (totalBelowHigh === 0 ? "  <-- WARN: model may not be emitting persistence; gate is a no-op" : ""),
  );

  if (skipped.length > 0) console.log(`\nSkipped (parser precondition failed): ${skipped.join(", ")}`);

  const smallSample = totalSubstantive < 40;
  console.log(
    `\nSample: ${scored.length} case(s), ${totalSubstantive} required substantive event(s) total.` +
      (smallSample
        ? ` This is below the ~50-100 conversation scale at which the gate percentages become a ` +
          `meaningful measurement rather than a mechanics smoke test -- add real ChatGPT-export ` +
          `cases under eval/cases/ (see eval/README.md) before trusting these numbers.`
        : ``),
  );

  const anyGateFailed = gates.some((g) => !g.pass) || openLoopRate !== 1 || requiredDiscarded.length > 0 || skipped.length > 0;
  process.exitCode = anyGateFailed ? 1 : 0;
}
