# Billing — 14-day trial, Stripe subscription, soft lock

## Model

- **Trial:** 14 days, no card. Granted at account creation (`createUser` sets `trial_ends_at`).
- **Convert:** Stripe Checkout (subscription mode). The Thread `userId` rides along as
  `client_reference_id` + `subscription_data.metadata.thread_user_id`.
- **Lock:** *soft*. Reads (`/v1/thinking-state`, `/v1/ideas`, `/trace`, `/continue`, …) always
  work — you can always recover what you've captured. Only `POST /v1/conversations` and
  `POST /v1/paste` are gated; they return **402** `{ code: "subscription_required" }` when the
  trial is over and there's no active subscription.
- **Kill switch:** the gate is a no-op until `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID` are set.
  Deploying this code changes nothing on its own.

## Backend env vars (Railway)

| Var | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | to enable billing | `sk_live_…` / `sk_test_…` |
| `STRIPE_PRICE_ID` | to enable billing | the recurring Price for Thread Pro |
| `STRIPE_WEBHOOK_SECRET` | for the webhook | `whsec_…` from the endpoint you create |
| `APP_PUBLIC_URL` | optional | redirect base for Checkout success/cancel (default: the marketing site) |

## Stripe dashboard setup (one time)

1. **Product + Price:** create "Thread Pro" — a recurring **$15/month** Price (and optionally a
   **$12/month billed yearly** = $144/yr Price). Copy the monthly `price_…` id into
   `STRIPE_PRICE_ID`. (A yearly option needs a plan-picker in Checkout — add later; monthly ships
   the flow.)
2. **Webhook:** Developers → Webhooks → Add endpoint →
   `https://<your-api>/v1/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. **Customer Portal:** Settings → Billing → Customer portal → activate (lets `/v1/billing/portal`
   mint sessions so users self-serve cancel / update card).

## API

| Route | Auth | Does |
|---|---|---|
| `GET /v1/account` | bearer | `{ status, entitled, trialDaysLeft, currentPeriodEnd, billingEnabled }` |
| `POST /v1/billing/checkout` | bearer | `{ url }` — a Stripe Checkout Session for this account |
| `GET /v1/billing/portal` | bearer | `{ url }` — a Customer Portal session (409 if never subscribed) |
| `POST /v1/stripe/webhook` | Stripe signature | applies subscription events to the account row |

`status`: `trialing` | `active` | `past_due` (grace) | `canceled` (usable through
`currentPeriodEnd`) | `incomplete`.

## Clients

- **Mac app:** fetches `/v1/account` on launch + every refresh. Footer shows
  `Trial · Nd` / `Pro` / `Trial ended`. When locked, a soft paywall banner sits above the list
  with **Upgrade to Pro** (→ Checkout) and **Manage billing** (→ Portal). Reads stay open.
- **Extension:** on a 402 during capture it keeps the credentials (they're valid), shows
  "Trial ended — subscribe in Thread for Mac" in the popup, and sets the toolbar badge.

## Website (mind-stream-continuity) — still to build

- `/pricing` → button hits `POST /v1/billing/checkout` (needs the visitor's account) **or** runs
  Checkout first and creates the Thread account in the webhook, then shows the pairing string +
  download link on `/billing/success`.
- `/account` → link to `GET /v1/billing/portal`.
