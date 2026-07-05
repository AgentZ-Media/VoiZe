# Code-Signierung (damit „Direkt einfügen" dauerhaft funktioniert)

## Das Problem in einem Satz

macOS merkt sich die Bedienungshilfe-Freigabe pro **Code-Signatur** der App. Bisher
wurde VoiZe **ad-hoc** signiert – dabei bekommt die App bei *jedem* Build eine neue
Signatur. Die einmal erteilte Freigabe passt dann nicht mehr zum neuen Build, macOS
liefert intern „nicht erlaubt" zurück, und die App fällt still auf „nur Zwischenablage"
zurück – obwohl VoiZe in den Systemeinstellungen scheinbar noch aktiviert ist.

**Lösung ohne Apple-Notarisierung:** ein festes, selbstsigniertes Zertifikat. Damit
bleibt die Signatur-Identität über alle Builds gleich, und die Freigabe hält dauerhaft.

---

## Einrichtung – einmalig, ca. 2 Minuten

Alles im Terminal, im Projektordner (`~/Desktop/Code/VoiZe`).

### Schritt 1 – Zertifikat anlegen

```bash
./scripts/create-signing-cert.sh
```

Was passiert:
- Es wird ein selbstsigniertes Code-Signing-Zertifikat namens **„VoiZe Code Signing"**
  erzeugt und in deinen Anmeldeschlüsselbund gelegt.
- macOS fragt **einmal nach deinem Mac-Anmeldepasswort** (`sudo`), um das Zertifikat als
  vertrauenswürdig zu markieren. Das ist normal – das Passwort wird nur lokal genutzt.

Am Ende siehst du die Zeile mit „VoiZe Code Signing" in der Liste. Fertig.

### Schritt 2 – Signierte App bauen und installieren

```bash
./scripts/build-signed.sh --install
```

Was passiert:
- Die App wird mit deinem festen Zertifikat gebaut (nicht mehr ad-hoc).
- **Beim ersten Mal** fragt macOS, ob `codesign` deinen Schlüssel benutzen darf →
  auf **„Immer erlauben"** klicken.
- Die fertige App wird nach `/Applications/VoiZe.app` kopiert (ersetzt die alte).

### Schritt 3 – Alte Freigabe einmalig zurücksetzen

Weil die alte Freigabe noch an der ad-hoc-Signatur hängt, einmal aufräumen:

1. **Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen** öffnen.
2. Falls dort ein **VoiZe** steht: markieren und mit **„–"** entfernen.
3. VoiZe (aus `/Applications`) starten.
4. Mit **„+"** die neue `VoiZe.app` hinzufügen und den Schalter aktivieren.

Ab jetzt hält die Freigabe über **alle** zukünftigen Builds mit diesem Zertifikat.

---

## Ab jetzt: neue Version bauen

Immer statt `npm run tauri build`:

```bash
./scripts/build-signed.sh --install
```

Die Bedienungshilfe-Freigabe bleibt erhalten – kein erneutes Freischalten nötig.

---

## Kontrolle: hat es geklappt?

```bash
codesign -d -r- /Applications/VoiZe.app 2>&1 | grep designated
```

- **Gut (stabil):** `designated => identifier "de.agentz.voize" and certificate leaf = H"..."`
- **Schlecht (ad-hoc, instabil):** `designated => cdhash H"..."`

Bei „certificate leaf" ist alles richtig – die Regel hängt am Zertifikat, nicht mehr am
sich ändernden cdhash.

---

## Wichtige Einordnung

- **Nur für deinen eigenen Rechner / lokale Builds.** Ein selbstsigniertes Zertifikat ist
  nur auf *diesem* Mac vertrauenswürdig. Wenn du die App später auf einem anderen Mac
  installierst, meldet sich Gatekeeper („unbekannter Entwickler") – dort dann per
  Rechtsklick → „Öffnen" starten.
- **GitHub-Releases bleiben vorerst ad-hoc.** Die automatischen Builds in GitHub Actions
  kennen dieses Zertifikat nicht. Wenn du VoiZe für dich selbst nutzt, baue lokal mit
  `build-signed.sh`. Sollen auch die Releases die Freigabe behalten, muss das Zertifikat
  als Secret in die CI – das ist ein separater, optionaler Schritt.
- **Keine Notarisierung nötig.** Signieren ≠ Notarisieren. Für die dauerhafte
  Bedienungshilfe-Freigabe auf dem eigenen Rechner reicht das Signieren.

---

## Deinstallieren / rückgängig machen

Zertifikat wieder entfernen:

```bash
sudo security delete-certificate -c "VoiZe Code Signing" /Library/Keychains/System.keychain
security delete-identity -c "VoiZe Code Signing"
```
