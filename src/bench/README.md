# The thinking bench

Synthetic thinkers whose ideas, and how those ideas evolve, are known in advance, so any idea
miner can be scored exactly. `bun run bench` (free, offline, deterministic) scores every miner;
`bun run bench --live` adds today's pipeline on the real models (needs `ANTHROPIC_API_KEY`).

- `storylines.ts`: hand-authored ideas developed over weeks. Each step has three phrasings
  (the third deliberately shares few words with the others), later steps re-phrase the idea
  (tests matching by meaning), and some ideas deliberately share vocabulary with a different
  idea (tests wrong merges). Miners see what the simulated person actually wrote, not a
  canonical sentence, so different seeds genuinely differ.
- `generate.ts`: interleaves a persona's storylines across conversations, tools and days, adds
  noise turns, and records the ground truth. The same seed always gives the same scenario.
- `metrics.ts`: what a person would notice. Thoughts captured, noise that became ideas, grouping
  quality (B-cubed F1), ideas split into duplicates, wrong merges (critical for look-alikes),
  "where I stand" correct, open / answered questions, decisions, ideas wrongly marked rejected.
- `miners.ts`: adapters. Offline runs use answer-key extraction, so grouping and state are
  measured in isolation; extraction quality itself needs the live run.

`bun run bench --held-out` scores seeds 4-11, which no threshold was tuned on; quote those
numbers, not the tuning seeds'.

Meaning vectors: `vectors.apple.json` is produced on a Mac by the bench-vectors workflow (Apple's
contextual model, the one real Macs run) and committed back to the branch. A stale file is
refused, not silently scored as words. With `VOYAGE_API_KEY` set, the cloud fallback is scored
too. Each model is used only as far as it earns here (`meaningWeightFor`): macOS's older sentence
model made grouping worse at every weight, so it is not used.

A new miner ships only when it beats the current one here, and holds up on the live run and
on real hand-labelled conversations (`eval/`).
