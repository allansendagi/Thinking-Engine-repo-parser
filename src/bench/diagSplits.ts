#!/usr/bin/env bun
// Why do ideas split? For each gold idea the miner scattered, show the groups it landed in.
import { consolidate } from "../mining/consolidate";
import { standardSuite } from "./generate";
import { loadVoyageBenchVectors, oracleMiningThoughts } from "./miners";

const seeds = process.argv.includes("--tuned") ? [1, 2, 3] : [4, 5, 6, 7, 8, 9, 10, 11];
const voy = loadVoyageBenchVectors()!;
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / Math.sqrt(na * nb);
};
let splitIdeas = 0, goldIdeas = 0;
const byType: Record<string, number> = {};
let sameConv = 0, diffConv = 0, adjacent = 0;
const shown: string[] = [];
for (const s of standardSuite(seeds)) {
  const thoughts = oracleMiningThoughts(s, true);
  const vec = new Map(thoughts.map((t) => [t.id, voy.byText.get(t.statement)!]));
  const ideas = consolidate(thoughts, { vectors: vec });
  const groupOf = new Map<string, number>();
  ideas.forEach((idea, gi) => idea.thoughtIds.forEach((id) => groupOf.set(id, gi)));
  for (const gold of s.ideas) {
    goldIdeas++;
    const mine = thoughts.filter((t, i) => s.thoughts[i]!.idea === gold.key);
    const groups = new Map<number, typeof mine>();
    for (const t of mine) (groups.get(groupOf.get(t.id) ?? -1) ?? groups.set(groupOf.get(t.id) ?? -1, []).get(groupOf.get(t.id) ?? -1)!).push(t);
    if (groups.size < 2) continue;
    splitIdeas++;
    const gs = [...groups.values()].sort((a, b) => b.length - a.length);
    // Best cross-group similarity: how close did the split come to being a merge?
    let best = -1;
    for (const a of gs[0]!) for (const g of gs.slice(1)) for (const b of g) best = Math.max(best, cos(vec.get(a.id)!, vec.get(b.id)!));
    for (const g of gs.slice(1)) for (const t of g) {
      byType[t.type] = (byType[t.type] ?? 0) + 1;
      const peers = gs[0]!.filter((m) => m.conversationId === t.conversationId);
      if (peers.length) { sameConv++; if (peers.some((m) => Math.abs(m.position - t.position) <= 2)) adjacent++; } else diffConv++;
    }
    if (shown.length < 14)
      shown.push(
        `${s.name} / ${gold.key}: ${mine.length} thoughts in ${groups.size} groups, best cross-group cosine ${best.toFixed(2)}\n` +
          gs.map((g, i) => `   group ${i} (${g.length}): ` + g.map((t) => `[${t.type} c${t.conversationId.slice(-6)}@${t.position}] ${t.statement.slice(0, 60)}`).join(" | ")).join("\n"),
      );
  }
}
console.log(`split ${splitIdeas}/${goldIdeas} gold ideas (${seeds.join(",")}); thoughts left outside the main group, by type:`, byType);
console.log(`leftover thoughts: same conversation as the main group ${sameConv} (within 2 messages: ${adjacent}), a different conversation ${diffConv}`);
console.log(shown.join("\n\n"));
