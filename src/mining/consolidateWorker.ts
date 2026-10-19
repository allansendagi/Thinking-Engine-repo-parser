import { consolidate, type ConsolidateOptions, type MiningThought } from "./consolidate";

/** Runs the v2 consolidation pass on its own thread: pure compute, no database, no network. */
declare const self: Worker;
self.onmessage = (e: MessageEvent<{ id: number; thoughts: MiningThought[]; options: ConsolidateOptions }>) => {
  const { id, thoughts, options } = e.data;
  try {
    self.postMessage({ id, ideas: consolidate(thoughts, options) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
