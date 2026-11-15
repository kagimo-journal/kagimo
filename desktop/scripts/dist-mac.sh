#!/bin/bash
# The macOS release: a universal (Apple Silicon + Intel) Kagimo.app, signed with the Developer ID
# certificate and notarised, in a signed and notarised dmg at desktop/release/Kagimo-<version>-universal.dmg.
#
#   SIGNING_IDENTITY  the codesign identity (default: the team's Developer ID Application certificate)
#   NOTARY_PROFILE    a notarytool keychain profile (default: kagimo), made once with
#                     xcrun notarytool store-credentials kagimo --apple-id <id> --team-id S3FQ296564
#
# Needs desktop/renderer built first (make desktop-dist-mac does both).
set -euo pipefail
cd "$(dirname "$0")/.."

SIGNING_IDENTITY=${SIGNING_IDENTITY:-"Developer ID Application: Rare Substance PTY LTD (S3FQ296564)"}
NOTARY_PROFILE=${NOTARY_PROFILE:-kagimo}
VERSION=$(node -p "require('./package.json').version")
TARGET=src-tauri/target/universal-apple-darwin/release/bundle/macos
APP="$TARGET/Kagimo.app"
DMG="release/Kagimo-$VERSION-universal.dmg"

# The app, signed (hardened runtime: tauri.conf.json). Tauri signs; it doesn't notarise with a
# keychain profile, so that happens below.
APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY" npx tauri build --target universal-apple-darwin --bundles app

notarise() {
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json | tee /dev/stderr |
    node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); if (r.status !== "Accepted") { console.error("notarisation: " + r.status + " (xcrun notarytool log " + r.id + " --keychain-profile '"$NOTARY_PROFILE"')"); process.exit(1); }'
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Notarise the app, and staple the ticket to it so it opens without a network check.
ditto -c -k --keepParent "$APP" "$work/Kagimo.zip"
notarise "$work/Kagimo.zip"
xcrun stapler staple "$APP"

# The dmg: the app beside a link to Applications. Signed, notarised and stapled too, so
# Gatekeeper accepts the download itself.
mkdir -p "$work/dmg" release
cp -R "$APP" "$work/dmg/"
ln -s /Applications "$work/dmg/Applications"
rm -f "$DMG"
hdiutil create -volname Kagimo -srcfolder "$work/dmg" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
codesign --sign "$SIGNING_IDENTITY" --timestamp "$DMG"
notarise "$DMG"
xcrun stapler staple "$DMG"

spctl --assess --type execute -v "$APP"
spctl --assess --type open --context context:primary-signature -v "$DMG"
echo "$DMG"
