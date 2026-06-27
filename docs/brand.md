# Fable Brand

## Name

Fable is the product and project name. Use `Fable` in product UI, documentation, release notes, and public-facing copy.

## Positioning

Fable is an open-source AI workspace for real work. It lets people chat with their computer, delegate tasks across tools and files, and stay in control at every step.

Local-first and private by default, Fable is built for people who want powerful AI assistance without giving up ownership of their work.

Short tagline: Open AI workspace for real work.

## Logo

The Fable mark is a minimal copper dragon profile with a page-turn cut through its neck: ancient power, modern tool. It is serious, precise, and legible at app-icon and navigation sizes.

Use these assets:

- `apps/desktop/public/brand/fable-mark.svg`
- `apps/desktop/public/brand/fable-mark-graphite.svg`
- `apps/desktop/public/brand/fable-wordmark.svg`
- `apps/desktop/public/brand/fable-logo.svg`
- `apps/desktop/public/brand/fable-logo-dark.svg`
- `apps/desktop/public/brand/fable-app-icon.svg`
- `apps/desktop/src-tauri/icons/` for generated platform and installer sizes

Use the full lockup when space allows and the standalone mark for favicons, compact navigation, tray surfaces, and package metadata. Keep clear space around the logo equal to at least one quarter of the mark width.

## Colour

The identity uses warm graphite, warm off-white, and burnt copper:

- Graphite: `#17191A`
- Surface: `#F6F2EA`
- Copper: `#A16B3F`
- Strong copper: `#8A5832`

Copper is the only interactive accent. Green, yellow, and red are reserved for positive, caution, and destructive status. Avoid gradients, saturated interaction colors, neon effects, and decorative glow.

## Compatibility

- The Tauri application identifier remains `com.arden.workspace` so existing installations continue to resolve the same app-data and installation identity.
- Browser-preview state migrates from `arden.shell.v1` (and the older `praxis.shell.v1`) into `fable.shell.v1` without deleting the legacy key, preserving rollback safety.
- The `arden://backend/` Tauri event channel and `arden.memory.export.v1` envelope remain stable integration contracts.
- These are the only intentional legacy name references in the repository.

## Voice

Fable should sound direct, calm, and serious. Prefer plain language about control, ownership, privacy, permissions, tools, files, and real work.

Avoid hype words such as revolutionary, magic, supercharged, copilot, and agent army.
