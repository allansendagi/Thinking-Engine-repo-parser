# Thread Extension (V0.1)

Chrome extension (Manifest V3): captures conversations from ChatGPT, Claude, and Gemini, sends
them to the Thread API (`../src/api`), and provides a side panel to search, review, and correct
what Thread has captured.

## What's verified vs. what isn't

Same discipline as the backend (`../README.md`) — split honestly by what can actually be checked.

**Verified** (15 tests, `bun test`, no browser, no network):
- Conversation-id extraction from each site's URL pattern
- Message extraction logic against constructed HTML fixtures (happy-dom) -- role assignment,
  ordering by real DOM position (not selector-match order), fallback selector strategies, correct
  empty-array behavior when nothing matches
- The capture engine's debounce and dedup logic: sends once after quiet, doesn't re-send an
  unchanged conversation, does send again once a genuinely new message appears, does nothing when
  not on a conversation page
- The build itself: `bun run build.ts` produces working bundles -- content scripts are verified to
  be fully self-contained IIFEs with no stray `import`/`export` statements (which would fail
  outright as classic scripts), popup/sidepanel/background bundle as ESM correctly

**NOT verified** (needs a real browser, which this environment doesn't have access to per explicit
instruction not to use it for this project):
- Whether the CSS selectors in `content/adapters/*.ts` actually match the current, live DOM of
  chatgpt.com, claude.ai, or gemini.google.com. These were written from general knowledge of each
  site's structure, not live inspection, and are explicitly the least-verified, most likely to
  need adjustment part of this entire build. Each adapter logs a distinct `console.warn` if it's
  on what looks like a conversation page but finds zero messages -- check devtools first if
  capture silently isn't working.
- Whether the extension actually loads, whether the side panel renders correctly, whether the
  popup's pairing flow works end to end in a real Chrome instance
- Manifest V3 permission prompts / host permission behavior in practice

**Before trusting this**: load it unpacked (`chrome://extensions` → Developer mode → Load
unpacked → select this directory), open a real conversation on each site, and check the console
for the adapter warnings above. Fixing a stale selector is a one-file change in
`content/adapters/*.ts` plus a fixture update in the matching `*.test.ts`.

## Architecture

```
content-{chatgpt,claude,gemini}.ts   (IIFE, injected per-site)
        |
        v  content/adapters/*.ts        (site-specific DOM -> RawMessage[], + getConversationUrl())
        v  content/common/capture.ts    (debounce, position-based ids, local dedup)
        v  content/common/resumeNudge.ts (on a fresh/empty chat: "pick up where you left off?")
        |
        v  chrome.runtime.sendMessage
background.ts                          (relays to the API, holds the auth token)
        |
        v  lib/api.ts  ->  Thread API (../src/api)
        v  lib/resume.ts                 (shared rule with the Mac app: which idea to resurface)
        |
popup.ts        (pairing / API URL)
sidepanel.ts     (recovery + correction UI: search, trace, rename, reject/delete, resolve loops, continue)
```

### Return nudge

`resumeNudge.ts` runs alongside capture on every supported site. When you land on a *new or
empty* chat (not an existing thread), it asks the background worker for the one idea you're most
likely returning to — computed from Thinking State with the exact rule the Mac app uses
(`lib/resume.ts`: unfinished, 3–45 days old, not snoozed since it last moved). If there is one,
it draws a small shadow-DOM card bottom-right. **Resume in Thread** opens
`thread://continue?idea=<id>` (the Mac app builds the packet — no Pro-gated `/v1/continue` call
from the browser); **Not now** snoozes that idea until it next changes. At most one card per URL.

Message ids are `${conversationId}::${index}` -- position-based, not derived from message text.
That's deliberate: an assistant reply's text grows while streaming, and a text-derived id would
change on every partial render, breaking dedup. The accepted tradeoff: a message captured while
still streaming may be recorded with truncated text and never re-captured once complete. This only
affects context completeness for later extraction calls, not correctness -- the backend's
extraction prompt only ever extracts from user turns, and a truncated assistant reply can't
produce a fabricated user statement.

## Auth

On install, the background worker automatically creates a new Thread account (`POST /v1/users`)
against whatever `apiBaseUrl` is configured (default `http://localhost:8787`) and stores the
credentials. Open the popup to see pairing status, point at a different API URL, or paste in
credentials from an existing account to use the same one across browsers/installs.

## Setup

```
cd extension
bun install
bun run build.ts
```

Then load `extension/` unpacked in Chrome (`chrome://extensions` → Developer mode → Load
unpacked). Make sure the backend is running first (`cd .. && bun run src/api/server.ts`).

## What's deliberately not here

- Real verification against live sites (see above)
- Merge-two-ideas UI (the backend endpoint doesn't exist yet either -- see `../README.md`)
- Direct editing of an idea's current formulation (same reason -- provenance-consistency gap in
  the backend, not an extension limitation)
- Chrome Web Store packaging/submission (icons, store listing, review) -- this is a
  load-unpacked-for-development build only
- Firefox/Safari -- Manifest V3 + `chrome.*` APIs only, no cross-browser abstraction
