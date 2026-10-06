import { existsSync, readFileSync } from "node:fs";
import type { Miner } from "./miners";
import type { MinedIdea, Scenario } from "./types";

/**
 * Scores the Mac's own model on the same suite as the cloud pipeline.
 *
 * Thread for Mac turns each capture into an idea on-device (`OnDeviceModel.absorbCapture`): it
 * either continues an existing idea or starts a new one. The Mac-side test
 * (BenchExtractionTests) runs that exact code over the bench's captures, in order, and writes one
 * line per capture; this turns those lines into the ideas a person would see and hands them to
 * the same scorer the cloud pipeline is judged by. Nothing here is generous: the on-device model
 * records no decisions and has no "this isn't an idea" outcome, so those rows score what the app
 * would actually do.
 */

export interface OnDeviceCapture {
  /** The captured message's id. */
  id: string;
  /** The idea this capture ended up in (a new one, or the one it continued); null when the model gave no answer. */
  ideaId: string | null;
  title: string | null;
  formulation: string | null;
  state: string | null;
  openQuestion: string | null;
  /** Wall-clock milliseconds for this capture. */
  ms: number;
}

export interface OnDeviceResults {
  model: string;
  device?: string;
  scenarios: { scenario: string; captures: OnDeviceCapture[] }[];
}

export function loadOnDeviceResults(path: string): OnDeviceResults | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as OnDeviceResults;
}

/** Every scenario in the suite must be covered, and every capture id must belong to it -- results from a
 *  different seed set or an older corpus would otherwise be scored as if they were this one. */
export function checkCoverage(results: OnDeviceResults, scenarios: Scenario[]): string | null {
  for (const s of scenarios) {
    const r = results.scenarios.find((x) => x.scenario === s.name);
    if (!r) return `no on-device results for scenario "${s.name}" -- run it on the same suite (--held-out or not) as the bench`;
    const ids = new Set(s.events.map((e) => e.id));
    const bad = r.captures.filter((c) => !ids.has(c.id)).length;
    if (bad > 0) return `${bad} on-device captures in "${s.name}" don't belong to this corpus -- the bench corpus changed since the run; re-run it`;
    const expected = s.events.filter((e) => e.role === "user").length;
    if (r.captures.length !== expected) return `"${s.name}": on-device results cover ${r.captures.length} of ${expected} captures`;
  }
  return null;
}

export function onDeviceMiner(results: OnDeviceResults): Miner {
  return {
    name: `on-device (${results.model})`,
    async mine(scenario) {
      const r = results.scenarios.find((x) => x.scenario === scenario.name);
      if (!r) throw new Error(`no on-device results for ${scenario.name}`);
      const byIdea = new Map<string, OnDeviceCapture[]>();
      for (const c of r.captures) {
        if (!c.ideaId) continue; // no answer: not captured
        const list = byIdea.get(c.ideaId) ?? [];
        list.push(c);
        byIdea.set(c.ideaId, list);
      }
      const ideas: MinedIdea[] = [...byIdea.entries()].map(([id, caps]) => {
        const first = caps[0]!;
        const last = caps[caps.length - 1]!;
        return {
          id,
          title: first.title ?? "",
          messageIds: caps.map((c) => c.id),
          currentFormulationMessageId: last.id,
          currentFormulation: last.formulation ?? "",
          // The model names at most one unresolved question per capture; the latest one stands.
          openLoops: last.openQuestion ? [{ statement: last.openQuestion, resolved: false, messageId: last.id }] : [],
          decisionMessageIds: [],
          state: last.state ?? "developing",
        };
      });
      return { ideas, sparkMessageIds: [] };
    },
  };
}

/** Speed, for the summary line. */
export function latencySummary(results: OnDeviceResults): { meanMs: number; p95Ms: number; answered: number; total: number } {
  const all = results.scenarios.flatMap((s) => s.captures);
  const ms = all.map((c) => c.ms).sort((a, b) => a - b);
  const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
  return {
    meanMs: Math.round(mean),
    p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]! : 0,
    answered: all.filter((c) => c.ideaId).length,
    total: all.length,
  };
}
