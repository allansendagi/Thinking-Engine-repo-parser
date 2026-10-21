#!/usr/bin/env bun
/**
 * Live extraction experiment: does asking the extraction model for SELF-CONTAINED statements make
 * ideas group better? Production's own path -- one extractCognitiveEvents call per conversation with
 * the real extraction model -- then the same Voyage grouping and the same scoring as the bench.
 *
 *   railway run -- sh -c 'cd <checkout> && bun src/bench/liveExtract.ts --seeds tuned --variant baseline --label A1'
 *
 *   --seeds tuned|held        which scenarios (tuned = seeds 1-3, held = 4-11)
 *   --variant baseline|self|resolve|link   today's prompt; plus the self-contained rule; with a
 *                             precise definition of "resolution"; or asking the model to NAME the
 *                             earlier question an event answers (answers_event_id)
 *   --limit N                 only the first N scenarios (a smoke test)
 *   --label NAME              cache + report name (a repeated label resumes from its cache, free)
 *
 * COST GUARD: every model call is metered from the API's real token usage at conservative prices and
 * added to a ledger on disk (eval/out/live-spend.json). Before every call the ledger is checked
 * against LIVE_BUDGET_USD (default 4.00) and the run STOPS rather than spend past it. Cached results
 * cost nothing. Needs ANTHROPIC_API_KEY and VOYAGE_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractCognitiveEvents } from "../extraction/extract";
import { consolidate } from "../mining/consolidate";
import type { MiningThought } from "../mining/consolidate";
import { VoyageEmbeddingProvider } from "../providers/voyage";
import type { CompleteOptions, CompletionProvider } from "../providers/types";
import type { CanonicalEvent, CognitiveEvent } from "../types";
import { standardSuite } from "./generate";
import { v2Miner } from "./miners";
import { formatTable, runBench } from "./run";
import type { Scenario } from "./types";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const seedSet = arg("seeds", "tuned");
const variant = arg("variant", "baseline");
const label = arg("label", `${variant}-${seedSet}`);
const BUDGET = Number(process.env.LIVE_BUDGET_USD ?? "4.00");
const MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001"; // what production extracts with

// ---- spend ledger (persisted across processes so the cap is for the whole experiment) -----------
mkdirSync("eval/out", { recursive: true });
const LEDGER = "eval/out/live-spend.json";
const ledger: { usd: number; calls: number } = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf-8")) : { usd: 0, calls: 0 };
// $ per million tokens for Haiku 4.5, then +30% so the estimate errs high.
const PRICE = { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };
const SAFETY = 1.3;
class BudgetStop extends Error {}

function usd(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const m = 1e-6 * SAFETY;
  return (
    (u.input_tokens ?? 0) * PRICE.input * m +
    (u.output_tokens ?? 0) * PRICE.output * m +
    (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead * m +
    (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite * m
  );
}

const SELF_CONTAINED = `- Make every statement SELF-CONTAINED. Someone who reads only the statement, with no other message, must be able to tell what it is about. Name the subject explicitly: never leave "it", "that", "this", "the second one", "the first option", "the other approach", "same here" or any pointer to an earlier message standing alone -- replace each with what it refers to, in the words used earlier in the conversation. Keep the person's own voice and never add a fact that is not in the conversation. Example: if the AI proposed "a SOC 2 Type I audit" and the human replies "Yes, start with that", write "Begin the SOC 2 Type I audit now." -- not "Start with that." The evidence_quote must still be copied verbatim from the human's message; only the statement is made self-contained.

`;

const RESOLUTION_OLD = "- resolution: an open question that gets resolved";
const RESOLUTION_NEW = `- resolution: the human ANSWERS a question that was asked earlier in this transcript, by the human or by the AI ("Answer: the extension reads it straight from the site", "Settled the guest thing -- five free per account", "Got it, we pull it through the extension"). If a message both decides something and answers an earlier question, it is a resolution, not a decision. Use decision only for a choice that does not answer an earlier question, and new_idea only for something not already raised in this transcript.`;

const LINK_RULE = `- ANSWERS. When an event answers a question the human asked earlier in this transcript -- whatever its type (an answer often reads as a decision or a claim: "Settled: five free guests per account", "Answer: the extension reads it directly") -- set "answers_event_id" to the id of the human's message where they asked that question, copied exactly from the ids shown below. Only the human's own question, and only from an earlier message. If the AI asked it, or you are not sure which question it answers, omit it. A question never has answers_event_id.

`;
const SHAPE_OLD = '"adopted_quote": "... (adoption only)"}]}';
const SHAPE_NEW = '"adopted_quote": "... (adoption only)", "answers_event_id": "... (answers only, optional)"}]}';

/** The real model, the real prompt (optionally plus one rule), metered and capped. */
class MeteredProvider implements CompletionProvider {
  private readonly client = new Anthropic();
  calls = 0;
  spent = 0;
  async complete(system: string, user: string, maxTokens: number, options?: CompleteOptions): Promise<string> {
    if (ledger.usd >= BUDGET) throw new BudgetStop(`budget reached: $${ledger.usd.toFixed(3)} of $${BUDGET.toFixed(2)}`);
    const sys =
      variant === "self"
        ? system.replace("Respond with JSON matching this shape exactly", `${SELF_CONTAINED}Respond with JSON matching this shape exactly`)
        : variant === "resolve"
          ? system.replace(RESOLUTION_OLD, RESOLUTION_NEW)
          : variant === "link" && !system.includes("answers_event_id")
            ? system.replace("Respond with JSON matching this shape exactly", `${LINK_RULE}Respond with JSON matching this shape exactly`).replace(SHAPE_OLD, SHAPE_NEW)
            : system;
    if (variant === "link" && !sys.includes("answers_event_id\": \"... (answers only")) throw new Error("could not add the answers_event_id field to the prompt shape");
    // (once the production prompt carries the link rule, "link" is the same as "baseline")
    if (variant !== "baseline" && variant !== "link" && sys === system) throw new Error(`could not place the ${variant} change in the prompt`);
    const n = options?.cachePrefixChars ?? 0;
    const content =
      n > 0 && n < user.length
        ? [{ type: "text" as const, text: user.slice(0, n), cache_control: { type: "ephemeral" as const } }, { type: "text" as const, text: user.slice(n) }]
        : user;
    const res = await this.client.messages.create({ model: MODEL, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content }] });
    const cost = usd(res.usage);
    ledger.usd += cost;
    ledger.calls += 1;
    this.calls += 1;
    this.spent += cost;
    writeFileSync(LEDGER, JSON.stringify(ledger));
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("no text block");
    return block.text;
  }
}

