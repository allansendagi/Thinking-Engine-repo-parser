import type { GoldThought, MinedIdea, Scenario } from "./types";

/** A miner's full answer: ideas, plus one-off thoughts it kept aside as "sparks". */
export interface MinerOutput {
  ideas: MinedIdea[];
  /** Thoughts captured but not (yet) part of an idea. Count as captured, ungrouped. */
  sparkMessageIds: string[];
}

/** Raw counts, so suites aggregate as true micro-averages. */
export interface BenchCounts {
  goldThoughts: number;
  captured: number;
  noiseTotal: number;
  noiseInIdeas: number;
  /** B-cubed sums over captured gold thoughts. */
  bcubedP: number;
  bcubedR: number;
  bcubedN: number;
  goldIdeas: number;
  ideasSplit: number;
  /** Mined ideas mixing thoughts from 2+ gold ideas, and how many of those mixed a confusable pair. */
  wrongMerges: number;
  criticalMerges: number;
  positionCorrect: number;
  openLoopsGold: number;
  openLoopsHit: number;
  resolvedGold: number;
  resolvedHit: number;
  /** Open loops wrongly marked resolved (e.g. a resolution closing every loop on the idea). */
  loopsWronglyClosed: number;
  decisionsGold: number;
  decisionsHit: number;
  adoptedGold: number;
  adoptedHit: number;
  /** Gold ideas whose mined idea ended up marked "rejected" though only an option was rejected. */
  falselyRejected: number;
}

export function emptyCounts(): BenchCounts {
  return {
    goldThoughts: 0, captured: 0, noiseTotal: 0, noiseInIdeas: 0,
    bcubedP: 0, bcubedR: 0, bcubedN: 0,
    goldIdeas: 0, ideasSplit: 0, wrongMerges: 0, criticalMerges: 0,
    positionCorrect: 0, openLoopsGold: 0, openLoopsHit: 0, resolvedGold: 0, resolvedHit: 0,
    loopsWronglyClosed: 0, decisionsGold: 0, decisionsHit: 0, adoptedGold: 0, adoptedHit: 0,
    falselyRejected: 0,
  };
}

export function addCounts(a: BenchCounts, b: BenchCounts): BenchCounts {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof BenchCounts)[]) out[k] += b[k];
  return out;
}

