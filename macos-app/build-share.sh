#!/usr/bin/env bash
# Builds the Share extension (a .appex for the system Share menu) without an Xcode project: compile with
# swiftc, link as an app extension, assemble the bundle, embed it in the app and sign it.
#   usage: build-share.sh <app dir> <version> [signing identity]
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$1"; VERSION="$2"; IDENTITY="${3:-}"
APPEX="${APP_DIR}/Contents/PlugIns/ThreadShare.appex"
SDK="$(xcrun --show-sdk-path)"
OUT="$(mktemp -d)"

echo "Building Share extension..."
for ARCH in ${THREAD_WIDGET_ARCHS:-arm64 x86_64}; do
  xcrun swiftc -O -parse-as-library -module-name ThreadShare -application-extension \
    -target "${ARCH}-apple-macos15.0" -sdk "${SDK}" \
    -framework AppKit -framework SwiftUI \
    -Xlinker -e -Xlinker _NSExtensionMain \
    ShareExtension/ShareViewController.swift Sources/ThreadMac/ShareInbox.swift Sources/ThreadMac/WidgetSnapshot.swift \
    -o "${OUT}/ThreadShare-${ARCH}"
done
rm -rf "${APPEX}"
mkdir -p "${APPEX}/Contents/MacOS" "${APPEX}/Contents/Resources"
lipo -create "${OUT}"/ThreadShare-* -output "${APPEX}/Contents/MacOS/ThreadShare"
sed "s/__VERSION__/${VERSION}/g" ShareExtension/Info.plist > "${APPEX}/Contents/Info.plist"
[ -f dist/AppIcon.icns ] && cp dist/AppIcon.icns "${APPEX}/Contents/Resources/AppIcon.icns"
rm -rf "${OUT}"

if [ -n "${IDENTITY}" ]; then
  codesign --force --options runtime --timestamp --entitlements ShareExtension/ThreadShare.entitlements \
    --sign "${IDENTITY}" "${APPEX}"
else
  codesign --force --entitlements ShareExtension/ThreadShare.entitlements --sign - "${APPEX}"
fi
echo "  -> ${APPEX}"
