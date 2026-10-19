import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { dismissedExamples } from "../mining/corrections";
import { scheduleShadowMining } from "../mining/shadow";
import { applyRetention } from "../db/retention";
import type { CanonicalEvent } from "../types";
import {
  persistCanonicalEvents,
  persistPipelineResult,
  runPipeline,
  snapshotIdeas,
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

/**
 * Backlog pause: accounts listed in THREAD_PAUSE_BACKLOG_USERS (comma-separated user ids, or `*`
 * for everyone) keep their waiting captures in `pending_extraction` but nothing spends AI on
 * them -- neither the background drain nor the "clear the backlog first" step of a live capture.
 * Live captures themselves still extract. Unset the variable and the queue resumes, oldest first,
 * exactly as before. For a large history import you don't want to pay for yet.
 */
export function backlogPaused(db: Database): boolean {
  const raw = process.env.THREAD_PAUSE_BACKLOG_USERS?.trim();
  if (!raw) return false;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.includes("*")) return true;
  const owner = basename(db.filename).replace(/\.db$/, "");
  return ids.includes(owner);
}

/**
 * Coding assistants (Cursor, Claude Code, ...) are read from local history, and each turn re-sends
 * the WHOLE growing session. Extracting after every turn re-reads ~20K tokens each time and, in a
 * live session, mostly finds nothing (measured: ~21K input / ~17 output tokens per call). So their
 * extraction waits for the session to go quiet, then runs once. Browser chats are unaffected.
 * THREAD_AGENT_QUIET_MINUTES: default 10; 0 turns the wait off.
 */
export const AGENT_SOURCES: ReadonlySet<string> = new Set(["cursor", "claude_code", "codex", "gemini_cli", "copilot", "windsurf", "zed"]);

