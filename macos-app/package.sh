#!/bin/sh
# Builds a real, double-clickable ThreadMac.app and zips it for distribution.
#
# This produces an UNSIGNED (ad-hoc signed only, by swift build's default behavior) app.
# Gatekeeper will show an "unidentified developer" warning on first launch after download --
# the user needs to right-click -> Open once per downloaded build to bypass it. That's a real,
# known limitation of this distribution path, not a bug in this script -- see README.md for why
# that's the deliberate choice for now (no Apple Developer account available to this build
# process) and what it would take to remove it.
set -e

cd "$(dirname "$0")"

APP_NAME="ThreadMac"
BUNDLE_ID="com.thread.mac"
VERSION="0.2.0"
BUILD_DIR=".build/release"
APP_DIR="dist/${APP_NAME}.app"

echo "Building release binary..."
swift build -c release

echo "Building app icon..."
./icon.sh

echo "Assembling ${APP_DIR}..."
rm -rf "${APP_DIR}" "dist/${APP_NAME}-${VERSION}-macos.zip"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${BUILD_DIR}/${APP_NAME}" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp "dist/AppIcon.icns" "${APP_DIR}/Contents/Resources/AppIcon.icns"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>Thread</string>
    <key>CFBundleDisplayName</key>
    <string>Thread</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Thread</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>com.thread.mac.url</string>
            <key>CFBundleURLSchemes</key>
            <array><string>thread</string></array>
        </dict>
    </array>
    <key>NSServices</key>
    <array>
        <dict>
            <key>NSMenuItem</key>
            <dict><key>default</key><string>Recall in Thread</string></dict>
            <key>NSMessage</key>
            <string>recallInThread</string>
            <key>NSPortName</key>
            <string>Thread</string>
            <key>NSSendTypes</key>
            <array>
                <string>public.utf8-plain-text</string>
                <string>NSStringPboardType</string>
            </array>
            <key>NSRequiredContext</key>
            <dict><key>NSTextContent</key><string>Text</string></dict>
        </dict>
    </array>
</dict>
</plist>
PLIST

# --- App Intents metadata (Shortcuts / Spotlight / Siri discovery) -----------------------------
# SwiftPM has no App Intents build phase, so do the two steps Xcode's build system would:
#   1. swift-frontend emits a .swiftconstvalues for the module (needs a bare-JSON-array protocol
#      list -- the toolchain's own AppIntents.json uses a key the open-source frontend rejects).
#   2. appintentsmetadataprocessor turns that into Contents/Resources/Metadata.appintents.
# Best-effort: on a machine with only Command Line Tools (no Xcode) this is skipped and the app
# still works -- the intents just aren't discoverable there. The thread:// scheme always is.
DEVDIR="$(xcode-select -p 2>/dev/null || true)"
TC="${DEVDIR}/Toolchains/XcodeDefault.xctoolchain"
APMP="${TC}/usr/bin/appintentsmetadataprocessor"
MACOS_SDK="${DEVDIR}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
if [ -x "${APMP}" ] && [ -d "${MACOS_SDK}" ]; then
  echo "Generating App Intents metadata..."
  AI_WORK="$(mktemp -d)"
  find "${PWD}/Sources" -name '*.swift' | sort > "${AI_WORK}/sources.list"
  XCV="$(defaults read "${DEVDIR%/Developer}/version.plist" ProductBuildVersion 2>/dev/null || echo 0)"
  if "${TC}/usr/bin/swift-frontend" -typecheck \
       -emit-const-values-path "${AI_WORK}/${APP_NAME}.swiftconstvalues" \
       -const-gather-protocols-file "${PWD}/appintents-protocols.json" \
       @"${AI_WORK}/sources.list" \
       -sdk "${MACOS_SDK}" -target arm64-apple-macos15.0 -module-name "${APP_NAME}" \
       >"${AI_WORK}/frontend.log" 2>&1
  then
    printf '%s\n' "${AI_WORK}/${APP_NAME}.swiftconstvalues" > "${AI_WORK}/constvals.list"
    "${APMP}" \
      --output "${APP_DIR}/Contents/Resources" \
      --toolchain-dir "${TC}" \
      --module-name "${APP_NAME}" \
      --sdk-root "${MACOS_SDK}" \
      --xcode-version "${XCV}" \
      --platform-family macOS \
      --deployment-target 15.0 \
      --target-triple arm64-apple-macos15.0 \
      --source-file-list "${AI_WORK}/sources.list" \
      --swift-const-vals-list "${AI_WORK}/constvals.list" \
    && echo "  -> ${APP_DIR}/Contents/Resources/Metadata.appintents" \
    || echo "  (appintentsmetadataprocessor failed -- see above; intents still work when invoked directly)"
  else
    echo "  (const-value extraction failed -- skipping; $(tail -1 "${AI_WORK}/frontend.log"))"
  fi
  rm -rf "${AI_WORK}"
else
  echo "App Intents metadata: skipped (no Xcode toolchain) -- thread:// scheme still works."
