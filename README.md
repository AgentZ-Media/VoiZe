# VoiZe

![VoiZe app icon](app-icon.png)

VoiZe ist eine lokale macOS-Diktier-App in Tauri 2. Sie lebt in der Menüleiste, transkribiert lokal mit Parakeet, kann Texte über OpenRouter nachbearbeiten und fügt das Ergebnis direkt in die fokussierte App ein oder legt es in die Zwischenablage.

## Features

- Menüleisten-App ohne Dock-Icon, außer wenn die Einstellungen geöffnet sind.
- Push-to-talk Standard wie Wispr Flow: `Fn`, mit `Ctrl+Opt` als robuste Alternative für externe Tastaturen.
- Hands-free Toggle: `Fn+Space`.
- Lokale Batch-Transkription über `parakeet-mlx` / NVIDIA Parakeet.
- OpenRouter-Nachbearbeitung mit auswählbarem Modell.
- Persönliches Wörterbuch, lokale Verlaufssuche und lernende Wörterbuch-Vorschläge.
- Direktes Einfügen per Clipboard + `Cmd+V`, mit Clipboard-Wiederherstellung.
- Start-/Finish-Sound, waveformartige Aufnahme-Pille, Autostart und Tauri-Updater.

## Lokale Voraussetzungen

```bash
brew install ffmpeg
python3 -m pip install -U parakeet-mlx
npm install
```

Der empfohlene lokale ASR-Pfad auf Apple Silicon ist:

```bash
parakeet-mlx audio.wav --model mlx-community/parakeet-tdt-0.6b-v3
```

VoiZe ruft intern `scripts/parakeet_transcribe.py` auf. Falls `parakeet-mlx` fehlt, versucht das Skript einen Transformers-Fallback mit `nvidia/parakeet-tdt-0.6b-v3`.

## Entwickeln

```bash
npm run tauri dev
```

Frontend separat:

```bash
npm run dev
npm run build
```

Rust prüfen:

```bash
cd src-tauri
cargo check
```

## Lokalen Release-Build erstellen

Der Updater braucht eine Tauri-Signatur. Die private Signaturdatei gehört nicht ins Repo.

```bash
npx tauri signer generate --ci --write-keys ~/.codex/keys/voize-tauri-updater.key --force
```

Dann bauen:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.codex/keys/voize-tauri-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri build
```

Die fertige App liegt danach unter:

```bash
src-tauri/target/release/bundle/macos/VoiZe.app
src-tauri/target/release/bundle/dmg/VoiZe_0.1.0_aarch64.dmg
```

## Unsigned App auf macOS öffnen

Die App ist aktuell nicht notarisiert/signiert. Nach dem Kopieren nach `/Applications` kann macOS sie blockieren. Entferne dann das Quarantine-Attribut:

```bash
xattr -dr com.apple.quarantine "/Applications/VoiZe.app"
open "/Applications/VoiZe.app"
```

Wenn du die App direkt aus dem Build-Ordner startest:

```bash
xattr -dr com.apple.quarantine "src-tauri/target/release/bundle/macos/VoiZe.app"
open "src-tauri/target/release/bundle/macos/VoiZe.app"
```

Für die Aufnahme muss VoiZe unter **Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon** erlaubt sein. Für direktes Einfügen muss VoiZe außerdem unter **Bedienungshilfen** erlaubt sein.

## OpenRouter

Der API-Key wird lokal über die macOS-Keychain gespeichert, nicht in `settings.json` und nicht im Git-Repo. In der App unter **Einstellungen → KI** eintragen.

Für lokale Tests kann der Key auch direkt in die Keychain geschrieben werden:

```bash
security add-generic-password -a voize -s de.agentz.voize.openrouter_api_key -w "sk-or-v1-..." -U
```

## Updates über GitHub Releases

Die App nutzt `tauri-plugin-updater` und lädt `latest.json` aus:

```text
https://github.com/AgentZ-Media/VoiZe/releases/latest/download/latest.json
```

Für GitHub Actions ist dieses Secret gesetzt bzw. nötig:

```text
TAURI_SIGNING_PRIVATE_KEY
```

Ein Release wird über einen Versionstag ausgelöst:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Die Action baut Apple-Silicon- und Intel-macOS-Artefakte und veröffentlicht die Updater-Dateien.