export function agentQuietMs(): number {
  const m = Number(process.env.THREAD_AGENT_QUIET_MINUTES ?? 10);
  return Number.isFinite(m) && m > 0 ? m * 60_000 : 0;
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
  const backlog = deferredStatus(db).count > 0 && !backlogPaused(db) ? await retryUnlocked(db, providers) : null;

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

  // A coding-assistant session that is still ACTIVE (its newest message is within the quiet
  // period) waits to go quiet (see AGENT_SOURCES). It is already marked waiting above; the retry
  // loop picks it up once quiet. A session already quiet -- e.g. history read days later -- runs now.
  const quiet = agentQuietMs();
  if (quiet > 0 && extractIds.size > 0) {
    const byId = new Map(contextEvents.map((e) => [e.id, e]));
    const extracting = [...extractIds].map((id) => byId.get(id)).filter((e): e is CanonicalEvent => e !== undefined);
    const newest = Math.max(...extracting.map((e) => Date.parse(e.createdAt)).filter(Number.isFinite));
    if (extracting.every((e) => AGENT_SOURCES.has(e.source as string)) && Date.now() - newest < quiet) {
      return { result: null, deferred: extractIds.size, error: null };
    }
  }

  // 3. This capture.
  try {
    const existing = new Map(loadIdeas(db).map((i) => [i.id, i]));
    const baseline = snapshotIdeas(existing); // so only the ideas this capture touches are written
    const result = await runPipeline(contextEvents, providers, {
      existingIdeas: existing,
      newEventIds: extractIds,
      dismissed: dismissedExamples(db),
    });
    persistPipelineResult(db, contextEvents, result, baseline);
    clear(db, extractIds);
    // Their ideas exist now; apply the person's retention setting to the text that fed them.
    applyRetention(db);
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
  now: number = Date.now(),
): Promise<{ processed: number; error: string | null; waiting?: number }> {
  return exclusive(db, () => retryUnlocked(db, providers, maxConversations, now));
}

async function retryUnlocked(
  db: Database,
  providers: PipelineProviders,
  maxConversations = 10,
  now: number = Date.now(),
): Promise<{ processed: number; error: string | null; waiting?: number }> {
  const all = db
    .query(
      `SELECT p.conversation_id AS conversation_id, MIN(p.queued_at) AS first,
              (SELECT MAX(e.created_at) FROM canonical_events e WHERE e.conversation_id = p.conversation_id) AS last,
              (SELECT e.source FROM canonical_events e WHERE e.conversation_id = p.conversation_id LIMIT 1) AS source
         FROM pending_extraction p GROUP BY p.conversation_id ORDER BY first`,
    )
    .all() as { conversation_id: string; last: string; source: string | null }[];
  // A coding-assistant session whose newest message is recent is still active: it waits (AGENT_SOURCES).
  const quiet = agentQuietMs();
  let waiting = 0;
  const convs = all
    .filter((c) => {
      if (quiet > 0 && AGENT_SOURCES.has(c.source ?? "") && now - Date.parse(c.last) < quiet) {
        waiting++;
        return false;
      }
      return true;
    })
    .slice(0, maxConversations);
  if (convs.length === 0) return { processed: 0, error: null, ...(waiting ? { waiting } : {}) };
  let processed = 0;
  for (const { conversation_id } of convs) {
    const ids = new Set(
      (db.query("SELECT event_id FROM pending_extraction WHERE conversation_id = ?").all(conversation_id) as {
        event_id: string;
      }[]).map((r) => r.event_id),
    );
    const context = loadCanonicalEvents(db, conversation_id);
    // Rows whose event vanished (a provisional event later retracted) have nothing to extract.
    const live = new Set([...ids].filter((id) => context.some((e) => e.id === id && e.status === "committed")));
    if (live.size === 0) {
      clear(db, ids);
      continue;
    }
    try {
      const existing = new Map(loadIdeas(db).map((i) => [i.id, i]));
      const baseline = snapshotIdeas(existing);
      const result = await runPipeline(context, providers, {
        existingIdeas: existing,
        newEventIds: live,
        dismissed: dismissedExamples(db),
      });
      persistPipelineResult(db, context, result, baseline);
      clear(db, ids);
      applyRetention(db);
      processed += live.size;
    } catch (e) {
      const error = describe(e);
      recordFailure(db, ids, error);
      return { processed, error };
    }
  }
  return { processed, error: null, ...(waiting ? { waiting } : {}) };
}

/**
 * Work through the whole backlog, a few conversations at a time, until it's empty, the AI fails
 * again, or the time budget runs out. Each batch takes the per-account lock separately, so a
 * live capture slips in between batches instead of waiting behind a long import. This is what
 * turns a 500-conversation history import into ideas in minutes rather than hours.
 */
export async function drainDeferredExtraction(
  db: Database,
  providers: PipelineProviders,
  budgetMs = 240_000,
  batch = 5,
  now: () => number = Date.now,
): Promise<{ processed: number; error: string | null; remaining: number }> {
  const deadline = now() + budgetMs;
  let processed = 0;
  let error: string | null = null;
  while (now() < deadline) {
    const r = await retryDeferredExtraction(db, providers, batch, now());
    processed += r.processed;
    if (r.error) {
      error = r.error;
      break;
    }
    if (deferredStatus(db).count === 0) break;
    // Only coding-assistant sessions that are still active are left: nothing more to do until they
    // go quiet. (Without this the loop would spin until the time budget ran out.)
    if (r.waiting && r.processed === 0) break;
  }
  return { processed, error, remaining: deferredStatus(db).count };
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
 * Retry this account's waiting captures off the request path (a drain of up to 4 minutes, then at
 * most one new drain every 2 minutes). Called on every authenticated request (the Mac app syncs
 * each minute), so processing resumes on its own within minutes of the AI coming back -- no user
 * action. Failures stay recorded, never thrown.
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
      if (deferredStatus(db).count === 0 || backlogPaused(db)) return;
      const r = await drainDeferredExtraction(db, providers);
      if (r.processed > 0) {
        console.log(`[Thread] resumed extraction for ${userId}: ${r.processed} messages, ${r.remaining} left`);
        scheduleShadowMining(userId, open); // new thoughts: regroup, as after a live capture
      }
      if (r.error) console.error(`[Thread] extraction still waiting for ${userId}: ${r.error}`);
    } catch (e) {
      console.error(`[Thread] deferred retry failed for ${userId}:`, e);
    } finally {
      db?.close();
      running.delete(userId);
    }
  });
}
