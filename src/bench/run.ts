import { addCounts, emptyCounts, report, scoreScenario, type BenchReport } from "./metrics";
import type { Miner } from "./miners";
import type { Scenario } from "./types";

export interface MinerResult {
  miner: string;
  report: BenchReport;
  perScenario: { scenario: string; report: BenchReport }[];
}

export async function runBench(miners: Miner[], scenarios: Scenario[]): Promise<MinerResult[]> {
  const out: MinerResult[] = [];
  for (const miner of miners) {
    let total = emptyCounts();
    const perScenario: MinerResult["perScenario"] = [];
    for (const s of scenarios) {
      const counts = scoreScenario(s, await miner.mine(s));
      total = addCounts(total, counts);
      perScenario.push({ scenario: s.name, report: report(counts) });
    }
    out.push({ miner: miner.name, report: report(total), perScenario });
  }
  return out;
}

const ROWS: { key: keyof BenchReport; label: string; pct: boolean; better: "high" | "low" }[] = [
  { key: "thoughtRecall", label: "Thoughts captured", pct: true, better: "high" },
  { key: "noiseRate", label: "Noise that became ideas", pct: true, better: "low" },
  { key: "groupingF1", label: "Grouping quality (B-cubed F1)", pct: true, better: "high" },
  { key: "groupingPrecision", label: "  · kept apart what's different", pct: true, better: "high" },
  { key: "groupingRecall", label: "  · kept together what's one idea", pct: true, better: "high" },
  { key: "ideasSplitRate", label: "Ideas split into duplicates", pct: true, better: "low" },
  { key: "wrongMerges", label: "Wrong merges (count)", pct: false, better: "low" },
  { key: "criticalMerges", label: "  · of look-alike ideas", pct: false, better: "low" },
  { key: "positionAccuracy", label: "\"Where I stand\" correct", pct: true, better: "high" },
  { key: "openLoopRecall", label: "Open questions still open", pct: true, better: "high" },
  { key: "loopsWronglyClosed", label: "Open questions wrongly closed", pct: false, better: "low" },
  { key: "resolvedAccuracy", label: "Answered questions closed", pct: true, better: "high" },
  { key: "decisionRecall", label: "Decisions recorded", pct: true, better: "high" },
  { key: "falselyRejected", label: "Ideas wrongly marked rejected", pct: false, better: "low" },
];

export function formatTable(results: MinerResult[]): string {
  const fmt = (v: number, pct: boolean) => (pct ? `${(v * 100).toFixed(1)}%` : String(v));
  const header = ["Metric", ...results.map((r) => r.miner)];
  const lines = [header.join(" | "), header.map(() => "---").join(" | ")];
  for (const row of ROWS) lines.push([row.label, ...results.map((r) => fmt(r.report[row.key], row.pct))].join(" | "));
  return lines.join("\n");
}