fi

# --- Sign -------------------------------------------------------------------------------------
# Set THREAD_SIGN_IDENTITY to a "Developer ID Application: NAME (TEAMID)" identity for a real,
# hardened-runtime signature. With nothing set it falls back to ad-hoc (Gatekeeper shows
# "unidentified developer") -- what CI and a machine without the Apple Developer Program produce.
ENTITLEMENTS="${PWD}/Thread.entitlements"
if [ -n "${THREAD_SIGN_IDENTITY:-}" ]; then
  echo "Signing: ${THREAD_SIGN_IDENTITY}"
  codesign --force --options runtime --timestamp --entitlements "${ENTITLEMENTS}" \
    --sign "${THREAD_SIGN_IDENTITY}" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
  codesign --force --options runtime --timestamp --entitlements "${ENTITLEMENTS}" \
    --sign "${THREAD_SIGN_IDENTITY}" "${APP_DIR}"
  codesign --verify --deep --strict --verbose=1 "${APP_DIR}"
  SIGNED=1
else
  # swift build ad-hoc signs the raw binary; re-sign the whole bundle so it's internally
  # consistent after Info.plist and Metadata.appintents were added.
  codesign --force --deep --sign - "${APP_DIR}"
  SIGNED=0
fi

cd dist
zip -r -q "${APP_NAME}-${VERSION}-macos.zip" "${APP_NAME}.app"
cd ..

# DMG -- the polished Mac distribution surface (drag Thread.app -> Applications). This is the
# artifact the website's /download/mac endpoint serves. `npx create-dmg` gives the standard
# windowed layout; fall back to a plain hdiutil image if it's unavailable. Still UNSIGNED (see
# the header). Output name is stable ("Thread.dmg") so replacing it never changes the site CTA.
echo "Building DMG..."
rm -f "dist/Thread.dmg" "dist/Thread ${VERSION}.dmg"
npx --yes create-dmg "dist/${APP_NAME}.app" dist/ >/dev/null 2>&1 || true
if [ -f "dist/Thread ${VERSION}.dmg" ]; then
  mv "dist/Thread ${VERSION}.dmg" "dist/Thread.dmg"
else
  DMG_STAGE="$(mktemp -d)"
  cp -R "${APP_DIR}" "${DMG_STAGE}/Thread.app"
  ln -s /Applications "${DMG_STAGE}/Applications"
  hdiutil create -volname "Thread" -srcfolder "${DMG_STAGE}" -ov -format UDZO -quiet "dist/Thread.dmg"
  rm -rf "${DMG_STAGE}"
fi

# --- Notarize + staple (only when signed with a real identity) ------------------------------
if [ "${SIGNED:-0}" = 1 ]; then
  codesign --force --timestamp --sign "${THREAD_SIGN_IDENTITY}" "dist/Thread.dmg"

  NOTARY_ARGS=""
  if [ -n "${THREAD_NOTARY_PROFILE:-}" ]; then
    NOTARY_ARGS="--keychain-profile ${THREAD_NOTARY_PROFILE}"
  elif [ -n "${THREAD_NOTARY_APPLE_ID:-}" ] && [ -n "${THREAD_NOTARY_PASSWORD:-}" ] && [ -n "${THREAD_NOTARY_TEAM_ID:-}" ]; then
    NOTARY_ARGS="--apple-id ${THREAD_NOTARY_APPLE_ID} --password ${THREAD_NOTARY_PASSWORD} --team-id ${THREAD_NOTARY_TEAM_ID}"
  fi

  if [ -n "${NOTARY_ARGS}" ]; then
    echo "Notarizing dist/Thread.dmg (waits for Apple)..."
    # shellcheck disable=SC2086
    xcrun notarytool submit "dist/Thread.dmg" ${NOTARY_ARGS} --wait
    xcrun stapler staple "dist/Thread.dmg"
    xcrun stapler validate "dist/Thread.dmg" && echo "  notarized + stapled"
  else
    echo "  DMG signed, NOT notarized -- set THREAD_NOTARY_PROFILE (a stored notarytool profile)"
    echo "  or THREAD_NOTARY_APPLE_ID + THREAD_NOTARY_PASSWORD + THREAD_NOTARY_TEAM_ID."
  fi
fi

echo ""
echo "Built:  ${APP_DIR}"
echo "Zipped: dist/${APP_NAME}-${VERSION}-macos.zip"
echo "DMG:    dist/Thread.dmg   ->  copy to  mind-stream-continuity/public/downloads/Thread.dmg"
echo ""
if [ "${SIGNED:-0}" = 1 ]; then
  echo "Signed with a Developer ID identity."
  [ -n "${NOTARY_ARGS:-}" ] || echo "Not notarized -- Gatekeeper will still warn until you notarize + staple."
else
  echo "UNSIGNED (ad-hoc). To run: right-click the .app -> Open (first launch only)."
  echo "To ship without that: set THREAD_SIGN_IDENTITY (+ notary creds) and re-run -- see README."
fi
