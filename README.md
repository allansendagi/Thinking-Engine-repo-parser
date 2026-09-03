# Thinking Engine (V0.1)

The Thinking Reconstruction Engine for Thread. This is the hard gate: before any capture layer,
browser extension, or human UI gets built, this has to prove it can reconstruct how a person's
ideas actually evolved -- accurately enough that they'd trust it over searching their own chat
history.

See the parent product spec (`THREAD.md` in the `mind-stream-continuity` repo) for the full
architecture. This repo covers: **parse -> extract -> resolve identity -> build idea state ->
Thinking State -> MCP access**. Explicitly not here: a human UI (side panel), browser/desktop
capture, and Postgres/pgvector (SQLite for now, by design -- see below).

## The gate

Agreed thresholds, scored separately:

| Metric | Threshold |
|---|---|
| Idea-attribution precision | >= 90% |
| Idea-attribution recall | >= 80% |
| Identity-resolution precision | >= 95% |
| Provenance accuracy | >= 98% |
| Hallucinated attribution rate | < 2% |

Precision matters more than recall: a false attribution destroys trust in a way a missed one
doesn't.

**The gate is still unmeasured.** `eval/cases/authority-payments` is a small, hand-authored case
(~5 substantive events) that proves the pipeline's *mechanics* -- branch resolution, grounding,
the authority/payments non-merge, candidate narrowing -- not that the gate is met at a
statistically meaningful sample size. `bun run eval` now runs every case under `eval/cases/*` and
micro-averages the metrics, so closing this gap is a matter of hand-labelling 50-100
conversations' worth of a real ChatGPT export and dropping them in as cases -- see
`eval/README.md` for the labelling schema. Until then every gate number is a mechanics smoke
test, not a measurement.

## What's verified vs. what isn't

This matters more than a features list. Split by what can be checked without a live API call:

**Verified** (25 tests, `bun test`, zero API key, zero network calls):
- Branch resolution on the fixture's hand-crafted edited-message branch (abandoned branch
  excluded, correct text kept, correct per-conversation ordering)
- Cyclical-mapping guard (throws instead of infinite-looping)
- Lexical / entity / temporal signal functions, and that a cross-topic vocabulary-overlap idea
  survives candidate narrowing among 30 distractors (the specific case that must not be silently
  excluded -- see "Why identity resolution is the gate" below)
- The merge-threshold behavior in `buildIdeaNode` (never merges below threshold even when a
  `matchedIdeaId` is set; decisions flip state and record a `Decision`; connections link two
  ideas symmetrically without merging them)
- `ThinkingState` aggregation (current ideas, decisions, open loops, contradictions by source
  event type, recency window, topic filtering, related-ideas-outside-the-filtered-set)
- The full pipeline end-to-end via `FakeProvider` (scripted JSON, no network): a new idea
  correctly threading through a refinement and a decision; an unrelated event correctly *not*
  triggering an identity-resolution call at all (empty candidate set); a fabricated evidence
  quote correctly rejected by the grounding check, not silently kept
- The MCP tool logic (`search_ideas`, `get_idea`, `trace_idea`, `get_thread_state`,
  `get_open_loops`, `get_recent_changes`) against a real persisted SQLite database -- this is
  also how a real bug got caught: `persistPipelineResult` was inserting `identity_resolutions`
  before `idea_nodes`, tripping the foreign key. Fixed; the test is what caught it, not review.

**Not verified** (needs a live API key):
- Whether extraction actually produces good cognitive events from real conversation text
- Whether identity resolution's *judgment* is any good -- the tests above prove the pipeline
  correctly *applies* whatever the model decides (including a scripted "this is not the same
  idea" response), not that a real model would decide correctly
- `continue_thinking` (the one MCP tool that needs synthesis, not just retrieval)
- The MCP server's protocol wiring (`src/mcp/server.ts`) against a real MCP client -- the tool
  *logic* is tested directly against SQLite (see above); the SDK call shapes in the thin wiring
  file have not been exercised
- The gate itself, at any sample size

To get real numbers: put `ANTHROPIC_API_KEY` in `.env` and run `bun run eval`.

## Why identity resolution is the gate, not extraction

Knowing that a statement made three weeks later in a different conversation is a refinement of an
existing idea -- and *not* a coincidentally similar idea from an unrelated project -- is hard, and
wrong in a way that's difficult to notice from outside (a bad merge silently corrupts an idea's
history). So the pipeline is conservative by construction:

1. **Candidate narrowing is deterministic and generous** (`src/identity/signals.ts`): lexical
   overlap, entity overlap, temporal proximity, and a mild relationship prior narrow the full
   idea set before the model ever sees it -- this is what makes the approach scale past a handful
   of ideas, per THREAD.md §9/§12's multi-signal description. It leans toward including too much
   rather than too little: a false positive here just means the model correctly rejects a
   candidate; a false negative means the model never gets the chance. A semantic (embeddings)
   signal slot exists in the same ranker but is unconfigured -- Anthropic doesn't serve
   embeddings, so this needs a separate provider decision (Voyage AI, OpenAI, etc.) before it can
   be enabled. See `src/providers/embeddings.ts`.
