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

## Distribution: unsigned via GitHub Releases (the chosen path for now)

Same pattern several open-source Whisper-for-Mac apps use (WhisperMac, WhisperDesk): ship an
unsigned, ad-hoc-signed `.app` as a GitHub Release asset; the user right-clicks → Open once per
downloaded build to get past Gatekeeper's "unidentified developer" warning. No Apple Developer
account needed for this path -- that's exactly why it's the right starting point here, and it
matches the audience (people already comfortable with GitHub Releases and dev tools).

```
./package.sh
```

Builds a release binary, assembles a real `.app` bundle (`Info.plist` with `LSUIElement` set so
it doesn't show a Dock icon or appear in Cmd+Tab -- it's menu-bar only), ad-hoc signs it, and zips
it to `dist/ThreadMac-<version>-macos.zip`. Verified for real: the assembled bundle passes
`plutil -lint`, `codesign -dv` shows a valid ad-hoc signature, and `open dist/ThreadMac.app`
(the actual way a user launches it, not just running the raw binary) launches it successfully.

**Known limitation of this path, not a bug**: the Gatekeeper warning reappears on every new
build/version download, since it's tied to that specific file, not a one-time-ever thing. Fine
for an early technical audience; a real blocker for a mainstream, non-technical launch later.

**What would remove that limitation** -- needs your Apple Developer account regardless of anything
built here:
- A Developer ID certificate, for `codesign --sign "Developer ID Application: ..."` instead of
  ad-hoc, plus `notarytool submit` -- removes the warning entirely for direct downloads
- Mac App Store instead/also: needs the certificate above, App Sandbox entitlements (network
  client + keychain-access-groups, at minimum), and App Store Connect submission with your own
  listing copy, screenshots, and privacy answers

### The signing path is already wired -- just add credentials

`Thread.entitlements` (hardened-runtime: network client + network server, nothing else) and the
signing/notarizing block in `package.sh` are in place. Once you have a Developer ID:

```sh
# one-time: store a notarytool profile in the keychain
xcrun notarytool store-credentials thread-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>

# then every build:
THREAD_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
THREAD_NOTARY_PROFILE=thread-notary \
  ./package.sh
```

`package.sh` then signs the `.app` with `--options runtime --timestamp --entitlements
Thread.entitlements`, signs the DMG, submits it to `notarytool --wait`, and staples. With
`THREAD_SIGN_IDENTITY` unset it falls back to the ad-hoc path above (what CI produces). Instead
of the keychain profile you can pass `THREAD_NOTARY_APPLE_ID` + `THREAD_NOTARY_PASSWORD` +
`THREAD_NOTARY_TEAM_ID`.

## Releases: signed, notarized, auto-updating (the path for a public launch)

Ad-hoc builds trip Gatekeeper on macOS 15, where right-click → Open no longer works and users
have to approve the app under System Settings ▸ Privacy & Security. A public download needs a
Developer ID signature, notarization, and auto-updates. All three are wired up; they just need
credentials.

**One-time setup** (on your Mac, with Xcode):

1. Join the Apple Developer Program, then create a **Developer ID Application** certificate in
   Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates. Export it from Keychain Access as a `.p12`.
2. Create an app-specific password at appleid.apple.com for notarization.
3. Generate the Sparkle update-signing keys (once, ever; **back up the private key**: losing it
   means existing installs can never auto-update again):
   ```
   swift build   # fetches Sparkle
   ./.build/artifacts/sparkle/Sparkle/bin/generate_keys      # prints the public key
   ./.build/artifacts/sparkle/Sparkle/bin/generate_keys -x sparkle_private_key.txt
   ```
4. In GitHub ▸ Settings ▸ Secrets and variables ▸ Actions, add the secrets
   `MACOS_CERT_P12_BASE64` (`base64 -i cert.p12 | pbcopy`), `MACOS_CERT_PASSWORD`,
   `MACOS_SIGN_IDENTITY` (`security find-identity -v -p codesigning`), `APPLE_ID`,
   `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` and `SPARKLE_PRIVATE_KEY`, plus the **variable**
   `SPARKLE_PUBLIC_KEY`.

