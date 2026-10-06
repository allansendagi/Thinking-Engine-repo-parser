# Spike: run the Thread engine on the user's Mac

**Question.** Can the existing backend run *on the Mac*, so the user's conversations live there
and only the model call leaves the machine — without rewriting it in Swift?

**Short answer.** Technically yes, cheaply. The engine compiles to one self-contained executable
that boots in ~130 ms and passes the same boot/health/round-trip checks as the server. What's
*not* yet answered is product-level: signing, lifecycle, how the websites reach it, and whether
on-device extraction is good enough. Those are listed below with how to measure each.

## What was measured (Bun 1.3.14, this repo, Linux sandbox)

| | Result |
|---|---|
| `bun build --compile src/api/server.ts` | works; 86 modules, ~0.4 s |
| Binary size | linux 95 MB · **macOS arm64 64 MB (24 MB gzipped)** · macOS x64 70 MB |
| Cross-compile for macOS from Linux | works (`--target=bun-darwin-arm64` / `bun-darwin-x64`) |
| Time to first healthy response | **128 ms** |
| Idle memory | ~56 MB RSS |
| Boot + health + deep health + account round trip + capture + data summary | pass (`scripts/smoke-boot.sh`, same checks as the Railway job) |
| Capture with no API key | stored, extraction deferred with the reason — the store-first design holds with no cloud at all |

The macOS binaries were built but **not run** (no Mac here); everything functional above was run
as the Linux build of the same code.

## What the spike found and fixed

- `src/db/client.ts` read `schema.sql` from disk at start-up, so the compiled binary crashed
  (`ENOENT /$bunfs/root/schema.sql`). It's now embedded at build time
  (`import … with { type: "text" }`). This was the only runtime file read in the engine.
- CI now compiles the engine (and both macOS targets) and boots the binary through the same smoke
  test, so this can't regress silently. (`ci.yml` → *backend as a single binary*.)

## What it would take to ship it inside the Mac app

1. **Signing.** The embedded executable must be signed with the app's Developer ID and the
   hardened runtime. Bun/JavaScriptCore needs the JIT entitlements
   (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`).
   Needs the Apple Developer ID we don't have yet — **verify on a real Mac before committing.**
2. **Lifecycle.** Launch as a child/login helper, loopback only, random port + per-launch secret,
   restart on crash, stop on quit. The app already runs a loopback server for the extension
   (`PairingServer`), so the pattern exists.
3. **Pointing the app at it.** The app already has a server-URL setting, and the engine is
   already one SQLite file per user, so this is configuration, not a rewrite. Sign-in, billing
   and the model call still need a (much smaller) cloud: accounts + a stateless model proxy that
   doesn't store conversations.
4. **The extension.** It already talks to the Mac over loopback; it would send to the local
   engine instead of Railway. Requires the Mac app to be running while capturing (the extension
   already queues and retries).
5. **What local-first does not give.** The websites (ChatGPT/Claude on the web) can't call a
   local engine, so "continue in Claude" there stays clipboard/Services-based. Cross-device sync
   is lost until something like CloudKit is added. And the model that extracts ideas still sees
   the conversation text — local-first reduces what is *kept* and *where*, not what the model reads.

## Not measurable here — and how to measure it

- **On-device vs cloud extraction quality** (the real go/no-go). Run the on-device model and the
  cloud model over the same held-out gold set (`bench/`) and compare idea precision/recall and
  duplicate rate. Needs a Mac with Apple Intelligence **and** API credits. Until then, the
  on-device pass stays a first draft, not a replacement.
- **Signed binary launches and passes Gatekeeper/notarization** with the entitlements above.
- **Real-world footprint** on a Mac with a large history (the 8,750-message account is a good test).

## Recommendation

Keep cloud custody as the launch architecture, with minimization and deletion (shipped), and
treat the local engine as the next architecture to *prove* — start with the signing check and the
extraction-quality comparison, because both can end the idea cheaply.
