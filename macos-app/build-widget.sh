#!/usr/bin/env bash
# Builds the Thread widget extension (a WidgetKit .appex) without an Xcode project: compile with swiftc,
# link as an app extension, assemble the bundle, embed it in the app and sign it.
#   usage: build-widget.sh <app dir> <version> [signing identity]
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$1"; VERSION="$2"; IDENTITY="${3:-}"
APPEX="${APP_DIR}/Contents/PlugIns/ThreadWidget.appex"
SDK="$(xcrun --show-sdk-path)"
OUT="$(mktemp -d)"

echo "Building widget extension..."
for ARCH in ${THREAD_WIDGET_ARCHS:-arm64 x86_64}; do
  xcrun swiftc -O -parse-as-library -module-name ThreadWidget -application-extension \
    -target "${ARCH}-apple-macos15.0" -sdk "${SDK}" \
    -framework WidgetKit -framework SwiftUI \
    -Xlinker -e -Xlinker _NSExtensionMain \
    Widget/ThreadWidget.swift Sources/ThreadMac/WidgetSnapshot.swift -o "${OUT}/ThreadWidget-${ARCH}"
done
rm -rf "${APPEX}"
mkdir -p "${APPEX}/Contents/MacOS"
lipo -create "${OUT}"/ThreadWidget-* -output "${APPEX}/Contents/MacOS/ThreadWidget"
sed "s/__VERSION__/${VERSION}/g" Widget/Info.plist > "${APPEX}/Contents/Info.plist"
rm -rf "${OUT}"

if [ -n "${IDENTITY}" ]; then
  codesign --force --options runtime --timestamp --entitlements Widget/ThreadWidget.entitlements \
    --sign "${IDENTITY}" "${APPEX}"
else
  codesign --force --entitlements Widget/ThreadWidget.entitlements --sign - "${APPEX}"
fi
echo "  -> ${APPEX}"
