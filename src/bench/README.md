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

On-device extraction: `bun run bench --held-out --live --on-device` adds the Mac's own model
(produced on a Mac by BenchExtractionTests) next to the cloud pipeline. How to run it, and the
pass/fail rule written before the data, are in `ON_DEVICE.md`.


## Voyage vectors (offline)

`vectors.voyage.json` holds Voyage's vectors for every text the scenarios contain (seeds 1-11), so the
Voyage row of `bun run bench` runs offline, free and identically every time, and `voyage.test.ts` can
guard grouping quality in CI. Regenerate after the corpus changes (the loader refuses stale vectors):

    railway run -- sh -c 'cd <checkout> && bun src/bench/makeVoyageVectors.ts'

`bun src/bench/diagSplits.ts` shows why ideas split: the groups a scattered idea landed in, how close the
split came to a merge, and whether the leftover thoughts share a conversation with the rest.


## Live extraction (spend-capped)

`bun src/bench/liveExtract.ts` runs production's own extraction path (`extractCognitiveEvents`, one call per
conversation, the real extraction model) over the bench scenarios, groups the extracted statements with
Voyage exactly as the server does, and scores them next to the answer-key ceiling. Use it to test a prompt
change on real model output before shipping it:

    railway run -- sh -c 'cd <checkout> && LIVE_BUDGET_USD=2 bun src/bench/liveExtract.ts --seeds tuned --variant baseline --label A1'

- **Cost guard:** every call is metered from the API's real token usage at conservative prices into
  `eval/out/live-spend.json`, which is checked before each call; the run stops at `LIVE_BUDGET_USD`
  (default 4.00). Results are cached per conversation, so rerunning a label is free and a stopped run resumes.
- A prompt variant is a string transform in `MeteredProvider.complete`; add one, run `baseline` and the
  variant on the same seeds, and compare. One run of each is noisy on this small suite -- treat gaps under a
  few points on a 15-20 item metric as noise, and confirm on `--seeds held` before changing the prompt.

### What it found (2026-10-21, Haiku 4.5 extraction, tuned seeds, one run each)

| | answer-key thoughts | live extraction | + "self-contained statements" rule | + sharper `resolution` definition |
|---|---|---|---|---|
| Grouping F1 | 86.1% | 86.9% | 87.0% | 85.8% |
| Ideas split into duplicates | 38.1% | 31.7% | 31.7% | 33.3% |
| Answered questions closed | 77.8% | 22.2% | 16.7% | 72.2% |
| Open questions still open | 100% | 83.3% | 88.9% | 61.1% |
| Open questions wrongly closed | 0 | 1 | 0 | 4 |

- Real extraction already groups as well as the answer key (its statements are rewritten, so the bench's rougher
  gold sentences understate it). Asking for self-contained statements changes nothing.
- The model labels most answers as `decision`/`new_idea`/`claim`, not `resolution` (5 vs 18 in the key), so
  answered questions stay open. A sharper definition fixes the labels (19 resolutions) but then closes questions the
  key leaves open. Letting a decision close a question in code (similarity floor 0.2-0.7), and requiring a minimum
  match for a resolution to close one, were tried offline on the cached output: the same trade-off, no free win.
  None shipped: deciding where that line sits needs labels from real use, not this synthetic key.
