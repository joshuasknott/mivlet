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
- Fixture-backed connector adapters for local files, GitHub, Vercel, Slack, Notion, Linear, and Google Drive.

## Brand

Brand assets live in `apps/desktop/public/brand`:

- `fable-mark.svg`
- `fable-mark-graphite.svg`
- `fable-wordmark.svg`
- `fable-logo.svg`
- `fable-logo-dark.svg`
- `fable-app-icon.svg`

The product position and usage notes are documented in `docs/brand.md`.

## QA Evidence

- Desktop screenshot: `docs/design/qa/fable-after-1440x1024.png`
- Mobile screenshot: `docs/design/qa/fable-after-390x844.png`
- Connectors screenshot: `docs/design/qa/fable-after-connectors-1440x1024.png`
- Visual QA report: `design-qa.md`

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

Windows bundles use:

```bash
pnpm tauri:build
```

Expected local build outputs:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`
