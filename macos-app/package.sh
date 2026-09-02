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
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Thread</string>
</dict>
</plist>
PLIST

# Ad-hoc (re-)sign the assembled bundle -- swift build already ad-hoc signs the raw binary, but
# the bundle needs signing as a whole after Info.plist is added for it to be internally consistent.
codesign --force --deep --sign - "${APP_DIR}"

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

echo ""
echo "Built:  ${APP_DIR}"
echo "Zipped: dist/${APP_NAME}-${VERSION}-macos.zip"
echo "DMG:    dist/Thread.dmg   ->  copy to  mind-stream-continuity/public/downloads/Thread.dmg"
echo ""
echo "This is UNSIGNED (ad-hoc only). To run it: right-click the .app -> Open (first launch only)."
echo "World-class next step: an Apple Developer ID cert -> codesign + notarize + staple the DMG."
