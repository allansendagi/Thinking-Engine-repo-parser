# Thread Desktop Agent (V0.1)

Watches local AI-tool storage on disk and sends new conversations to the Thread API. This is the
"Desktop agents" piece of the capture layer -- distinct from the browser extension, for tools that
don't run in a browser (starting with Cursor).

## What's verified vs. what isn't

Same discipline as the rest of this project.

**Verified** (10 tests, `bun test`, plus a real end-to-end run):
- The watcher: detects real file changes, debounces rapid writes, correctly reports paths that
  don't exist as skipped rather than crashing
- The Cursor adapter's *scanning logic*: given a constructed SQLite `state.vscdb` with a plausible
  `ItemTable`, correctly finds chat-related keys, parses their JSON, and recursively identifies
  message-shaped arrays (role/text fields under several common naming variants) while correctly
  ignoring unrelated data (an incidental array of file paths, an unrelated settings key)
- **Full pipeline, live**: ran the actual `run.ts` against a real bound API server with a real
  Anthropic key -- watcher → extraction → scanning → ingest → real model call → idea correctly
  appears in the Thinking State. This proves the mechanics work end to end.

**NOT verified** (the real, structural limit):
- Whether a real Cursor install's `state.vscdb` actually contains chat/composer data in a shape
  this scanner can find. What's solid: Cursor is a VS Code fork, and the `state.vscdb` /
  `ItemTable(key, value)` mechanism is core, stable VS Code storage behavior. What's NOT solid:
  which exact keys Cursor stores chat under, and what shape the JSON takes -- that's
  Cursor-internal and undocumented. The scanner is built to degrade gracefully under that
  uncertainty (structural pattern-matching across several field-name variants, not one hardcoded
  key), but "degrades gracefully" still means "may find nothing real" until checked against an
  actual install.

**Before trusting this**: set `THREAD_USER_ID`/`THREAD_TOKEN` (from the backend's
`bun src/cli.ts import ...`, which prints them) and run `bun src/run.ts` with Cursor actually
installed and used. If it logs `nothing message-shaped was found`, the adapter's key patterns or
field-name heuristics need updating against the real data -- open `state.vscdb` with any SQLite
browser and look at what's actually in `ItemTable` under chat/composer-related keys.

## Setup

```
cd desktop-agent
bun install
export THREAD_API_BASE_URL=http://localhost:8787   # default if unset
export THREAD_USER_ID=user_...                       # from the backend's import CLI or POST /v1/users
export THREAD_TOKEN=...
bun src/run.ts
```

Optional: `THREAD_CURSOR_STATE_DB_PATH` overrides the default macOS path
(`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`) -- useful for testing
against a copy, or for a different OS/install location.

## Architecture

```
sources/cursor.ts    locateWatchTargets() -> [state.vscdb path, if it exists]
        |
        v
watcher.ts            fs.watch, debounced
        |
        v
sources/cursor.ts    extract(path) -> CapturedConversation[]  (SQL scan + structural JSON scan)
        |
        v
ingest.ts             POST /v1/conversations  (same API the browser extension and CLI import use)
```

Adding a new tool means implementing `SourceAdapter` (`src/sources/sourceAdapter.ts`) and
registering it in `run.ts`'s `ADAPTERS` array -- the watcher, ingest, and config plumbing are
already generic.

## What's deliberately not here

- Claude Code, local model tools, or any source besides Cursor -- the framework (watcher +
  adapter interface + ingest) is generic and ready for more, only Cursor has an actual adapter
- Windows/Linux paths for Cursor's storage (macOS path only, hardcoded default)
- Auto-pairing like the browser extension does on install -- requires deliberately supplying an
  existing account, since a desktop agent isn't a fresh-install context the way a new browser
  profile is
- Packaging as a background service (launchd plist, etc.) -- this is a foreground `bun run`
  process for now
