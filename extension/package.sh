#!/bin/sh
# Builds the Chrome Web Store upload zip: manifest + built bundles + icons, nothing else.
# (No source, no node_modules, no store-listing/, no tests.)
set -e
cd "$(dirname "$0")"

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist-package/thread-extension-${VERSION}.zip"

echo "Building bundles..."
bun install --frozen-lockfile
bun run build.ts

echo "Verifying icons exist..."
for s in 16 32 48 128; do
  test -f "icons/icon${s}.png" || { echo "missing icons/icon${s}.png -- run: swift icons/render.swift"; exit 1; }
done

rm -rf dist-package
mkdir -p dist-package
zip -r -q "${OUT}" manifest.json dist icons \
  -x "dist/*.map" "icons/render.swift"

echo ""
echo "Wrote ${OUT}  ($(du -h "${OUT}" | cut -f1))"
echo "Contents:"
unzip -l "${OUT}" | sed 's/^/  /'
echo ""
echo "Upload at https://chrome.google.com/webstore/devconsole  (one-time \$5 developer registration)."
echo "Listing copy + permission justifications: store-listing/listing.md"
