# VoiZe Design System

## Overview

VoiZe is a restrained macOS product UI inspired by Otto. It uses system typography, dark translucent utility surfaces, compact controls, and a single bottom recording pill as the primary visible affordance.

## Register

product

## Mood

Late-night macOS utility: quiet black glass, precise white text, small blue-green signal light, no theatrics.

## Color

Use a restrained dark palette. The recording state carries the brand accent; settings stay mostly neutral.

```css
:root {
  color-scheme: dark;
  --bg: oklch(0.09 0 0);
  --surface: oklch(0.18 0.012 260);
  --surface-2: oklch(0.23 0.014 260);
  --ink: oklch(0.96 0 0);
  --ink-muted: oklch(0.72 0.012 260);
  --ink-dim: oklch(0.56 0.012 260);
  --hairline: oklch(1 0 0 / 0.12);
  --primary: oklch(0.76 0.105 195);
  --accent: oklch(0.79 0.12 75);
  --danger: oklch(0.69 0.18 24);
  --success: oklch(0.74 0.12 150);
}
```

## Typography

Use the native macOS stack throughout:

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
```

Settings headings use 20px semibold. Labels use 12px medium. Body and control text use 13px. No display font.

## Surfaces

- Recording HUD: transparent always-on-top window with one full-pill surface at the bottom center.
- Settings: real decorated Tauri window with overlay titlebar, sidebar, and solid dark content.
- Cards are reserved for repeated history rows and compact setting groups. Radius tops out at 8px for cards and controls, while the HUD itself is a pill.

## Components

- Icon buttons use lucide-react icons with accessible labels.
- Toggles for booleans.
- Segmented controls for output destination.
- Searchable dropdown for OpenRouter model selection.
- Textareas for dictionary terms and post-processing instructions.
- History rows show date, focused app, mode, and copy/retry actions.

## Motion

Motion communicates state only: pill expand/collapse, waveform level changes, autosave confirmation, and status transitions. Durations stay between 150ms and 260ms. Reduced motion keeps state changes instant or crossfaded.
