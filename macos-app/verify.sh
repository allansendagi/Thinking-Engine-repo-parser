#!/bin/sh
# One command to check the Mac app on a real Mac (needs Xcode): build, the full test suite, the
# release-style bundle, and an actual launch. What CI does, plus the part CI can't -- that the
# app really starts and stays up. Takes a couple of minutes.
#
#   cd macos-app && ./verify.sh
set -e
cd "$(dirname "$0")"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Build"
swift build

step "Tests"
swift test

step "Package (this Mac's architecture)"
THREAD_UNIVERSAL=0 ./package.sh >/dev/null
codesign --verify --deep --strict dist/ThreadMac.app
plutil -lint dist/ThreadMac.app/Contents/Info.plist >/dev/null
test -d dist/ThreadMac.app/Contents/Frameworks/Sparkle.framework

step "Launch"
pkill -x ThreadMac 2>/dev/null || true
open dist/ThreadMac.app
sleep 6
if pgrep -x ThreadMac >/dev/null; then
  echo "ThreadMac is running. Look for the Thread icon in the menu bar, then try:"
  echo "  • the recall shortcut (⌘⇧T by default)"
  echo "  • Settings ▸ General (Open at login, shortcut, Spotlight)"
  echo "  • ⌘Space and type a word from one of your ideas"
else
  echo "ThreadMac quit within 6 seconds of launch. Crash logs are in Console.app ▸ Crash Reports." >&2
  exit 1
fi

printf '\n\033[32mAll checks passed.\033[0m\n'
