# Fable

Fable is an open-source AI workspace for real work. It lets you chat with your computer, delegate tasks across your tools and files, and stay in control at every step.

Local-first and private by default, Fable is built for people who want powerful AI assistance without giving up ownership of their work.

## Current Slice

- Tauri 2 desktop shell with Chats, Projects, Knowledge, Plugins, and Automations navigation.
- Universal composer with text, voice, attachments, `@` tools, slash commands, and send affordances.
- Contextual directive cards that fill the composer instead of behaving like task cards.
- Knowledge view with sources, memory provenance, and source pinning.
- Plugin view with connector permissions, health, and composer insertion.
- Automation view with draft/active status and approval routing for scheduled work.
- Approval flow with once/session/rule/modify/deny decisions and audit history.
- Local recovery for composer drafts, pinned sources, automation status, and approval audit.
- Protocol types for approvals, memory, connector health, directives, and runtime snapshots.
- Native API-key agent path for OpenAI-compatible, Anthropic, Gemini, xAI, and OpenRouter providers, with keys held by the local credential boundary.
- First-wave connector boundaries with explicit fixture previews, Google public-client PKCE support, and broker-gated confidential connectors that fail closed until configured.

## Brand

Brand assets live in `apps/desktop/public/brand`:

- `fable-mark.svg`
- `fable-mark-graphite.svg`
- `fable-wordmark.svg`
- `fable-logo.svg`
- `fable-logo-dark.svg`
- `fable-app-icon.svg`

The product position and usage notes are documented in `docs/brand.md`.

## Commands

```bash
pnpm install
pnpm dev
pnpm check
```

Tauri checks use:

```bash
pnpm tauri:check
```

### First-time build / stale cache

If `pnpm tauri:check` (or `cargo check`/`cargo test` under `apps/desktop/src-tauri`)
fails with a path referencing an old repo name — e.g. the directory was ever
cloned/renamed from `arden` to `fable`, leaving incremental cache pointing at the
old absolute path — clear the stale target directory once:

```bash
cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml
```

This is a cache artifact, not a code defect. A fresh rebuild after `cargo clean`
compiles and runs all Rust tests cleanly. (CI runs against a fresh checkout and
is unaffected.)

Windows bundles use:

```bash
pnpm tauri:build
```

Expected local build outputs:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`
