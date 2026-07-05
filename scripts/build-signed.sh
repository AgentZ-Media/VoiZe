#!/usr/bin/env bash
#
# Baut VoiZe mit der festen, selbstsignierten Identität (statt ad-hoc), damit die
# Bedienungshilfe-Berechtigung über Builds hinweg erhalten bleibt.
#
#   ./scripts/build-signed.sh            # nur bauen
#   ./scripts/build-signed.sh --install  # bauen und nach /Applications kopieren
#
# Voraussetzung: einmalig scripts/create-signing-cert.sh ausgeführt.

set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${APPLE_SIGNING_IDENTITY:-VoiZe Code Signing}"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "Signing-Identität \"$IDENTITY\" nicht gefunden."
  echo "Bitte zuerst einmalig ausführen:  ./scripts/create-signing-cert.sh"
  exit 1
fi

export APPLE_SIGNING_IDENTITY="$IDENTITY"
echo "Baue signierte VoiZe-App mit Identität: $IDENTITY"
echo "(Beim ersten Mal fragt macOS, ob codesign den Schlüssel nutzen darf –"
echo " auf \"Immer erlauben\" klicken.)"
echo ""

# Nur das .app-Bundle bauen: kein DMG und – wichtig – keine Updater-Artefakte.
# Letztere würden am Ende die minisign-Signatur (TAURI_SIGNING_PRIVATE_KEY)
# verlangen, die lokal nicht gesetzt ist, und den Build abbrechen lassen. Die
# Updater-Pakete entstehen ohnehin nur in der GitHub-CI für Releases.
npm run tauri build -- --bundles app

APP="src-tauri/target/release/bundle/macos/VoiZe.app"

echo ""
echo "Signatur-Kontrolle der gebauten App:"
codesign -dvvv "$APP" 2>&1 | grep -E "^(Authority|Signature|Identifier)=" || true
echo "Designated Requirement (muss zertifikatsbasiert und damit stabil sein):"
codesign -d -r- "$APP" 2>&1 | grep "designated" || true

if [[ "${1:-}" == "--install" ]]; then
  echo ""
  echo "Installiere nach /Applications ..."
  rm -rf "/Applications/VoiZe.app"
  cp -R "$APP" "/Applications/VoiZe.app"
  # Falls die Kopie ein Quarantäne-Flag geerbt hat, entfernen (lokaler Build).
  xattr -dr com.apple.quarantine "/Applications/VoiZe.app" 2>/dev/null || true
  echo "Installiert: /Applications/VoiZe.app"
  echo ""
  echo "WICHTIG – einmalig: In Systemeinstellungen -> Datenschutz & Sicherheit"
  echo "-> Bedienungshilfen einen ALTEN VoiZe-Eintrag mit \"–\" entfernen und die"
  echo "neue App mit \"+\" hinzufügen. Ab dann hält die Freigabe über alle"
  echo "künftigen Builds mit diesem Zertifikat."
fi
