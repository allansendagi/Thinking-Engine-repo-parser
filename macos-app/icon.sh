#!/bin/sh
# Builds dist/AppIcon.icns from the Thread mark. macOS only (uses sips + iconutil).
set -e
cd "$(dirname "$0")"

swift icon.swift

SET=dist/AppIcon.iconset
rm -rf "$SET"
mkdir -p "$SET"
SRC=dist/AppIcon-1024.png

gen() { sips -z "$2" "$2" "$SRC" --out "$SET/icon_$1.png" >/dev/null; }
gen 16x16 16
gen 16x16@2x 32
gen 32x32 32
gen 32x32@2x 64
gen 128x128 128
gen 128x128@2x 256
gen 256x256 256
gen 256x256@2x 512
gen 512x512 512
gen 512x512@2x 1024

iconutil -c icns "$SET" -o dist/AppIcon.icns
echo "wrote dist/AppIcon.icns"