2. **The model makes the final call**, but only over the narrowed set, and returns a raw
   confidence separate from any merge decision.
3. **`applyCognitiveEvent` only merges above `IDENTITY_RESOLUTION_MERGE_THRESHOLD`** (0.75).
   Below that, the event always becomes a new idea, regardless of what the model returned. A
   missed merge leaves a correctable duplicate; a wrong merge corrupts an idea's history and is
   much harder to catch.

## The branch-resolution landmine

ChatGPT's export stores each conversation as a tree (`mapping`: node id ->
`{message, parent, children}`), not a list -- regenerated responses and edited messages create
sibling branches off the same parent. Only the path ending at `current_node` is the conversation
the user actually kept. `src/parser/chatgpt.ts` walks that path explicitly; flattening by
timestamp instead would feed abandoned branches into extraction as if the user had actually said
them, indistinguishable downstream from genuine idea-forks.

## Pipeline

```
conversations.json (export format)
        |
        v  src/parser/chatgpt.ts          (branch resolution)
CanonicalEvent[]
        |
        v  src/extraction/extract.ts      (fast provider, per-conversation, grounding check)
CognitiveEvent[]
        |
        v  src/identity/signals.ts        (deterministic candidate narrowing)
        v  src/identity/resolve.ts        (strong provider, chronological across ALL conversations)
IdentityResolution[]
        |
        v  src/state/buildIdeaNode.ts     (merge-threshold applied here)
IdeaNode[] (evolution, open loops, decisions, related ideas)
        |
        v  src/db                         (SQLite; schema mirrors the eventual Postgres shape)
        v  src/state/thinkingState.ts     (pure aggregation view, computed on demand)
        v  src/mcp/                       (read tools + continue_thinking over the same state)
```

Every LLM call goes through `CompletionProvider` (`src/providers/types.ts`), never the SDK
directly -- `AnthropicProvider` is one implementation, `FakeProvider` (scripted responses, used
throughout the test suite) is another. Extraction uses the fast/cheap model tier, identity
resolution and `continue_thinking` use the strong tier (`src/providers/anthropic.ts`), per
THREAD.md §15. Model IDs are read from env with fallbacks that have **not** been verified against
a live call in this environment -- check them against current Anthropic API docs first.

## MCP

`bun run mcp` starts a stdio MCP server exposing `search_ideas`, `get_idea`, `trace_idea`,
`get_thread_state`, `get_open_loops`, `get_recent_changes`, and `continue_thinking` over
`THREAD_DB_PATH` (default `data/thread.db`). The first six are pure reads and need no model call;
`continue_thinking` does. As noted above, the protocol wiring itself hasn't been run against a
real MCP client -- verify with one (Claude Desktop, the MCP inspector) before relying on it.

## Setup

```
bun install
cp .env.example .env   # add your ANTHROPIC_API_KEY (zero-retention tier)
bun test                # verifies everything that doesn't need a key -- do this first
bun run eval            # needs a key; produces the real gate numbers
bun run mcp              # starts the MCP server against data/thread.db
```

## Storage

SQLite (`bun:sqlite`, zero external dependencies) for V0.1, not Postgres + pgvector. The schema in
`src/db/schema.sql` mirrors `src/types.ts` so migrating later is a lift-and-shift once the
approach is actually validated -- no point standing up Postgres before knowing if identity
resolution clears the gate.

## What's deliberately not here

- **Human UI (side panel, THREAD.md §23).** A separate frontend surface; out of scope for this
  repo, and the spec's own build order (§34) puts it in Phase 1, after the engine is proven.
- **Browser/desktop capture (§19-20).** Same reasoning -- capture is deferred until the engine
  is proven; this repo is import-only.
- **Postgres + pgvector.** SQLite until the approach is validated (see Storage above).
- **A live embeddings provider.** The semantic-similarity slot in identity resolution exists
  structurally (`src/providers/embeddings.ts`) but is unconfigured -- needs a provider decision
  Anthropic can't fulfill.
- **Real ChatGPT export ingestion.** The parser is ready and tested against the fixture; no real
  export has been run through it yet.
- **Claude export parsing.** Needed for the cross-model identity-resolution case (harder than
  same-model evolution -- different lexical style, no shared IDs). Only ChatGPT's export format
  is supported so far.
- **Query understanding / multi-signal *recovery* retrieval (THREAD.md §11-12) as a full system.**
  `get_thread_state`'s topic filter is a plain substring match, not the semantic + lexical +
  entity + temporal + relationship ensemble the spec describes for recovery -- that's the same
  missing embeddings signal, applied to a different part of the pipeline.
