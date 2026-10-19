import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dbPathForUser } from "../db/tenancy";
import { openMetrics } from "./metrics";
import { excludedUserIds } from "./revenue";
import { weekOf } from "./growth";

/**
 * How good are the ideas Thread shows? Measured from what people do with them, week by week:
 *  - kept vs "Not an idea" on ideas Thread served (the keep rate -- precision as people judge it);
 *  - merges (Thread missed that two were the same idea), splits (it wrongly joined two), renames
 *    (the title didn't name the idea);
 *  - coverage: verdicts per new idea -- a keep rate from a handful of clicks means little.
 * Read from each account's own database (exact, nothing copied), cached for 10 minutes.
 *
 * Caveats, shown with the numbers: people judge only what they look at; since 19 Oct 2026 a
 * "Not an idea" on a regrouped idea labels its headline only, so earlier weeks aren't comparable;
 * and while one or two people do most of the judging, this is their taste, not "accuracy".
 */

export interface AccuracyWeek {
  week: string;
  newIdeas: number;
  keeps: number;
  notIdeas: number;
  merges: number;
  splits: number;
  renames: number;
  /** Thought-by-thought reviews (not ideas Thread served) -- teach taste, not counted as keep/not. */
  reviewed: number;
  /** Teach Thread answers: chosen because Thread was unsure, so kept out of the rates above. */
  taught: number;
  /** People who gave at least one verdict that week. */
  judges: number;
}

export interface Accuracy {
  weeks: AccuracyWeek[];
  totals: Omit<AccuracyWeek, "week" | "judges"> & { judges: number };
  /** Share of all verdicts that came from operator/test accounts (THREAD_ADMIN_EMAILS etc.). */
  operatorShare: number | null;
  accountsRead: number;
  comparableFrom: string;
}

const WEEKS = 8;
let cache: { at: number; registry: string; data: Accuracy } | null = null;

export function accuracySummary(now: Date = new Date()): Accuracy {
  // Keyed by the registry it was read from, so a cached answer never outlives a switch of data.
  const registry = process.env.THREAD_REGISTRY_PATH ?? "";
  if (cache && cache.registry === registry && now.getTime() - cache.at < 10 * 60_000) return cache.data;
  const reg = openMetrics();
  let users: string[];
  let operators: Set<string>;
  try {
    users = (reg.query("SELECT id FROM users").all() as { id: string }[]).map((r) => r.id);
    operators = excludedUserIds(reg);
  } finally {
    reg.close();
  }
  const thisWeek = weekOf(now.toISOString());
  const weekList = Array.from({ length: WEEKS }, (_, i) => {
    const d = new Date(thisWeek + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7 * (WEEKS - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  const empty = (): Omit<AccuracyWeek, "week" | "judges"> => ({ newIdeas: 0, keeps: 0, notIdeas: 0, merges: 0, splits: 0, renames: 0, reviewed: 0, taught: 0 });
  const byWeek = new Map(weekList.map((w) => [w, { ...empty(), judges: new Set<string>() }]));
  const first = weekList[0]!;
  let read = 0;
  let verdicts = 0;
  let operatorVerdicts = 0;

  for (const id of users) {
    let db: Database | null = null;
    try {
      const path = dbPathForUser(id);
      if (!existsSync(path)) continue;
      db = new Database(path, { readonly: true });
      read++;
      const bump = (at: string, key: keyof ReturnType<typeof empty>, judged = false) => {
        if (at < first) return;
        const w = byWeek.get(weekOf(at));
        if (!w) return;
        w[key]++;
        if (judged) {
          w.judges.add(id);
          verdicts++;
          if (operators.has(id)) operatorVerdicts++;
        }
      };
      for (const r of db.query("SELECT created_at FROM idea_nodes").all() as { created_at: string }[]) bump(r.created_at, "newIdeas");
      const has = (t: string, col?: string) =>
        col
          ? (db!.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === col)
          : !!db!.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      if (has("idea_verdicts")) {
        const originCol = has("idea_verdicts", "origin");
        for (const r of db.query(`SELECT created_at, ${originCol ? "origin" : "NULL AS origin"} FROM idea_verdicts`).all() as { created_at: string; origin: string | null }[]) {
          if (r.origin === "review") bump(r.created_at, "reviewed");
          else if (r.origin === "lesson") bump(r.created_at, "taught", true);
          else bump(r.created_at, "keeps", true);
        }
      }
      const corrOrigin = has("idea_corrections", "origin");
      for (const r of db.query(`SELECT kind, created_at, ${corrOrigin ? "origin" : "NULL AS origin"} FROM idea_corrections`).all() as { kind: string; created_at: string; origin: string | null }[]) {
        if (r.origin === "lesson" && r.kind !== "rename" && r.kind !== "state") bump(r.created_at, "taught", true);
        else if (r.kind === "not_idea") {
          if (r.origin === "review") bump(r.created_at, "reviewed");
          else bump(r.created_at, "notIdeas", true);
        } else if (r.kind === "merge") bump(r.created_at, "merges", true);
        else if (r.kind === "split") bump(r.created_at, "splits", true);
        else if (r.kind === "rename") bump(r.created_at, "renames", true);
      }
    } catch {
      /* an unreadable or older database: skip it */
    } finally {
      db?.close();
    }
  }

  const weeks: AccuracyWeek[] = weekList.map((w) => {
    const x = byWeek.get(w)!;
    return { week: w, newIdeas: x.newIdeas, keeps: x.keeps, notIdeas: x.notIdeas, merges: x.merges, splits: x.splits, renames: x.renames, reviewed: x.reviewed, taught: x.taught, judges: x.judges.size };
  });
  const sum = (k: keyof ReturnType<typeof empty>) => weeks.reduce((s, w) => s + w[k], 0);
  const allJudges = new Set<string>();
  for (const x of byWeek.values()) for (const j of x.judges) allJudges.add(j);
  const data: Accuracy = {
    weeks,
    totals: { newIdeas: sum("newIdeas"), keeps: sum("keeps"), notIdeas: sum("notIdeas"), merges: sum("merges"), splits: sum("splits"), renames: sum("renames"), reviewed: sum("reviewed"), taught: sum("taught"), judges: allJudges.size },
    operatorShare: verdicts ? operatorVerdicts / verdicts : null,
    accountsRead: read,
    comparableFrom: "2026-10-19",
  };
  cache = { at: now.getTime(), registry, data };
  return data;
}
