# Chrome Web Store listing — Thread

Everything needed to submit the extension. Fill the Developer Dashboard fields from here so the
copy stays in one place. Nothing in this folder ships in the package.

---

## Store fields

**Item name**
`Thread — Continuity Layer`

**Summary** (≤ 132 chars)
`Recover and continue the thinking you do in ChatGPT, Claude, and Gemini — the thought, not the chat log.`

**Category**
`Productivity`

**Language**
`English`

**Detailed description**

```
Thread keeps the ideas you develop while talking to AI.

You have a long exchange in ChatGPT working out an approach. Three days later you need it back —
not the transcript, the conclusion and the open questions. Normally that means scrolling a dead
chat. Thread captures the idea as you go, across ChatGPT, Claude, and Gemini, and lets you pick
it up where you left off.

• Automatic capture — no button. When you develop an idea in a conversation, Thread records its
  formulation and how it evolved.
• Recall the thought — search your ideas, see the current formulation, its full evolution, and
  what's still unresolved.
• A gentle nudge to return — when you reopen a site with an unfinished thread, Thread offers to
  continue it.
• Works with the Thread app for Mac. The extension connects to it automatically on the same
  machine; your ideas live locally.

Thread is free to start: capture up to 25 ideas, unlimited recall, no account required. The app
quietly creates a local account so it works immediately — you attach an email later only if you
want to sign in elsewhere or go Pro.
```

**Single purpose** (Developer Dashboard requires one sentence)
`Capture the ideas a user develops in AI chat conversations (ChatGPT, Claude, Gemini) so they can be recalled and continued later.`

---

## Permission justifications

Paste each into the matching field. Keep them literal — reviewers reject vague answers.

| Permission | Justification |
|---|---|
| `storage` | Stores the user's pairing credential and local UI state (last-seen resume nudge, dismissed items). No browsing data. |
| `sidePanel` | The extension's main UI — the user's list of ideas and each idea's evolution — is shown in the Chrome side panel. |
| `alarms` | Periodically re-checks whether an unfinished thread on the current site is old enough to surface the "continue where you left off" nudge, without polling on every page event. |
| `host_permissions: chatgpt.com, chat.openai.com, claude.ai, gemini.google.com` | Content scripts read the visible conversation on these three AI products to extract the idea being developed. No other sites are accessed. |
| `host_permissions: http://localhost, http://127.0.0.1` | The Thread app for Mac runs a loopback-only pairing server; the extension fetches a one-time pairing token from it during setup. Never leaves the machine. |
| `host_permissions: thinking-engine-repo-parser-production.up.railway.app` | The Thread backend. The extension sends extracted ideas here (authenticated with the pairing token) and reads them back for the side panel. |

**Remote code:** none. All JavaScript is bundled in the package (`dist/`), built from `src/`. No
`eval`, no remote script loading.

**Data usage disclosures** (Privacy practices tab)
- *Does the item collect user data?* Yes.
- Categories: "Website content" (the text of the user's own AI conversations, to extract ideas)
  and "Authentication information" (the pairing token).
- Not sold to third parties. Not used for anything unrelated to the single purpose. Not used for
  creditworthiness or lending.
- Transmitted to: the Thread backend (above), over HTTPS.

---

## Reviewer test notes (Private, "Notes to reviewer")

```
The extension pairs with a companion Mac app, but you can review it without the app:

1. Load the extension. Open the popup — it shows "Not connected" (expected without the app).
2. Click "Pair with a code instead" and paste:  user_000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000
   (a syntactically valid dummy — it will fail auth against the backend, which is the expected
   path when there is no real account; no crash, a visible error.)
3. Open https://chatgpt.com or https://claude.ai — the content script injects a small
   "continue where you left off" card only if there is prior unfinished data, so on a fresh
   profile nothing appears. This is correct.
4. The side panel (right-click the toolbar icon → "Open side panel") renders the idea list UI;
   it is empty without a paired account.

No login is required to install or to review the UI. The backend URL is fixed and public.
```

---

## Assets checklist

- [x] Icon 128×128 — `../icons/icon128.png`
- [ ] Small promo tile 440×280 — `promo-440x280.png` (run `swift store-listing/promo.swift`)
- [ ] Marquee 1400×560 — `promo-1400x560.png` (same script) — optional, only if featured
- [ ] 1–5 screenshots 1280×800 — see `screenshots.md`
- [ ] Privacy policy URL — host the extension section of the site privacy page and link it

## Package

`./package.sh` writes `dist-package/thread-extension-<version>.zip` — that's the upload.