**Each release:** `git tag mac-v0.3.0 && git push origin mac-v0.3.0`.
`.github/workflows/release-mac.yml` runs the tests, then builds a universal (Apple Silicon +
Intel) app, signs it with the hardened runtime, notarizes and staples the DMG, checks it with
`spctl`, signs it for Sparkle and publishes a GitHub Release containing `Thread.dmg` and
`appcast.xml`. Installed copies find the release through
`…/releases/latest/download/appcast.xml` and update themselves. Copy the DMG to the website's
`public/downloads/Thread.dmg`, or point the site's download route at the release asset.

**Locally**, the same build: `THREAD_SIGN_IDENTITY="Developer ID Application: …"
THREAD_NOTARY_PROFILE=thread THREAD_SPARKLE_PUBLIC_KEY=… ./package.sh`
(`THREAD_UNIVERSAL=0` for a faster native-only build).

**Note:** a DMG built before Sparkle was added has no updater, so people on those builds have to
download one signed release by hand. After that, updates arrive on their own.

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

## Native macOS integration

- **Spotlight:** every idea is indexed on this Mac (Core Spotlight, never uploaded). Press ⌘Space,
  type a few words, and choosing the result opens the idea in Thread. Settings ▸ General has a
  toggle to turn it off, and signing out removes the ideas from the index.
- **Keychain:** Developer ID builds keep the account credential in the login Keychain and move an
  existing file credential into it on first launch. Unsigned builds use a 0600 file, so they
  don't trigger a password prompt on every launch.
- **Open at login** (`SMAppService`), **auto-updates** (Sparkle) and a **configurable recall
  shortcut**: all in Settings ▸ General.
- **Share sheet:** the "continue where you left off" handoff can go to Messages, Mail, Notes,
  AirDrop or any share extension.
- **Back online automatically:** the app re-syncs when the network returns, after wake, and when
  the panel opens with stale data (`Connectivity.swift`).
- **First run leads with recovery:** "Recover my thinking" brings in Cursor history in one tap, or
  a ChatGPT/Claude export by file picker, drag-and-drop or the Downloads watcher. Empty states
  offer the same actions, so a new user is never stuck on a blank panel.

## Driving Thread from outside its own UI

Three entry points, all routed through `AppState.perform(_ :ThreadAction)` so there is one code
path per action. `ThreadAction` (see `ExternalActions.swift`) is the only place the vocabulary
and URL grammar live.

**`thread://` URL scheme** -- `open` it from Raycast, Alfred, a Shortcut's "Open URL" action,
or a script:

| URL | Does |
| --- | --- |
| `thread://recall?q=<text>` | opens the panel, runs a search for `<text>` |
| `thread://idea/<id>` | opens the panel on that idea's detail |
| `thread://loops` | opens the panel on the Open loops tab |
| `thread://continue?idea=<id>` | builds + copies that idea's continuation packet |
| `thread://continue?topic=<text>` | resolves the best-matching idea, then continues it |

Ids that contain `::` (paste-sourced) must be percent-encoded (`conv%3A%3A4`).

**Services menu** -- select text in any app, right-click, Services -> "Recall in Thread".
Backed by `ThreadServicesProvider`; declared under `NSServices` in the bundle Info.plist.

**App Intents** -- `AppIntents.swift` exposes *Recall in Thread*, *Show Open Loops*, and
*Continue a Thought in Thread* to Shortcuts, Spotlight, and Siri, each a thin wrapper over the
same `ThreadAction` cases. SwiftPM has no App Intents build phase, so `package.sh` runs the two
steps Xcode would: `swift-frontend -emit-const-values-path` (fed `appintents-protocols.json` --
a bare JSON array, since the open-source frontend rejects the toolchain's own keyed
`AppIntents.json`), then `appintentsmetadataprocessor` -> `Contents/Resources/Metadata.appintents`.
Needs full Xcode installed; on a Command-Line-Tools-only machine the step is skipped and the
app still builds (intents just aren't discoverable there -- the `thread://` scheme always is).

## What's deliberately not here

- Text insertion into other applications (Wispr's actual mechanism) -- a distinct, bigger
  capability needing Accessibility permission; not built, see above
- A configurable hotkey (hardcoded to Cmd+Shift+T for now)
- Manual paste in this app specifically (the API supports it -- `APIClient.pasteConversation` --
  just no UI wired to it yet; the browser extension's side panel has this)
- Launch-at-login, auto-update, crash reporting -- none of the production-app scaffolding beyond
  the core feature set
- Code signing, notarization, App Store submission -- see above
