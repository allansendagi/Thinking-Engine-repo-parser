import type { Database } from "bun:sqlite";
import { lexicalOverlap } from "../identity/signals";
import type { CompletionProvider } from "../providers/types";
import { isPersonTitle } from "../state/buildIdeaNode";

/**
 * The tidy pass: the two things the extractor gets wrong often enough to show, fixed for every
 * account, after its ideas are regrouped.
 *
 *  1. QUESTIONS. Each question (and open loop) is reviewed once. Narration ("The user is asking
 *     what...") is rewritten as the person's own question; a request for information or an
 *     instruction to the AI ("What is the user's opinion on X?", "What should the next question
 *     be?") is set aside -- marked low persistence, so it never joins an idea -- not deleted. The
 *     original wording is kept in `statement_original`.
 *  2. NAMES. Every served idea the extractor never named gets a 2-5 word name, stored by its
 *     founding thought so it survives every regroup.
 *
 * A rewrite is only accepted when it keeps the original's words (it must rephrase, not change the
 * thought). Every call is charged against one spending cap across all accounts
 * (THREAD_TIDY_BUDGET_USD); with no cap set the pass does nothing.
 */

/** claude-haiku-4-5 list prices, USD per million tokens. Conservative for cheaper models. */
const PRICE_IN = 1;
const PRICE_OUT = 5;
/** Small batches with room to answer: a cut-off reply loses the whole batch. */
const QUESTION_BATCH = 15;
const NAME_BATCH = 20;

export interface TidyBudget {
  /** Dollars still available; the pass stops before a call when this is spent. */
  remaining(): number;
  charge(usd: number): void;
}

/** A cap kept in the registry database, shared by every account and every restart. */
export function registryBudget(reg: Database, capUsd: number): TidyBudget {
  reg.exec("CREATE TABLE IF NOT EXISTS ai_budget (purpose TEXT PRIMARY KEY, spent_usd REAL NOT NULL)");
  const spent = () => (reg.query("SELECT spent_usd FROM ai_budget WHERE purpose = 'tidy'").get() as { spent_usd: number } | null)?.spent_usd ?? 0;
  return {
    remaining: () => Math.max(0, capUsd - spent()),
    charge: (usd) =>
      reg.prepare("INSERT INTO ai_budget (purpose, spent_usd) VALUES ('tidy', ?) ON CONFLICT(purpose) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd").run(usd),
  };
}

const QUESTION_SYSTEM = `You tidy questions a person asked while thinking with an AI. For each item decide:
- "keep": is it a question the PERSON is genuinely trying to settle in their own thinking? false for requests for information or explanation ("What is X about?", "Can you explain Y?"), questions about the person themselves written by an observer ("What is the user's opinion on X?"), and instructions or meta-questions to the AI ("What should the next question be?", "Can you format this?").
- "text": only when keep is true and the item is written ABOUT the person ("The user is asking whether...", "They wonder how..."), rewrite it as the person's own direct question, same meaning, same key words, nothing added. Otherwise omit "text".
Reply with JSON only: {"items":[{"id":"...","keep":true|false,"text":"... (optional)"}]}`;

const NAME_SYSTEM = `You name ideas. For each idea, give a 2-5 word noun phrase that names it the way a person would file it: specific, no trailing punctuation, not a sentence, no "The user", no "I". Use the person's own key terms.
Reply with JSON only: {"items":[{"id":"...","name":"..."}]}`;

/** The reply's items; from a reply cut off mid-way, every item that arrived whole. */
export function parseItems<T>(raw: string): T[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]) as { items?: T[] };
      if (Array.isArray(v.items)) return v.items;
    } catch {
      /* fall through to salvage */
    }
  }
  const out: T[] = [];
  for (const piece of raw.match(/\{[^{}]*"id"[^{}]*\}/g) ?? []) {
    try {
      out.push(JSON.parse(piece) as T);
    } catch {
      /* a fragment */
    }
  }
  return out;
}

async function call(provider: CompletionProvider, budget: TidyBudget, system: string, user: string, maxTokens: number): Promise<string | null> {
  // Worst case for this call, so one call can't overshoot the cap.
  const worst = ((system.length + user.length) / 3 / 1e6) * PRICE_IN + (maxTokens / 1e6) * PRICE_OUT;
  if (budget.remaining() < worst) return null;
  let usage = { input: 0, output: 0 };
  const text = await provider.complete(system, user, maxTokens, { onUsage: (u) => (usage = u) });
  budget.charge((usage.input / 1e6) * PRICE_IN + (usage.output / 1e6) * PRICE_OUT);
  return text;
}

export interface TidyResult {
  reviewed: number;
  rewritten: number;
  setAside: number;
  named: number;
  stoppedByBudget: boolean;
}

/** A rewrite must be the same thought: it keeps most of the original's words. */
export function acceptableRewrite(original: string, rewrite: string): boolean {
  const r = rewrite.trim();
  if (r.length < 8 || r.length > original.length * 1.5 + 20) return false;
  if (isPersonTitle(r) || /\bthe user\b/i.test(r)) return false;
  return lexicalOverlap(original, r) >= 0.35;
}

