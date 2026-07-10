<div align="center">

<img src="app-icon.png" alt="VoiZe" width="110" />

# VoiZe

**Sprechen statt tippen — überall auf deinem Mac.**

Taste halten, sprechen, loslassen. Dein Text erscheint direkt dort, wo dein Cursor steht.
Standardmäßig 100 % lokal und ohne Abo. Optional kannst du über deinen eigenen OpenRouter-Key in der Cloud transkribieren.

[![Download](https://img.shields.io/github/v/release/AgentZ-Media/VoiZe?label=Download&color=6e56cf&style=for-the-badge)](https://github.com/AgentZ-Media/VoiZe/releases/latest)
&nbsp;
![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111?style=for-the-badge&logo=apple)
&nbsp;
![Privat](https://img.shields.io/badge/Transkription-Local--first-2da44e?style=for-the-badge)

</div>

---

## So funktioniert's

<table>
<tr>
<td align="center" width="33%"><h3>1&nbsp;&nbsp;🎙️</h3><b><kbd>Fn</kbd> gedrückt halten</b><br/><sub>In jeder App — Mail, Browser, Editor, Slack, Terminal. Eine dezente Pille am unteren Bildschirmrand zeigt, dass VoiZe zuhört.</sub></td>
<td align="center" width="33%"><h3>2&nbsp;&nbsp;💬</h3><b>Einfach sprechen</b><br/><sub>Deutsch, Englisch oder gemischt. Standardmäßig läuft die Spracherkennung komplett auf deinem Mac; Cloud-Transkription ist ein bewusstes Opt-in.</sub></td>
<td align="center" width="33%"><h3>3&nbsp;&nbsp;✨</h3><b>Loslassen — fertig</b><br/><sub>Der Text landet sofort im aktiven Eingabefeld oder in der Zwischenablage. Auf Wunsch von KI ausformuliert.</sub></td>
</tr>
</table>

## Warum VoiZe?

|  | **VoiZe** | Wispr Flow | superwhisper | macOS Diktat |
|---|:---:|:---:|:---:|:---:|
| **Preis** | **Kostenlos** | Abo | Abo / Kauf | Kostenlos |
| **Transkription lokal** | ✅ Standard | ❌ Cloud | ✅ optional | teilweise |
| **Funktioniert in jeder App** | ✅ | ✅ | ✅ | eingeschränkt |
| **Push-to-talk (Taste halten)** | ✅ `Fn` | ✅ | ✅ | ❌ |
| **KI-Nachbearbeitung** | ✅ optional, eigener API-Key | ✅ | ✅ | ❌ |
| **Persönliches Wörterbuch** | ✅ lernt automatisch | ✅ | ✅ | ❌ |
| **Verlauf mit Suche** | ✅ lokal | ✅ Cloud | ✅ | ❌ |
| **Open Source** | ✅ | ❌ | ❌ | ❌ |

VoiZe nutzt **NVIDIA Parakeet** (eines der präzisesten offenen Sprachmodelle) direkt eingebettet in der App — es gibt **keine Abhängigkeiten**, die du installieren musst. Kein Python, kein Homebrew, kein Terminal. Beim ersten Start lädt VoiZe einmalig das Sprachmodell (~670 MB) und ist danach komplett offline einsatzbereit.

## Features

- 🎯 **Direkt einfügen** — der Text erscheint im fokussierten Eingabefeld, alternativ in der Zwischenablage
- ⚡ **Sofort bereit** — das Modell bleibt im Speicher, Folge-Diktate starten ohne Verzögerung
- 🧠 **KI-Feinschliff (optional)** — Formatierung, Absätze und Listen über OpenRouter mit deinem eigenen API-Key
- 📖 **Lernendes Wörterbuch** — Eigennamen und Fachbegriffe werden erkannt und automatisch vorgeschlagen
- 🕘 **Lokaler Verlauf** — jedes Diktat lässt sich später durchsuchen und erneut kopieren
- 🔒 **Privat by Design** — Audio wird nie gespeichert; hochgeladen wird es nur im ausdrücklich gewählten Cloud-Modus
- 🖥️ **Native Menüleisten-App** — kein Dock-Icon, kein Fenster im Weg, echtes macOS-Material

## Tastenkürzel

| Aktion | Standard | Alternativ |
|---|---|---|
| **Diktieren (halten)** | <kbd>Fn</kbd> | <kbd>Ctrl</kbd>+<kbd>Opt</kbd> |
| **Freihand-Modus (Start/Stopp)** | <kbd>Fn</kbd>+<kbd>Space</kbd> | <kbd>Ctrl</kbd>+<kbd>Opt</kbd>+<kbd>Space</kbd> |
| **Abbrechen** | <kbd>Esc</kbd> | — |

Alle Kürzel lassen sich in den Einstellungen frei anpassen.

## Installation

1. **[Neueste Version laden](https://github.com/AgentZ-Media/VoiZe/releases/latest)** (`.dmg`) und VoiZe in den Programme-Ordner ziehen.
2. Da die App noch nicht notarisiert ist, einmalig das Quarantäne-Attribut entfernen:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/VoiZe.app"
   ```
3. VoiZe starten — die App führt dich durch den einmaligen Modell-Download und fragt die nötigen Berechtigungen an:
   - **Mikrofon** → für die Aufnahme
   - **Bedienungshilfen** → damit der Text direkt eingefügt werden kann (ohne diese Berechtigung landet er in der Zwischenablage)

Danach lebt VoiZe in deiner Menüleiste und wartet auf <kbd>Fn</kbd>. Updates installiert die App auf Wunsch selbst.

---

<details>
<summary><b>🛠️ Für Entwickler</b></summary>

### Stack

Tauri 2 · React · Rust. Die Spracherkennung läuft in-process über [`transcribe-rs`](https://crates.io/crates/transcribe-rs) (Parakeet TDT 0.6b v3, int8 ONNX) — ONNX Runtime wird zur Build-Zeit statisch gelinkt, zur Laufzeit gibt es null externe Abhängigkeiten.

### Entwickeln

```bash
npm install
npm run tauri dev
```

Rust separat prüfen: `cd src-tauri && cargo check`

### Release bauen

Der Updater braucht eine Tauri-Signatur (private Datei, gehört nicht ins Repo):

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.codex/keys/voize-tauri-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri build
```

Artefakte: `src-tauri/target/release/bundle/macos/VoiZe.app` und `.../dmg/VoiZe_*.dmg`

### Release veröffentlichen

Ein Versionstag löst die GitHub Action aus, die den Apple-Silicon-Build baut und die Updater-Dateien (`latest.json`) veröffentlicht:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Benötigtes Repo-Secret: `TAURI_SIGNING_PRIVATE_KEY`

### OpenRouter-Key (optional, für Cloud-Transkription und KI-Nachbearbeitung)

Wird lokal in der macOS-Keychain gespeichert — nie in `settings.json`, nie im Repo. Eintragen unter **Einstellungen → KI** oder direkt:

```bash
security add-generic-password -a voize -s de.agentz.voize.openrouter_api_key -w "sk-or-v1-..." -U
```

</details>
