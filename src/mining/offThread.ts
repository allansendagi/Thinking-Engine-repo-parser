import { consolidate, type ConsolidatedIdea, type ConsolidateOptions, type MiningThought } from "./consolidate";

/**
 * The consolidation pass, off the main thread. It is O(n^2) in thoughts (measured: ~0.7s at 1,000,
 * ~3s at 2,000, ~8s at 3,000) and the server handles every account on one thread, so running it
 * inline let one large account stall everyone's requests. Only the pure computation moves: the
 * caller still reads and writes the database on the main thread, so account deletion and every
 * other per-connection guarantee is unchanged. If a worker can't be started (e.g. the single-file
 * build), it runs inline exactly as before.
 */

let worker: Worker | null = null;
let unavailable = false;
let nextId = 1;
const waiting = new Map<number, { resolve: (ideas: ConsolidatedIdea[]) => void; reject: (e: Error) => void; thoughts: MiningThought[]; options: ConsolidateOptions }>();

function getWorker(): Worker | null {
  if (worker || unavailable) return worker;
  try {
    worker = new Worker(new URL("./consolidateWorker.ts", import.meta.url).href);
    worker.onmessage = (e: MessageEvent<{ id: number; ideas?: ConsolidatedIdea[]; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error !== undefined) w.reject(new Error(e.data.error));
      else w.resolve(e.data.ideas!);
    };
    worker.onerror = (e) => {
      // A broken worker must never lose a pass: finish what was waiting inline, and stay inline.
      console.error("[Thread] consolidation worker failed; running inline from now on:", e.message);
      unavailable = true;
      worker?.terminate();
      worker = null;
      for (const [id, w] of waiting) {
        waiting.delete(id);
        try {
          w.resolve(consolidate(w.thoughts, w.options));
        } catch (err) {
          w.reject(err as Error);
        }
      }
    };
    (worker as { unref?: () => void }).unref?.();
  } catch (e) {
    console.error("[Thread] consolidation worker unavailable; running inline:", e);
    unavailable = true;
    worker = null;
  }
  return worker;
}

export function consolidateOffThread(thoughts: MiningThought[], options: ConsolidateOptions): Promise<ConsolidatedIdea[]> {
  const w = getWorker();
  if (!w) return Promise.resolve(consolidate(thoughts, options));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, thoughts, options });
    w.postMessage({ id, thoughts, options });
  });
}
