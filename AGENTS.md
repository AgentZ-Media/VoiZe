# AGENTS.md

## Project

VoiZe is a Tauri 2 macOS menu-bar dictation app. It records locally, transcribes with NVIDIA Parakeet, optionally post-processes through OpenRouter, and inserts text into the focused app or copies it to the clipboard.

## Important Constraints

- Never commit API keys. OpenRouter keys are stored locally in the macOS Keychain through the settings backend.
- The app is intentionally menu-bar first. It should not show in the Dock unless the settings window is open.
- Keep UI aligned with Otto: native macOS feel, restrained dark material, system font, compact settings.
- Default dictation shortcut should match Wispr Flow as closely as possible: `Fn`, with `Ctrl+Opt` as the practical external-keyboard fallback.
- Direct insertion uses clipboard plus simulated paste, so macOS Accessibility permission matters.

## Main Areas

- `src-tauri/src/settings.rs`: settings, keychain, defaults.
- `src-tauri/src/db.rs`: SQLite history and dictionary.
- `src-tauri/src/asr.rs`: local Parakeet transcription bridge.
- `src-tauri/src/openrouter.rs`: model list and post-processing calls.
- `src-tauri/src/native.rs`: macOS context, accessibility, hotkey monitor, paste.
- `src/`: React HUD, settings, history, recording, and OpenRouter client flow.
- `scripts/parakeet_transcribe.py`: local Python ASR helper.

## Build And Verification

- Frontend: `npm run build`
- Tauri dev: `npm run tauri dev`
- Tauri bundle: `npm run tauri build`
- Rust check: `cd src-tauri && cargo check`

## Release Management

- Every GitHub release must include meaningful release notes. Keep them concise, but describe the user-visible changes, important fixes, and any update or permission caveats instead of using a generic placeholder.
- When preparing a release, update the GitHub release body for that tag so the in-app Über → Release Notes view can show useful history.

## Design Notes

Use product UI density. Avoid landing-page patterns, decorative gradients, and nested cards. Every visible state should help the user speak, review, insert, or recover dictation.
