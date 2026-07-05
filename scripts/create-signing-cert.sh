#!/usr/bin/env bash
#
# Erstellt einmalig ein selbstsigniertes Code-Signing-Zertifikat für VoiZe.
#
# Warum: macOS bindet die Bedienungshilfe-Berechtigung an die Code-Signatur der
# App. Ad-hoc-Builds bekommen bei JEDEM Build eine neue Signatur (cdhash) -> die
# einmal erteilte Freigabe passt danach nicht mehr, und "Direkt einfügen"
# funktioniert nicht. Mit einem festen, selbstsignierten Zertifikat bleibt die
# Signatur-Identität über alle Builds gleich, und die Freigabe hält dauerhaft.
#
# Nur einmal ausführen. Danach immer mit scripts/build-signed.sh bauen.

set -euo pipefail

CERT_NAME="VoiZe Code Signing"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "Identität \"$CERT_NAME\" existiert bereits – nichts zu tun."
  security find-identity -v -p codesigning | grep "$CERT_NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $CERT_NAME
[ v3 ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

echo "1/4  Erzeuge selbstsigniertes Code-Signing-Zertifikat (10 Jahre gültig) ..."
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf" 2>/dev/null

# Die .p12 braucht ein NICHT-leeres Passwort: macOS' `security import` scheitert
# bei leerem Passwort an der MAC-Verifikation ("MAC verification failed"). Das
# Passwort ist rein temporär – es transportiert Schlüssel+Zertifikat nur in den
# Schlüsselbund und wird danach nicht mehr gebraucht.
# -legacy ist bei OpenSSL 3 zusätzlich nötig (neuer SHA-256-MAC ist inkompatibel);
# falls das lokale openssl LibreSSL ist (kennt -legacy nicht), ohne das Flag bauen.
P12_PASS="voize-transient"
if openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$CERT_NAME" -out "$TMP/bundle.p12" -passout "pass:$P12_PASS" 2>/dev/null; then
  :
else
  openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -name "$CERT_NAME" -out "$TMP/bundle.p12" -passout "pass:$P12_PASS" 2>/dev/null
fi

echo "2/4  Importiere das Zertifikat in deinen Anmeldeschlüsselbund ..."
security import "$TMP/bundle.p12" -k "$LOGIN_KEYCHAIN" -P "$P12_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

echo "3/4  Markiere das Zertifikat als vertrauenswürdig fürs Code-Signing."
echo "     macOS fragt jetzt EINMAL nach deinem Mac-Anmeldepasswort (sudo):"
sudo security add-trusted-cert -d -r trustRoot -p codeSign \
  -k /Library/Keychains/System.keychain "$TMP/cert.pem"

echo "4/4  Fertig. Verfügbare Signing-Identitäten:"
security find-identity -v -p codesigning | grep "$CERT_NAME" || {
  echo "WARNUNG: Identität nicht in der Liste – bitte melde dich, falls der"
  echo "nächste Build fehlschlägt."
}

echo ""
echo "Nächster Schritt:  ./scripts/build-signed.sh --install"
