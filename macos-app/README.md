# Thread for Mac (V0.1)

A menu-bar recovery surface, per the architecture decided earlier: capture stays in the browser
extension and desktop agent, this app is the human UI, talking to the same backend (`../src/api`)
over HTTP -- nothing here is a second source of truth.

## What this actually is (and isn't) vs. Wispr

Menu-bar background app, global hotkey, always-available -- same *shape* as Wispr. Different
*mechanism*: Wispr's hotkey captures voice and writes the result directly into whatever app has
focus, via the Accessibility API -- a one-way pipe *into* other apps. This app's hotkey opens a
floating panel showing Thread's own UI (search, ideas, correction); it does not read from or write
into any other application. That's deliberate scope, not an oversight -- text insertion into other
apps is a materially bigger capability needing Accessibility permission, not built here.

## The verification story (unusually layered this time -- read before trusting any of it)

This environment has `swiftc`/`swift build` (via Xcode Command Line Tools) but **no full Xcode
install**. That changes what "verified" can mean here more than for any other part of this
project:

**What's real and checked:**
- `swift build` succeeds -- the whole app compiles and links cleanly (Swift 6 strict concurrency
  included; one real actor-isolation error was hit and fixed, not suppressed).
- The compiled binary launches and stays running for at least a few seconds without crashing, in
  this actual macOS session.
- **`Models.swift` (the exact file the app uses, not a copy) correctly decodes real JSON captured
  from the live backend** -- `/v1/thinking-state`, `/v1/ideas/:id/trace`, and `/v1/ideas?q=`
  responses from an actually-running server were saved to disk and decoded with a standalone
  `swiftc` script using the real model file. This is the highest-value check available here: it
  proves the Codable definitions actually match what the backend really returns, not just what I
  assumed it returns.

**What's NOT checked, and structurally can't be from here:**
- **No XCTest, no Swift Testing framework at all** -- confirmed by trying both; neither module
  exists outside full Xcode. `Tests/ThreadMacTests/*.swift` is written as real, complete XCTest
  code (mocked `URLProtocol`, no network needed) and will run the moment this is opened in real
  Xcode -- but it has never actually been run. Treat it as "ready to run," not "passing."
- **No GUI interaction of any kind.** Nothing about how the menu bar icon looks, whether the
  popover renders correctly, whether clicking through pairing/search/correction actually works,
  has been seen. `Views/*.swift` is real SwiftUI, structurally sound, completely unverified
  visually.
- **The global hotkey's actual runtime behavior.** `GlobalHotKey.swift` registers Cmd+Shift+T via
  the classic Carbon API (deliberately not Accessibility-based -- see its doc comment). It
  compiles and the registration call doesn't error at startup. Whether pressing the actual key
  combo fires the callback has not been observed -- there's no way to simulate a physical key
  press here.
- **No code signing beyond automatic ad-hoc signing that `swift build` applies by default.**
  `security find-identity -v -p codesigning` returns zero identities in this environment -- there
  is no Developer ID certificate here, and there cannot be one without your actual Apple Developer
  account. Ad-hoc signing is enough to run the app locally (right-click → Open past Gatekeeper on
  a fresh build); it is not enough to distribute to anyone else, and it is not what the Mac App
  Store or notarization require.

**Before trusting this beyond "it compiles"**: open it in real Xcode, run the test suite, and
actually click through it.

## What "launch" needs from you specifically -- not something I can do autonomously

- An Apple Developer Program membership (your Apple ID, your payment) for a Developer ID
  certificate and/or App Store Connect access
- Running `xcodebuild -exportArchive` / Xcode's Organizer, or `notarytool`, with your credentials
- App Store review, if that's the distribution path, including your own listing copy, screenshots,
  privacy nutrition label answers, etc.

I can prepare an entitlements file, an Info.plist, and a build script once you tell me which
distribution path you want (direct-download notarized `.dmg`, or Mac App Store, or both -- they
have different entitlement/sandboxing requirements, particularly for network access and Keychain).

## Setup

```
cd macos-app
swift build
.build/arm64-apple-macosx/debug/ThreadMac
```

Requires the backend running (`cd .. && bun run src/api/server.ts`). First launch has no paired
account -- click the menu bar icon (or Cmd+Shift+T) and either create a new account or paste in
existing `userId`/`token` credentials (e.g. from the backend's `bun src/cli.ts import ...`, which
prints them).

## Architecture

```
ThreadMacApp.swift        @main, MenuBarExtra scene, owns AppDelegate
        |
AppDelegate                 registers the global hotkey, owns QuickRecallPanel
        |
GlobalHotKey.swift          Carbon RegisterEventHotKey (not Accessibility-based)
QuickRecallPanel.swift      floating NSPanel hosting RootView, toggled by the hotkey
        |
AppState.swift (@MainActor, ObservableObject)  -- single source of UI state
        |
APIClient.swift              URLSession, injectable for testing
        |
Models.swift                 Codable structs mirroring the backend's JSON exactly
        |
CredentialStore.swift        Keychain for the token, UserDefaults for non-secret config
```

Views (`Views/*.swift`) are pure SwiftUI reading/writing `AppState` -- no view owns its own
network or storage logic.

## What's deliberately not here

- Text insertion into other applications (Wispr's actual mechanism) -- a distinct, bigger
  capability needing Accessibility permission; not built, see above
- A configurable hotkey (hardcoded to Cmd+Shift+T for now)
- Manual paste in this app specifically (the API supports it -- `APIClient.pasteConversation` --
  just no UI wired to it yet; the browser extension's side panel has this)
- Launch-at-login, auto-update, crash reporting -- none of the production-app scaffolding beyond
  the core feature set
- Code signing, notarization, App Store submission -- see above
