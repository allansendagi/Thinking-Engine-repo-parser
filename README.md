# Thinking Engine (V0.1)

The Thinking Reconstruction Engine for Thread. This is the hard gate: before any capture layer,
browser extension, MCP server, or UI gets built, this has to prove it can reconstruct how a
person's ideas actually evolved -- accurately enough that they'd trust it over searching their
own chat history.

See the parent product spec (`THREAD.md` in the `mind-stream-continuity` repo) for the full
architecture. This repo is deliberately narrow: **parse -> extract -> resolve identity -> build
idea state -> eval**. No capture, no MCP, no UI, no Postgres yet.

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
doesn't. Identity resolution is treated as the highest-risk piece in the whole pipeline --
everything downstream (evolution, recovery, "continue my thinking") is only as good as knowing
that *this* statement is a refinement of *that* one, not a new idea, not an unrelated idea from a
different project that happens to share vocabulary.

**Important caveat:** `eval/fixture` is a small, hand-authored fixture (~6 substantive events). It
proves the pipeline's *mechanics* work -- branch resolution, grounding, the authority/payments
non-merge -- not that the gate is actually met at a statistically meaningful sample size. The gate
numbers only mean something once this runs against a real export at the 50-100 conversation scale.
Run `bun run eval` against the fixture now; re-run it against a real export once one is available
and treat *that* run as the real result.

## Why identity resolution is the gate, not extraction

An LLM extracting "the user proposed an idea here" is comparatively easy. Knowing that a
statement made three weeks later in a different conversation is a refinement of that same idea --
and *not* a coincidentally similar idea from an unrelated project -- is genuinely hard, and wrong
in a way that's hard to notice from the outside (a bad merge silently corrupts an idea's history).
So the pipeline is conservative by construction: `resolveIdentity` returns a raw confidence
alongside its match/non-match decision, and `applyCognitiveEvent`
(`src/state/buildIdeaNode.ts`) only merges into an existing idea above
`IDENTITY_RESOLUTION_MERGE_THRESHOLD` (0.75). Below that, the event always becomes a new idea. A
missed merge just leaves a duplicate a human can correct later; a wrong merge corrupts the idea's
history and is much harder to catch.

## The branch-resolution landmine

ChatGPT's export stores each conversation as a tree (`mapping`: node id ->
`{message, parent, children}`), not a list -- regenerated responses and edited messages create
sibling branches off the same parent. Only the path ending at `current_node` is the conversation
the user actually kept. `src/parser/chatgpt.ts` walks that path explicitly; flattening by
timestamp instead would feed abandoned branches into extraction as if the user had actually said
them, and those near-duplicate abandoned turns are indistinguishable from genuine idea-forks
downstream. The fixture includes a hand-crafted edited-message branch specifically to test this
(`eval/fixture/conversations.json`, `conv_1`) -- the eval harness fails loudly if an excluded node
leaks through.

## Pipeline

```
conversations.json (export format)
        |
        v  src/parser/chatgpt.ts        (branch resolution)
CanonicalEvent[]
        |
        v  src/extraction/extract.ts    (per-conversation, Claude + Zod, grounding check)
CognitiveEvent[]
        |
        v  src/identity/resolve.ts      (per-event, chronological across ALL conversations)
IdentityResolution[]
        |
        v  src/state/buildIdeaNode.ts   (merge-threshold applied here)
IdeaNode[] (with evolution, open loops)
        |
        v  src/db  (SQLite for V0.1 -- schema mirrors the eventual Postgres shape)
```

## Setup

```
bun install
cp .env.example .env   # add your ANTHROPIC_API_KEY (zero-retention tier)
bun run eval
```

## Storage

SQLite (`bun:sqlite`, zero external dependencies) for V0.1, not Postgres + pgvector. The schema in
`src/db/schema.sql` mirrors `src/types.ts` so migrating later is a lift-and-shift once the
approach is actually validated -- no point standing up Postgres before knowing if identity
resolution clears the gate.

## What's deliberately not here yet

- Real ChatGPT export ingestion (parser is ready; no real export has been run through it yet)
- Claude export parsing (needed for the cross-model identity-resolution case, which is harder
  than same-model evolution -- different lexical style, no shared IDs)
- Postgres + pgvector
- Embeddings / semantic retrieval
- MCP server, recovery API, any UI
- Decisions and connections as first-class objects (both currently fold into evolution steps --
  a real "this idea connects to that other idea" link needs a richer extraction schema that names
  both ideas, which the current single-candidate-match identity resolution doesn't support)