// ---- extraction, cached per conversation -----------------------------------------------------------
const CACHE = `eval/out/live-extract.${label}.json`;
const cache: Record<string, CognitiveEvent[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf-8")) : {};
const provider = new MeteredProvider();
let rejectedTotal = 0;

async function extractedFor(s: Scenario): Promise<CognitiveEvent[]> {
  const byConv = new Map<string, CanonicalEvent[]>();
  for (const e of s.events) byConv.set(e.conversationId, [...(byConv.get(e.conversationId) ?? []), e]);
  const out: CognitiveEvent[] = [];
  for (const [conv, events] of byConv) {
    const key = `${s.name}|${conv}`;
    if (!cache[key]) {
      const ordered = [...events].sort((a, b) => a.index - b.index);
      const r = await extractCognitiveEvents(ordered, provider);
      rejectedTotal += r.rejected.length;
      cache[key] = r.events;
      writeFileSync(CACHE, JSON.stringify(cache));
    }
    out.push(...cache[key]!);
  }
  return out;
}

const limit = Number(arg("limit", "0"));
const all = standardSuite(seedSet === "held" ? [4, 5, 6, 7, 8, 9, 10, 11] : [1, 2, 3]);
const scenarios = limit > 0 ? all.slice(0, limit) : all;
const extracted = new Map<string, CognitiveEvent[]>();
let stopped: string | null = null;
for (const s of scenarios) {
  try {
    extracted.set(s.name, await extractedFor(s));
  } catch (e) {
    if (e instanceof BudgetStop) { stopped = e.message; break; }
    throw e;
  }
  process.stderr.write(`  ${s.name}: ${extracted.get(s.name)!.length} thoughts  (spent $${ledger.usd.toFixed(3)})\n`);
}
if (stopped) {
  console.log(`STOPPED: ${stopped}. ${extracted.size}/${scenarios.length} scenarios extracted; nothing scored.`);
  process.exit(2);
}

// ---- group the extracted statements exactly as production does, and score on the bench ----------
const texts = [...new Set([...extracted.values()].flat().map((e) => e.statement))];
const vecCache = "eval/out/live-voyage-cache.json";
const vectors = new Map<string, number[]>(existsSync(vecCache) ? Object.entries(JSON.parse(readFileSync(vecCache, "utf-8"))) : []);
const need = texts.filter((t) => !vectors.has(t));
if (need.length) {
  const voyage = new VoyageEmbeddingProvider();
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    const out = await voyage.embedMany(batch);
    batch.forEach((t, j) => vectors.set(t, out[j]!.map((x) => Math.round(x * 1e4) / 1e4)));
  }
  writeFileSync(vecCache, JSON.stringify(Object.fromEntries(vectors)));
}

const thoughtsOf = (s: Scenario): MiningThought[] => {
  const evById = new Map(s.events.map((e) => [e.id, e]));
  return extracted
    .get(s.name)!
    .filter((e) => e.persistence !== "low") // the server never lets low-persistence thoughts seed or join ideas
    .map((e, i) => {
      const src = evById.get(e.sourceEventId)!;
      return {
        id: `cog_${e.sourceEventId}_${i}`,
        type: e.type,
        statement: e.statement,
        persistence: e.persistence as MiningThought["persistence"],
        sourceEventId: e.sourceEventId,
        conversationId: src.conversationId,
        position: src.index,
        createdAt: src.createdAt,
        role: e.role,
        adopted: !!e.adoptedFrom,
        answersEventId: e.answersEventId,
      };
    });
};

const miner = v2Miner(`live extraction [${label}] + Voyage grouping`, vectors, { thoughts: thoughtsOf });
// the ceiling (answer-key thoughts) needs the bench's own vectors (gold texts), which this run did not embed
const gold = JSON.parse(readFileSync(new URL("./vectors.voyage.json", import.meta.url), "utf-8")).vectors as Record<string, number[]>;
const goldMiner = v2Miner("answer-key thoughts + Voyage (the ceiling)", new Map(Object.entries(gold)));
const results = await runBench([miner, goldMiner], scenarios);
console.log(formatTable(results));
const nThoughts = [...extracted.values()].reduce((n, e) => n + e.length, 0);
const goldThoughts = scenarios.reduce((n, s) => n + s.thoughts.length, 0);
console.log(`\n[${label}] variant=${variant} seeds=${seedSet}: extracted ${nThoughts} thoughts vs ${goldThoughts} gold; ${provider.calls} model calls this run ($${provider.spent.toFixed(3)}); experiment total $${ledger.usd.toFixed(3)} of $${BUDGET.toFixed(2)}; grounding rejected ${rejectedTotal}`);
writeFileSync(`eval/out/live-report.${label}.json`, JSON.stringify({ label, variant, seedSet, results, nThoughts, goldThoughts, spent: ledger.usd }, null, 2));
