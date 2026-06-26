# Arden

Arden is an open-source AI workspace for real work. It lets you chat with your computer, delegate tasks across your tools and files, and stay in control at every step.

Local-first and private by default, Arden is built for people who want powerful AI assistance without giving up ownership of their work.

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

- `arden-mark.svg`
- `arden-wordmark.svg`
- `arden-logo.svg`
- `arden-logo-dark.svg`

The product position and usage notes are documented in `docs/brand.md`.

## QA Evidence

- Desktop screenshot: `output/qa/praxis-home-1440x1024-v6.png`
- Mobile screenshot: `output/qa/praxis-home-390x844-v6.png`
- Visual QA report: `design-qa.md`

The screenshot filenames are historical artifacts from the pre-Arden working name.

## Commands

```bash
npm install
npm run dev
npm run check
```

Tauri checks use:

```bash
npm run tauri:check
```

Windows bundles use:

```bash
npm run tauri:build
```

Expected local build outputs:

- `apps/desktop/src-tauri/target/release/arden-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Arden_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Arden_0.1.0_x64-setup.exe`