export function scoreScenario(scenario: Scenario, output: MinerOutput): BenchCounts {
  const c = emptyCounts();
  const goldByMsg = new Map<string, GoldThought>(scenario.thoughts.map((t) => [t.messageId, t]));

  // Which mined cluster each message landed in (sparks are their own singleton clusters).
  const clusterOf = new Map<string, string>();
  for (const idea of output.ideas) for (const m of idea.messageIds) clusterOf.set(m, idea.id);
  for (const m of output.sparkMessageIds) if (!clusterOf.has(m)) clusterOf.set(m, `spark:${m}`);

  // --- capture
  c.goldThoughts = scenario.thoughts.length;
  const captured = scenario.thoughts.filter((t) => clusterOf.has(t.messageId));
  c.captured = captured.length;
  c.noiseTotal = scenario.noiseMessageIds.length;
  const inIdeas = new Set(output.ideas.flatMap((i) => i.messageIds));
  c.noiseInIdeas = scenario.noiseMessageIds.filter((m) => inIdeas.has(m)).length;

  // --- grouping: B-cubed over captured gold thoughts
  const members = new Map<string, GoldThought[]>();
  for (const t of captured) {
    const k = clusterOf.get(t.messageId)!;
    members.set(k, [...(members.get(k) ?? []), t]);
  }
  for (const t of captured) {
    const cluster = members.get(clusterOf.get(t.messageId)!)!;
    const goldCluster = captured.filter((g) => g.idea === t.idea);
    const both = cluster.filter((g) => g.idea === t.idea).length;
    c.bcubedP += both / cluster.length;
    c.bcubedR += both / goldCluster.length;
    c.bcubedN += 1;
  }
  const confusable = new Set(scenario.ideas.flatMap((i) => i.confusableWith.map((o) => [i.key, o].sort().join("|"))));
  for (const cluster of members.values()) {
    const keys = [...new Set(cluster.map((t) => t.idea))];
    if (keys.length > 1) {
      c.wrongMerges += 1;
      if (keys.some((a, i) => keys.slice(i + 1).some((b) => confusable.has([a, b].sort().join("|"))))) c.criticalMerges += 1;
    }
  }

  // --- per gold idea: split?, and the state of the idea it mostly landed in
  c.goldIdeas = scenario.ideas.length;
  for (const gold of scenario.ideas) {
    const mine = captured.filter((t) => t.idea === gold.key);
    const clusters = new Map<string, number>();
    for (const t of mine) clusters.set(clusterOf.get(t.messageId)!, (clusters.get(clusterOf.get(t.messageId)!) ?? 0) + 1);
    if (clusters.size > 1) c.ideasSplit += 1;
    const majority = [...clusters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const mined = output.ideas.find((i) => i.id === majority);

    const questionMsg = (loop: string) =>
      scenario.thoughts.find((t) => t.idea === gold.key && t.role === "question" && t.loop === loop)?.messageId;
    const loopState = (msg: string | undefined) => mined?.openLoops.find((l) => l.messageId === msg);

    if (mined && mined.currentFormulationMessageId === gold.finalPositionMessageId) c.positionCorrect += 1;

    for (const loop of gold.openLoops) {
      c.openLoopsGold += 1;
      const s = loopState(questionMsg(loop));
      if (s && !s.resolved) c.openLoopsHit += 1;
      if (s && s.resolved) c.loopsWronglyClosed += 1;
    }
    for (const loop of gold.resolvedLoops) {
      c.resolvedGold += 1;
      const s = loopState(questionMsg(loop));
      if (s && s.resolved) c.resolvedHit += 1;
    }
    for (const d of gold.decisions) {
      c.decisionsGold += 1;
      if (mined?.decisionMessageIds.includes(d)) c.decisionsHit += 1;
    }
    // No storyline abandons its whole idea -- a "rejected" idea means the rejection of one OPTION
    // was applied to the idea itself.
    if (mined?.state === "rejected") c.falselyRejected += 1;
  }

  for (const t of scenario.thoughts.filter((t) => t.adopted)) {
    c.adoptedGold += 1;
    if (clusterOf.has(t.messageId)) c.adoptedHit += 1;
  }
  return c;
}

export interface BenchReport {
  thoughtRecall: number;
  noiseRate: number;
  groupingF1: number;
  groupingPrecision: number;
  groupingRecall: number;
  ideasSplitRate: number;
  wrongMerges: number;
  criticalMerges: number;
  positionAccuracy: number;
  openLoopRecall: number;
  loopsWronglyClosed: number;
  resolvedAccuracy: number;
  decisionRecall: number;
  adoptionRecall: number;
  falselyRejected: number;
}

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

export function report(c: BenchCounts): BenchReport {
  const p = ratio(c.bcubedP, c.bcubedN);
  const r = ratio(c.bcubedR, c.bcubedN);
  return {
    thoughtRecall: ratio(c.captured, c.goldThoughts),
    noiseRate: ratio(c.noiseInIdeas, c.noiseTotal),
    groupingPrecision: p,
    groupingRecall: r,
    groupingF1: p + r === 0 ? 0 : (2 * p * r) / (p + r),
    ideasSplitRate: ratio(c.ideasSplit, c.goldIdeas),
    wrongMerges: c.wrongMerges,
    criticalMerges: c.criticalMerges,
    positionAccuracy: ratio(c.positionCorrect, c.goldIdeas),
    openLoopRecall: ratio(c.openLoopsHit, c.openLoopsGold),
    loopsWronglyClosed: c.loopsWronglyClosed,
    resolvedAccuracy: ratio(c.resolvedHit, c.resolvedGold),
    decisionRecall: ratio(c.decisionsHit, c.decisionsGold),
    adoptionRecall: ratio(c.adoptedHit, c.adoptedGold),
    falselyRejected: c.falselyRejected,
  };
}
