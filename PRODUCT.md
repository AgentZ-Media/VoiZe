# Product

## Register

product

## Users

VoiZe is for a single Mac power user who wants fast, private-feeling dictation in every app without opening a chat window. The user is often writing in German and English across browsers, editors, notes, messaging, email, and terminals, and expects the tool to stay out of the way until the push-to-talk shortcut is held.

## Product Purpose

VoiZe is a local-first macOS menu-bar dictation layer built with Tauri 2. It records speech, transcribes locally with NVIDIA Parakeet, optionally polishes the text through OpenRouter, and then inserts the result into the focused app or copies it to the clipboard. Success means it feels like a native system capability: press, speak, release, and clean text lands where the cursor already is.

## Brand Personality

Native, quiet, precise. The product should feel related to Otto: a restrained macOS utility with real material, system typography, dark glass, and one purposeful animated presence. It should not feel like a SaaS dashboard, a chatbot, or a loud AI toy.

## Anti-references

- Generic SaaS dashboards with marketing cards, big gradient heroes, or decorative metrics.
- Chat-first dictation tools where the transcript lives in a conversation instead of the active text field.
- Neon sci-fi, waveform clutter, and fake technical telemetry.
- Web-app chrome that fights macOS conventions.
- Secret-bearing config committed to Git.

## Design Principles

1. System layer, not destination app. VoiZe lives in the menu bar and appears only as a small recording surface or settings window.
2. Speech state is visible at a glance. The bottom pill shows listening, transcribing, polishing, copied, inserted, or failed without verbose explanation.
3. Local first, AI optional. Parakeet transcription works locally; OpenRouter enhances formatting, context, and learning only when enabled.
4. Recovery is built in. Every dictation is saved with time, app context, raw text, final text, and delivery mode so the user can copy or retry later.
5. Settings behave like macOS settings. Autosave, calm density, clear controls, and no decorative onboarding.

## Accessibility & Inclusion

- Target WCAG AA contrast for all settings and history text.
- Respect `prefers-reduced-motion`; waveform and pill transitions become quieter without hiding state.
- Keyboard focus must be visible in settings.
- Color is never the only status signal.
- The app clearly surfaces macOS microphone and accessibility permission needs.
