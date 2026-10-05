import type { HistoryReader } from "./structured";

/**
 * "Bring in my history": walk every past conversation the user is signed in to, newest first,
 * and import it in small batches. Minutes instead of the hours a provider's data-export email
 * takes -- this is what makes a new user's first recall land on day one.
 *
 * Pure orchestration over injected I/O so it's fully testable (historySync.test.ts):
 *  - resumable: conversations already imported at their current `updatedAt` are skipped, so a
 *    re-run (or a run cut short by closing the tab) only does the remaining work, and a
 *    conversation that grew since is re-sent (the backend dedupes turns it already has);
 *  - polite: one conversation fetched at a time with a small gap, the way a person scrolling
 *    their history would load them -- not a burst;
 *  - bounded: stops cleanly on the Free plan's cap (the backend answers 402) or on `shouldStop`.
 */

export interface SyncDeps {
  reader: HistoryReader;
  /** Previously imported conversations: id -> the updatedAt it was imported at. */
  synced: Record<string, string>;
  /** Import one batch. Resolves to `{ capped: true }` when the account hit the Free cap. */
  sendBatch(conversations: unknown[]): Promise<{ capped?: boolean; ideaCount?: number }>;
  /** Persist that these conversations were imported at these updatedAt values. */
  markSynced(entries: Record<string, string>): Promise<void>;
  onProgress?(p: SyncProgress): void;
  shouldStop?(): boolean;
  /** Pause between conversation fetches. Tests pass 0. */
  delayMs?: number;
  batchSize?: number;
  /** Safety valve against an endpoint that ignores paging. */
  maxPages?: number;
}

export interface SyncProgress {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
  ideaCount: number | null;
  state: "listing" | "importing" | "done" | "capped" | "stopped" | "error";
  error?: string;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function runHistorySync(deps: SyncDeps): Promise<SyncProgress> {
  const { reader, sendBatch, markSynced } = deps;
  const delayMs = deps.delayMs ?? 350;
  const batchSize = deps.batchSize ?? 15;
  const maxPages = deps.maxPages ?? 200;
  const progress: SyncProgress = { found: 0, imported: 0, skipped: 0, failed: 0, ideaCount: null, state: "listing" };
  const report = () => deps.onProgress?.({ ...progress });

  try {
    // 1. List everything first (cheap), newest first, de-duplicated across pages.
    const todo: { id: string; updatedAt: string }[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      if (deps.shouldStop?.()) return finish("stopped");
      const { items, done } = await reader.listPage(page);
      let fresh = 0;
      for (const c of items) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        fresh++;
        progress.found++;
        if (deps.synced[c.id] === c.updatedAt) progress.skipped++;
        else todo.push(c);
      }
      report();
      if (done || fresh === 0) break; // fresh === 0: an endpoint that ignores offset
    }

    // 2. Fetch + import in batches.
    progress.state = "importing";
    report();
    let batch: unknown[] = [];
    let batchRefs: Record<string, string> = {};
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true;
      const res = await sendBatch(batch);
      if (typeof res.ideaCount === "number") progress.ideaCount = res.ideaCount;
      if (res.capped) return false;
      await markSynced(batchRefs);
      progress.imported += batch.length;
      batch = [];
      batchRefs = {};
      report();
      return true;
    };

    for (const c of todo) {
      if (deps.shouldStop?.()) {
        await flush();
        return finish("stopped");
      }
      try {
        batch.push(await reader.fetchForImport(c.id));
        batchRefs[c.id] = c.updatedAt;
      } catch {
        progress.failed++; // one unreadable conversation never sinks the run
      }
      if (batch.length >= batchSize && !(await flush())) return finish("capped");
      await sleep(delayMs);
    }
    if (!(await flush())) return finish("capped");
    return finish("done");
  } catch (e) {
    progress.error = e instanceof Error ? e.message : String(e);
    return finish("error");
  }

  function finish(state: SyncProgress["state"]): SyncProgress {
    progress.state = state;
    report();
    return { ...progress };
  }
}
