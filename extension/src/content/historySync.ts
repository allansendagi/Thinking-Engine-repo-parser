import type { HistoryReader } from "./structured";

/**
 * "Bring in my history": walk the past conversations the user is signed in to, newest first,
 * and import the recent ones (`splitRecent`; older ones on request) in small batches. Minutes instead of the hours a provider's data-export email
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
  /** Bring in conversations older than the default window too (`splitRecent`). */
  includeOlder?: boolean;
  /** Clock, for tests. */
  now?: number;
  /**
   * A full import has finished before. Then a run is a check for what's new: listing stops at the
   * first page that is entirely already imported -- provided the list really is newest-first,
   * which is verified page by page -- instead of walking the whole history again.
   */
  previouslyComplete?: boolean;
}

export interface SyncProgress {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
  ideaCount: number | null;
  /** Conversations left for later: older than the default window, not brought in this run. */
  older: number;
  state: "listing" | "importing" | "done" | "capped" | "stopped" | "error";
  error?: string;
}

/**
 * Which conversations a recovery brings in by default -- the same rule as Thread for Mac
 * (RecoveryWindow.swift): newest first, the last RECOVERY_DAYS days or the newest RECOVERY_MIN
 * conversations, whichever is more. The rest is "older", brought in only on request. A first
 * recovery should show what the person is working on now; on the Free plan the 25-idea cap used
 * to fill with their oldest conversations.
 */
export const RECOVERY_DAYS = 90;
export const RECOVERY_MIN = 100;
/** The first batch is small so the first ideas land within a minute. */
export const FIRST_BATCH = 5;

const timeOf = (updatedAt: string): number => {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? t : -Infinity;
};

/** Newest first (stable; undated last, in listing order), then split into default and older. */
export function splitRecent<T extends { updatedAt: string }>(items: T[], now: number): { recent: T[]; older: T[] } {
  const ordered = [...items].sort((a, b) => {
    const x = timeOf(a.updatedAt), y = timeOf(b.updatedAt);
    return x === y ? 0 : y > x ? 1 : -1;
  });
  const cutoff = now - RECOVERY_DAYS * 86_400_000;
  let inWindow = 0;
  while (inWindow < ordered.length && timeOf(ordered[inWindow]!.updatedAt) >= cutoff) inWindow++;
  const n = Math.min(ordered.length, Math.max(inWindow, RECOVERY_MIN));
  return { recent: ordered.slice(0, n), older: ordered.slice(n) };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function runHistorySync(deps: SyncDeps): Promise<SyncProgress> {
  const { reader, sendBatch, markSynced } = deps;
  const delayMs = deps.delayMs ?? 350;
  const batchSize = deps.batchSize ?? 15;
  const maxPages = deps.maxPages ?? 200;
  const progress: SyncProgress = { found: 0, imported: 0, skipped: 0, failed: 0, ideaCount: null, older: 0, state: "listing" };
  const report = () => deps.onProgress?.({ ...progress });

  try {
    // 1. List everything first (cheap), newest first, de-duplicated across pages.
    let todo: { id: string; updatedAt: string }[] = [];
    const listed: { id: string; updatedAt: string }[] = [];
    const seen = new Set<string>();
    let newestFirst = true;
    let previous: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      if (deps.shouldStop?.()) return finish("stopped");
      const { items, done } = await reader.listPage(page);
      let fresh = 0;
      let allKnown = items.length > 0;
      for (const c of items) {
        if (previous !== null && c.updatedAt > previous) newestFirst = false;
        previous = c.updatedAt;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        listed.push(c);
        fresh++;
        progress.found++;
        if (deps.synced[c.id] === c.updatedAt) progress.skipped++;
        else {
          todo.push(c);
          allKnown = false;
        }
      }
      report();
      if (done || fresh === 0) break; // fresh === 0: an endpoint that ignores offset
      // Everything older than an all-known page was imported last time and hasn't changed.
      if (deps.previouslyComplete && newestFirst && allKnown) break;
    }

    // 2. What to bring in: the default window (counting what's already in), newest first --
    //    or everything when asked for the older conversations too.
    const { recent } = splitRecent(listed, deps.now ?? Date.now());
    const wanted = deps.includeOlder ? null : new Set(recent.map((c) => c.id));
    const ordered = splitRecent(todo, deps.now ?? Date.now());
    const todoNewestFirst = [...ordered.recent, ...ordered.older];
    todo = wanted ? todoNewestFirst.filter((c) => wanted.has(c.id)) : todoNewestFirst;
    progress.older = wanted ? todoNewestFirst.length - todo.length : 0;

    // 3. Fetch + import in batches: a small first one, then `batchSize`.
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
      const limit = progress.imported === 0 ? Math.min(FIRST_BATCH, batchSize) : batchSize;
      if (batch.length >= limit && !(await flush())) return finish("capped");
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
