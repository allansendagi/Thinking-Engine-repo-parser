# End-to-end user-journey simulation

```sh
bun run e2e        # = bun run e2e/journey.ts
```

Deterministic, no API key, ~1s. Drives the real HTTP handler (`src/api/handler.ts`) through the
entire path a person takes, asserting at every step. Exits non-zero on the first failure. Runs in
CI (backend job).

The extraction and identity-resolution models are **faked deterministically** (`journey/fixtures.ts`)
because this checks the **plumbing** — routing, auth, tenancy, gates, the billing state machine,
the shape of every response. Whether the models produce good output is a different question and
`bun run eval` measures it.

## The journey (10 phases)

| Phase | What it simulates |
| --- | --- |
| 1 | Open the Mac app → anonymous account, Free plan, zero setup |
| 2 | Capture the same thought from **ChatGPT → Claude → Gemini → Cursor**; assert it stays **one** idea (cross-tool identity merge) with an open loop and a decision |
| 3 | Recall: `/v1/ideas` search, `/v1/ideas/:id/trace` (each tool's conversation URL rode through; every step attributed to the human), `/v1/open-loops` |
| 4 | `/v1/continue` continuation packet: 4-tool evolution, distinct per-step source URLs, `{{CONTINUE_FROM_HERE}}` token, **no raw URL in the paste text**, unresolved question, decision |
| 5 | Browser return nudge — the shared rule (`extension/src/lib/resume.ts`) run against the real Thinking State; fires for the ~11-day-old unfinished idea, snooze suppresses it |
| 6 | `/v1/auth/start` (no account enumeration) → attach an email to the anonymous account, data kept |
| 7 | Second-device sign-in (same account, new **per-device** token, old token still valid); a stranger claiming the in-use email → `409 email_in_use` |
| 8 | Seed to 25 ideas, configure billing → capture `402 upgrade_required`, `/v1/continue` `402 pro_required`, **reads still 200** |
| 9 | Pay: a **correctly signed** `subscription.activated` webhook (exactly what Paddle's checkout emits) flips the account to Pro and re-opens the gates; a forged signature → 400 |
| 10 | Cancel: `subscription.canceled` → Pro through the paid period, then Free |

## What this does NOT prove — needs live config (founder only)

A green run means the code is ready for these. It does not stand in for them.

- **A real Paddle checkout with a card.** The webhook is simulated; Paddle's hosted checkout, the
  product/price, the `PADDLE_CLIENT_TOKEN`, and the webhook endpoint registration are dashboard
  setup. Do a full sandbox checkout once these exist.
- **The deployed website's Paddle.js overlay** and `/billing/success` polling.
- **`api.threadnow.app` DNS + TLS**, then re-pointing the 8 client defaults off the raw Railway URL.
- **The browser extension's live-DOM adapters.** happy-dom fixtures can't catch a `claude.ai`
  selector rename — verify capture against the real logged-in pages.
- **Model quality** — `bun run eval` (needs `ANTHROPIC_API_KEY` and, for a real number, the
  hand-labelled golden set).
- **The Mac app's SwiftUI flows** — logic is covered by `swift test`; the UI itself is manual.

## Known gap surfaced by phase 5

`GET /v1/thinking-state` returns `recentChanges` from a **30-day** window, but the resume rule's
age window is **3–45 days** — an idea last touched 31–45 days ago never becomes a nudge candidate
on either client. Minor (the 3–30 day band is the bulk of "returning to a thought"); fix by
widening the window or exposing `updatedAt` on `currentIdeas`.
