# The thinking bench

Synthetic thinkers whose ideas, and how those ideas evolve, are known in advance, so any idea
miner can be scored exactly. `bun run bench` (free, offline, deterministic) scores every miner;
`bun run bench --live` adds today's pipeline on the real models (needs `ANTHROPIC_API_KEY`).

- `storylines.ts`: hand-authored ideas developed over weeks. Later beats re-phrase the idea in
  different words (tests matching by meaning), and some ideas deliberately share vocabulary
  with a different idea (tests wrong merges).
- `generate.ts`: interleaves a persona's storylines across conversations, tools and days, adds
  noise turns, and records the ground truth. The same seed always gives the same scenario.
- `metrics.ts`: what a person would notice. Thoughts captured, noise that became ideas, grouping
  quality (B-cubed F1), ideas split into duplicates, wrong merges (critical for look-alikes),
  "where I stand" correct, open / answered questions, decisions, ideas wrongly marked rejected.
- `miners.ts`: adapters. Offline runs use answer-key extraction, so grouping and state are
  measured in isolation; extraction quality itself needs the live run.

A new miner ships only when it beats the current one here, and holds up on the live run and
on real hand-labelled conversations (`eval/`).
