# End-to-end simulations

```sh
bun run e2e            # journey.ts   — the whole user journey, 46 checks
bun run e2e:payments   # payments.ts  — the Paddle billing surface, 30 checks
bun run e2e:identity   # identity.ts  — passwordless auth + "remember me", 32 checks
```

All three are deterministic, no API key, ~1s, exit non-zero on the first failure, and run in CI
(backend job). They drive the real HTTP handler (`src/api/handler.ts`) and assert at every step.

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

## Known gap surfaced by journey.ts phase 5

`GET /v1/thinking-state` returns `recentChanges` from a **30-day** window, but the resume rule's
age window is **3–45 days** — an idea last touched 31–45 days ago never becomes a nudge candidate
on either client. Minor (the 3–30 day band is the bulk of "returning to a thought"); fix by
widening the window or exposing `updatedAt` on `currentIdeas`.

---

# payments.ts — the Paddle billing surface

30 checks across 7 phases, all through `POST /v1/paddle/webhook` and `GET /v1/account`:

1. **Soft launch** — with no `PADDLE_*` env, the 25-idea cap and the `/v1/continue` Pro gate are
   both no-ops (safe to ship before billing is wired).
2. **Webhook signature** — valid → 200; wrong secret, tampered body, stale timestamp (>5 min),
   missing header, malformed header → all 400. This signature is the *only* thing between a
   stranger and a free Pro account.
3. **Full lifecycle** — `activated → updated → past_due → recovered → canceled → (period elapses)
   → resumed → paused`, with the capture gate and `/v1/continue` gate asserted to track each
   transition (past_due keeps access; canceled keeps it until `current_billing_period.ends_at`,
   then drops).
4. **User resolution** — `custom_data.thread_user_id` (checkout), `paddle_customer_id` lookup
   (portal-initiated events with no metadata), `transaction.completed` seeding that id, and an
   event for an unknown user → 200 no-op, account byte-for-byte unchanged.
5. **Customer portal** — `GET /v1/billing/portal`: 409 before subscribing, the Paddle portal URL
   after (Paddle API `fetch` mocked), 502 on a Paddle API error.
6. **Idempotency** — the same activation delivered 3× (Paddle retries on timeout) → Pro exactly
   once.
7. **The 402 contract** — the exact `{ error, code }` bodies the Mac app / extension / website
   render for `upgrade_required` and `pro_required`.

## The one payment test this can't do — real Paddle sandbox checkout

A signed webhook here is byte-for-byte what Paddle emits, but it doesn't exercise Paddle's hosted
checkout, tax calculation, or `Paddle.js`. Once per environment, do this by hand:

1. **Paddle dashboard (sandbox)** → create a Product, then a recurring Price (e.g. $15/mo). Note
   the **price id** (`pri_…`).
2. Developer Tools → Authentication → create an **API key** (`PADDLE_API_KEY`) and a
   **client-side token** (`PADDLE_CLIENT_TOKEN` / `VITE_PADDLE_CLIENT_TOKEN`).
3. Developer Tools → **Notifications** → add a destination pointing at
   `https://<your-api-host>/v1/paddle/webhook`, subscribe to `subscription.*` +
   `transaction.completed`, copy the **signing secret** (`PADDLE_WEBHOOK_SECRET`).
4. Set on the API host: `PADDLE_API_KEY`, `PADDLE_PRICE_ID`, `PADDLE_WEBHOOK_SECRET`,
   `PADDLE_ENV=sandbox`. Set on the website: `VITE_PADDLE_CLIENT_TOKEN`, `VITE_PADDLE_PRICE_ID`,
   `VITE_PADDLE_ENV=sandbox`.
5. From the website's account page, start checkout and pay with Paddle's test card
   **`4242 4242 4242 4242`**, any future expiry, any CVC.
6. Assert: the webhook hits `/v1/paddle/webhook` (Paddle dashboard shows a 200), `GET /v1/account`
   flips to `plan: "pro"`, the capture + continue gates open, and **Manage billing** opens the
   real Paddle portal.
7. Cancel from the portal → `GET /v1/account` shows `status: "canceled"` but stays Pro until the
   period end.

Everything downstream of step 6's webhook is what `payments.ts` already proves.

---

# identity.ts — passwordless accounts, devices, "remember me"

32 checks, 9 phases, through the real handler **and** by reading `registry.db` directly:

1. **The 6-digit code** — `issueCode` returns 6 random digits; stored **SHA-256 hashed**
   (`login_codes.code_hash`), ~10-min TTL, **single-use** (deleted on match), **5 wrong guesses
   burn it**, **6th issue within an hour → `RateLimitedError` (429)**. `/v1/auth/start` is always
   `200 {ok:true}` — no account enumeration.
2. **First launch** — `POST /v1/users` → `user_<24hex>:<64hex>`, Free plan, `email: null`.
3. **Token storage** — the bearer token is **SHA-256 hashed at rest** (`auth_tokens.token_hash`),
   shown once; malformed header or wrong token → 401.
4. **Claim** — attach an email to the anonymous account; `users.email` stored (plaintext — it's an
   identifier and we email to it) with `email_verified_at`; **every idea captured before the claim
   is kept**; the original device token keeps working.
5. **More devices** — signing in with `EMAIL.toUpperCase()` lands on the **same** account
   (case-insensitive unique index); **3 device tokens authenticate simultaneously**, nothing
   rotated; `auth_tokens` shows 3 rows for the one account.
6. **Sign out one device** — clients discard the *local* token only; the others are untouched.
   **Documented gap: there is no server-side revoke endpoint**, so a lost device's token hash
   stays in `auth_tokens` until (not yet built) revocation exists.
7. **One account per email** — a rival claiming an in-use email with data → `409 email_in_use`; a
   new email find-or-creates; an email on an *empty* account is reclaimed onto the one with data.
8. **Charging maps to the account** — a webhook keyed by `custom_data.thread_user_id` flips
   `users.plan` and stores `paddle_customer_id` / `paddle_subscription_id`; **every device sees
   Pro**, and a brand-new sign-in is Pro immediately (entitlement is on the account, not the device).
9. **Restart durability** — a fresh handler instance over the same `registry.db` still
   authenticates the same token, same email, same Pro, same ideas.
