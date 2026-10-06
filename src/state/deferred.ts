import type { Database } from "bun:sqlite";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { dismissedExamples } from "../mining/corrections";
import type { CanonicalEvent } from "../types";
import {
  persistCanonicalEvents,
  persistPipelineResult,
  runPipeline,
  type PipelineProviders,
  type PipelineResult,
} from "./pipeline";

/**
 * Capture is never hostage to the AI. The conversation is stored FIRST; idea extraction runs
 * after. If the model can't be reached (unpaid bill, outage, rate limit, a malformed reply),
 * the new messages wait in `pending_extraction` with the reason and are processed automatically
 * once it's back -- on the next capture or app sync. Before this, an AI failure threw before
 * anything was stored, the request 500'd, and the client eventually dropped the conversation.
 */

/**
 * One extraction at a time per account database: a background retry and a live capture must
 * never process the same waiting messages twice. A plain promise chain per db file.
 */
const locks = new Map<string, Promise<unknown>>();
async function exclusive<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const key = db.filename;
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

export interface ExtractOutcome {
  result: PipelineResult | null;
  /** New messages saved but not yet turned into ideas. */
  deferred: number;
  error: string | null;
}

export function extractOrDefer(
  db: Database,
  contextEvents: CanonicalEvent[],
  extractIds: Set<string>,
  providers: PipelineProviders,
): Promise<ExtractOutcome> {
  return exclusive(db, () => extractOrDeferLocked(db, contextEvents, extractIds, providers));
}

async function extractOrDeferLocked(
  db: Database,
  contextEvents: CanonicalEvent[],
  extractIds: Set<string>,
  providers: PipelineProviders,
): Promise<ExtractOutcome> {
  // 1. The capture itself, durably, before any model call.
  persistCanonicalEvents(db, contextEvents);

  // 2. Older captures still waiting go first, so ideas build in the order the thinking happened.
  //    (Before this capture is marked waiting -- otherwise the backlog pass would process it too.)
  const backlog = deferredStatus(db).count > 0 ? await retryUnlocked(db, providers) : null;

  const now = new Date().toISOString();
  const mark = db.prepare(
    "INSERT OR IGNORE INTO pending_extraction (event_id, conversation_id, queued_at) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    for (const e of contextEvents) if (extractIds.has(e.id)) mark.run(e.id, e.conversationId, now);
  })();

  if (backlog?.error) {
    // Still unavailable: don't spend another call; this capture waits with the same reason.
    recordFailure(db, extractIds, backlog.error);
    return { result: null, deferred: extractIds.size, error: backlog.error };
  }

  // 3. This capture.
  try {
    const result = await runPipeline(contextEvents, providers, {
      existingIdeas: new Map(loadIdeas(db).map((i) => [i.id, i])),
      newEventIds: extractIds,
      dismissed: dismissedExamples(db),
    });
    persistPipelineResult(db, contextEvents, result);
    clear(db, extractIds);
    return { result, deferred: 0, error: null };
  } catch (e) {
    const error = describe(e);
    recordFailure(db, extractIds, error);
    console.error(`[Thread] extraction deferred (${extractIds.size} messages): ${error}`);
    return { result: null, deferred: extractIds.size, error };
  }
}

/** Process waiting captures, oldest conversation first. Stops at the first failure (the model is
 *  still unavailable -- no point burning attempts on the rest). */
export function retryDeferredExtraction(
  db: Database,
  providers: PipelineProviders,
  maxConversations = 10,
): Promise<{ processed: number; error: string | null }> {
  return exclusive(db, () => retryUnlocked(db, providers, maxConversations));
}

