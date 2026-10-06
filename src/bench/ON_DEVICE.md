# On this Mac vs the cloud: the extraction comparison

The question: is the Mac's own model good enough to turn conversations into ideas that a person
would accept, so that "On this Mac" (nothing leaves the machine) can be offered as a mode?

Decide with numbers, and decide the rule **before** seeing them.

## Run it (about 30 minutes, a few dollars)

You need a Mac with **Apple Intelligence enabled** (macOS 26, Apple silicon), the repo, `bun`, and
an `ANTHROPIC_API_KEY` with credit. Use the held-out seeds (4–11): nothing was tuned on them.

```sh
# 1. The captures, in the order a person wrote them
bun src/bench/dumpConversations.ts --held-out > /tmp/bench-convs.json

# 2. The Mac's own model, exactly as the app runs it (764 captures; a few minutes)
cd macos-app
BENCH_CONVERSATIONS=/tmp/bench-convs.json BENCH_EXTRACT_OUT=../src/bench/ondevice.results.json \
  swift test --filter BenchExtractionTests
cd ..

# 3. Score both on the same suite, same metrics (the cloud run is ~764 captures on Claude:
#    roughly $1-5 -- unmeasured; check your console after)
ANTHROPIC_API_KEY=... bun run bench --held-out --live --on-device
```

If step 2 prints "skipped … isn't available on this machine", Apple Intelligence is off or the
Mac doesn't support it. (GitHub's macOS runners are VMs and almost certainly can't run it; the
manual **Bench extraction (on-device)** workflow exists to confirm that in one click.)

The last command prints one table: today's cloud pipeline (v1, live models) next to the Mac's
model, plus the on-device speed. Send me `eval/out/bench.json`.

## How the Mac is run

Each capture (the person's own message) goes through `OnDeviceModel.absorbCapture` — the same
call the app makes — with the ideas created so far, and the result is folded into a `LocalGraph`.
It decides "continues idea X" or "new idea". It has **no "this isn't an idea" outcome** and
**records no decisions**, so on those rows it is scored for what the app would actually do, not
what it could do. Those gaps are real and go in the "what you give up" line of the mode.

## The rule (written before the data)

Compared with the cloud pipeline on the same held-out suite:

| Outcome | Condition | What we do |
|---|---|---|
| **Offer "On this Mac"** | Thoughts captured and grouping quality each ≥ **90%** of cloud; noise that became ideas ≤ cloud **+ 5 points**; wrong merges ≤ **1.5×** cloud; answered ≥ **95%** of captures; mean ≤ **5 s** per capture | Ship as a normal mode |
| **Offer it as "Private (beta, less sharp)"** | The first two each ≥ **70%** of cloud; noise ≤ cloud **+ 15 points**; answered ≥ 90% | Ship, labelled plainly with what's lost |
| **Don't offer it yet** | Anything worse | Improve the prompts/pipeline, or wait for better on-device models |

Whatever the outcome, "On this Mac" also needs the engine running locally and signed (see
`docs/LOCAL_ENGINE_SPIKE.md`); this comparison only answers the quality question.

## Caveats to keep in mind

- The bench is synthetic (known ideas, generated phrasing). It ranks approaches well; it does not
  say how either model does on *your* real conversations. Spot-check with your own history before
  trusting a close call.
- The on-device model sees one message at a time here, as the app feeds it. A smarter
  on-device pipeline (context, the verification steps the server runs) could do better; this
  measures what ships today.
