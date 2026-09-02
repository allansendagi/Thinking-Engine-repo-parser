# Billing — permanent Free tier + Pro, via Paddle (Merchant of Record)

## Model

- **Free** (default, no card, forever): capture up to **25 idea nodes**; unlimited reads /
  recall / trace. No timed trial.
- **Pro** ($15/month): unlimited capture **+ AI continuation** (`POST /v1/continue`, MCP
  `continueThinking`).
- **Identity is an email.** An account can be anonymous (the Mac app auto-creates one on first
  launch so capture works with zero setup) and later *claimed* by verifying an email. Sign-in
  is passwordless: email + 6-digit code.
- **Payment happens on the website**, not in the app. Paddle is Merchant of Record — it owns
  checkout, recurring billing, tax/VAT, invoices, fraud, dunning and the customer portal.
- **Soft lock:** reads always work. Only `POST /v1/conversations` / `POST /v1/paste` (402
  `upgrade_required` at the 25-idea cap) and `POST /v1/continue` (402 `pro_required`) are gated.
- **Kill switch:** every gate is a no-op until `PADDLE_API_KEY` + `PADDLE_PRICE_ID` +
  `PADDLE_WEBHOOK_SECRET` are all set.

## Backend env (Railway)

| Var | Required | Purpose |
|---|---|---|
| `PADDLE_API_KEY` | to enable billing | Paddle API key (server-side; portal links) |
| `PADDLE_PRICE_ID` | to enable billing | the recurring `pri_…` for Thread Pro |
| `PADDLE_WEBHOOK_SECRET` | to enable billing | `pdl_ntfset_…` signing secret for the webhook destination |
| `PADDLE_ENV` | optional | `sandbox` \| `production` (default `production`) |
| `PADDLE_PRICE_ID_YEARLY` | optional | reserved for a future yearly plan picker |
| `RESEND_API_KEY` | for real email | Resend API key. Without it, sign-in codes are logged, not sent. |
| `EMAIL_FROM` | for real email | e.g. `Thread <hello@thread.com>` |
| `APP_PUBLIC_URL` | optional | portal return URL base (default: the marketing site) |

## Website env (Vercel)

| Var | Purpose |
|---|---|
| `API_BASE` | Railway API base URL (server functions call it) |
| `VITE_PADDLE_CLIENT_TOKEN` | Paddle client-side token for Paddle.js |
| `VITE_PADDLE_PRICE_ID` | same `pri_…` as the backend |
| `VITE_PADDLE_ENV` | `sandbox` \| `production` |

## Paddle dashboard setup (one time)

1. **Catalog:** create a product "Thread Pro" with a recurring **$15/month** price. Copy the
   `pri_…` id.
2. **Notifications → new destination (webhook):** URL `https://<api>/v1/paddle/webhook`, events
   `subscription.activated`, `subscription.updated`, `subscription.past_due`,
   `subscription.canceled`, `subscription.resumed`, `transaction.completed`. Copy the signing
   secret → `PADDLE_WEBHOOK_SECRET`.
3. **Checkout settings → default payment link:** point at the website domain and approve it.
4. Sandbox first: `PADDLE_ENV=sandbox` / `VITE_PADDLE_ENV=sandbox` with a sandbox token.

## API

| Route | Auth | Does |
|---|---|---|
| `POST /v1/auth/start` | — | email a 6-digit sign-in code |
| `POST /v1/auth/verify` | — | `{ userId, token }` — finds-or-creates the account; issues a per-device token (other devices stay signed in) |
| `POST /v1/account/email` + `/verify` | bearer | attach a verified email to this account (claim); 409 `email_in_use` |
| `GET /v1/account` | bearer | `{ plan, status, isPro, canCapture, ideaCount, ideaCap, email, billingEnabled }` |
| `GET /v1/billing/portal` | bearer | `{ url }` — a Paddle customer-portal link (409 if never subscribed) |
| `POST /v1/paddle/webhook` | Paddle signature | applies subscription events to the account row |

## Clients

- **Website:** `/login` (email + code), `/account` (plan status, Upgrade → Paddle.js overlay
  checkout, Manage billing → portal, Download), `/billing/success` polls `/v1/account` until Pro.
  The bearer credential lives in an httpOnly cookie set by a server function.
- **Mac app:** `GET /v1/account` on launch + refresh. Footer shows `Free · N/25` or `Pro`. At
  the cap, a banner offers **Upgrade to Pro** (opens the website account page) + **Manage
  billing** (if the account has an email). Settings → **Add email** claims an anonymous account.
  Signing in on the website does **not** sign the Mac app out — tokens are per-device.
- **Extension:** on 402 during capture it keeps the (valid) credentials, badges the toolbar,
  and shows "Free plan limit reached — upgrade to Pro from your Thread account".