async function retryUnlocked(
  db: Database,
  providers: PipelineProviders,
  maxConversations = 10,
): Promise<{ processed: number; error: string | null }> {
  const convs = db
    .query(
      "SELECT conversation_id, MIN(queued_at) AS first FROM pending_extraction GROUP BY conversation_id ORDER BY first LIMIT ?",
    )
    .all(maxConversations) as { conversation_id: string }[];
  if (convs.length === 0) return { processed: 0, error: null };
  const all = loadCanonicalEvents(db);
  let processed = 0;
  for (const { conversation_id } of convs) {
    const ids = new Set(
      (db.query("SELECT event_id FROM pending_extraction WHERE conversation_id = ?").all(conversation_id) as {
        event_id: string;
      }[]).map((r) => r.event_id),
    );
    const context = all.filter((e) => e.conversationId === conversation_id);
    // Rows whose event vanished (a provisional event later retracted) have nothing to extract.
    const live = new Set([...ids].filter((id) => context.some((e) => e.id === id && e.status === "committed")));
    if (live.size === 0) {
      clear(db, ids);
      continue;
    }
    try {
      const result = await runPipeline(context, providers, {
        existingIdeas: new Map(loadIdeas(db).map((i) => [i.id, i])),
        newEventIds: live,
        dismissed: dismissedExamples(db),
      });
      persistPipelineResult(db, context, result);
      clear(db, ids);
      processed += live.size;
    } catch (e) {
      const error = describe(e);
      recordFailure(db, ids, error);
      return { processed, error };
    }
  }
  return { processed, error: null };
}

export interface DeferredStatus {
  /** Messages saved but waiting for idea extraction. */
  count: number;
  /** Why the last attempt failed, e.g. the AI provider's error. */
  lastError: string | null;
  oldestQueuedAt: string | null;
}

export function deferredStatus(db: Database): DeferredStatus {
  const r = db
    .query(
      `SELECT COUNT(*) AS n, MIN(queued_at) AS oldest,
              (SELECT last_error FROM pending_extraction WHERE last_error IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1) AS err
         FROM pending_extraction`,
    )
    .get() as { n: number; oldest: string | null; err: string | null };
  return { count: r.n, lastError: r.err, oldestQueuedAt: r.oldest };
}

function clear(db: Database, ids: Set<string>): void {
  const del = db.prepare("DELETE FROM pending_extraction WHERE event_id = ?");
  db.transaction(() => {
    for (const id of ids) del.run(id);
  })();
}

function recordFailure(db: Database, ids: Set<string>, error: string): void {
  const now = new Date().toISOString();
  const up = db.prepare(
    "UPDATE pending_extraction SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE event_id = ?",
  );
  db.transaction(() => {
    for (const id of ids) up.run(error, now, id);
  })();
}

/** One line about why the model call failed -- the provider's status and message, keys redacted. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return "AI processing failed";
  const status = (e as { status?: number }).status;
  return `${status ? `${status} ` : ""}${e.message.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]").slice(0, 240)}`;
}

// ---------------------------------------------------------------------------------- retry loop

const lastTried = new Map<string, number>();
const running = new Set<string>();
const RETRY_EVERY_MS = 120_000;

/**
 * Retry this account's waiting captures off the request path, at most every 2 minutes. Called on
 * every authenticated request (the Mac app syncs each minute), so processing resumes on its own
 * within minutes of the AI coming back -- no user action. Failures stay recorded, never thrown.
 */
export function scheduleDeferredRetry(
  userId: string,
  open: (userId: string) => Database,
  providers: PipelineProviders,
  now = Date.now(),
): void {
  if (running.has(userId) || now - (lastTried.get(userId) ?? 0) < RETRY_EVERY_MS) return;
  lastTried.set(userId, now);
  running.add(userId);
  queueMicrotask(async () => {
    let db: Database | null = null;
    try {
      db = open(userId);
      if (deferredStatus(db).count === 0) return;
      const r = await retryDeferredExtraction(db, providers);
      if (r.processed > 0) console.log(`[Thread] resumed extraction for ${userId}: ${r.processed} messages`);
      if (r.error) console.error(`[Thread] extraction still waiting for ${userId}: ${r.error}`);
    } catch (e) {
      console.error(`[Thread] deferred retry failed for ${userId}:`, e);
    } finally {
      db?.close();
      running.delete(userId);
    }
  });
}