export async function tidyAccount(db: Database, provider: CompletionProvider, budget: TidyBudget): Promise<TidyResult> {
  const result: TidyResult = { reviewed: 0, rewritten: 0, setAside: 0, named: 0, stoppedByBudget: false };

  // 1. Questions, never reviewed before.
  const pending = db
    .query(
      `SELECT id, statement, 'cognitive_events' AS tbl FROM cognitive_events WHERE type IN ('question','open_loop') AND tidied = 0
       UNION ALL
       SELECT id, statement, 'discarded_events' AS tbl FROM discarded_events WHERE type IN ('question','open_loop') AND tidied = 0
         AND id NOT IN (SELECT id FROM cognitive_events)`,
    )
    .all() as { id: string; statement: string; tbl: "cognitive_events" | "discarded_events" }[];
  for (let i = 0; i < pending.length; i += QUESTION_BATCH) {
    const batch = pending.slice(i, i + QUESTION_BATCH);
    const raw = await call(provider, budget, QUESTION_SYSTEM, JSON.stringify(batch.map(({ id, statement }) => ({ id, text: statement }))), 150 * batch.length + 300);
    if (raw === null) {
      result.stoppedByBudget = true;
      break;
    }
    const verdicts = new Map(parseItems<{ id: string; keep?: boolean; text?: string }>(raw).map((v) => [v.id, v]));
    db.transaction(() => {
      for (const q of batch) {
        const v = verdicts.get(q.id);
        if (!v) {
          // Not answered (a cut-off or malformed reply): marked as tried, never retried, so a
          // bad reply can't make every later pass pay for the same questions again.
          db.prepare(`UPDATE ${q.tbl} SET tidied = -1 WHERE id = ?`).run(q.id);
          continue;
        }
        if (v.keep === false) {
          db.prepare(`UPDATE ${q.tbl} SET persistence = 'low', persistence_reason = 'tidy: a request for information, not a question the person is settling', tidied = 1 WHERE id = ?`).run(q.id);
          result.setAside++;
        } else if (v.text && v.text.trim() !== q.statement.trim() && acceptableRewrite(q.statement, v.text)) {
          db.prepare(`UPDATE ${q.tbl} SET statement_original = COALESCE(statement_original, statement), statement = ?, tidied = 1 WHERE id = ?`).run(v.text.trim(), q.id);
          result.rewritten++;
        } else {
          db.prepare(`UPDATE ${q.tbl} SET tidied = 1 WHERE id = ?`).run(q.id);
        }
        result.reviewed++;
      }
    })();
  }

  // 2. Names for served ideas the extractor never named and the person never renamed.
  if (!result.stoppedByBudget) {
    const unnamed = db
      .query(
        `SELECT i.id, i.title, i.current_formulation,
                (SELECT es.cognitive_event_id FROM evolution_steps es WHERE es.idea_id = i.id ORDER BY es.created_at, es.cognitive_event_id LIMIT 1) AS founder
           FROM idea_nodes i
          WHERE i.id NOT IN (SELECT DISTINCT idea_id FROM idea_corrections WHERE kind = 'rename')`,
      )
      .all() as { id: string; title: string; current_formulation: string; founder: string | null }[];
    const named = new Set((db.query("SELECT founder_thought_id FROM idea_names").all() as { founder_thought_id: string }[]).map((r) => r.founder_thought_id));
    const modelTitled = new Set((db.query("SELECT id FROM cognitive_events WHERE title IS NOT NULL").all() as { id: string }[]).map((r) => r.id));
    const todo = unnamed.filter((i) => i.founder && !named.has(i.founder) && !modelTitled.has(i.founder));
    for (let i = 0; i < todo.length; i += NAME_BATCH) {
      const batch = todo.slice(i, i + NAME_BATCH);
      const raw = await call(provider, budget, NAME_SYSTEM, JSON.stringify(batch.map((x) => ({ id: x.id, idea: x.current_formulation, currently: x.title }))), 40 * batch.length + 300);
      if (raw === null) {
        result.stoppedByBudget = true;
        break;
      }
      const names = new Map(parseItems<{ id: string; name?: string }>(raw).map((v) => [v.id, (v.name ?? "").trim().replace(/[.?!]+$/, "")]));
      const now = new Date().toISOString();
      db.transaction(() => {
        for (const x of batch) {
          const n = names.get(x.id);
          const words = n ? n.split(/\s+/).length : 0;
          if (!n || words < 1 || words > 6 || isPersonTitle(n)) {
            // Tried once; an empty name is never used as a title and stops a retry.
            db.prepare("INSERT OR IGNORE INTO idea_names (founder_thought_id, name, named_at) VALUES (?, '', ?)").run(x.founder!, now);
            continue;
          }
          db.prepare("INSERT OR REPLACE INTO idea_names (founder_thought_id, name, named_at) VALUES (?, ?, ?)").run(x.founder!, n, now);
          db.prepare("UPDATE idea_nodes SET title = ? WHERE id = ?").run(n, x.id);
          result.named++;
        }
      })();
    }
  }
  return result;
}
