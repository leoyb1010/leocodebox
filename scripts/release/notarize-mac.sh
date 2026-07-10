#!/usr/bin/env bash
#
# Notarize + staple a signed leocodebox DMG using a keychain-stored notarytool
# profile, so Apple credentials never appear on the command line or in the repo.
#
# One-time setup (you run this yourself; the password is typed into your Terminal
# and stored in the login keychain — it is never passed through any tool):
#
#   xcrun notarytool store-credentials "leocodebox" \
#     --apple-id "YOUR_APPLE_ID@example.com" \
#     --team-id  "YOUR_TEAM_ID" \
#     --password "APP_SPECIFIC_PASSWORD"   # from appleid.apple.com
#
# Then:  npm run desktop:notarize:mac [path/to/leocodebox-*.dmg]
#
set -euo pipefail

PROFILE="${LEOCODEBOX_NOTARY_PROFILE:-leocodebox}"
DMG="${1:-release/desktop/leocodebox-$(node -p "require('./package.json').version")-mac-arm64.dmg}"

if [ ! -f "$DMG" ]; then
  echo "error: DMG not found: $DMG" >&2
  echo "build a signed DMG first:  LEOCODEBOX_SIGN_IDENTITY=\"Developer ID Application: NAME (TEAM)\" npm run desktop:dist:mac:signed" >&2
  exit 1
fi

echo "==> Verifying the DMG's app is Developer ID signed (not adhoc)"
if ! codesign -dv --verbose=2 "$DMG" 2>&1 | grep -qi "Developer ID Application"; then
  echo "warning: could not confirm a Developer ID signature on $DMG — notarization will fail if the app is unsigned/adhoc." >&2
fi

echo "==> Submitting to Apple notary service (profile: $PROFILE). This can take several minutes."
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

echo "==> Stapling the notarization ticket into the DMG"
xcrun stapler staple "$DMG"

echo "==> Gatekeeper assessment"
spctl -a -vvv --type install "$DMG" || true

echo "Done: $DMG is signed, notarized, and stapled."
