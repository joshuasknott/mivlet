# Praxis

Praxis is an AI-native workspace for tools, knowledge, memory, and work.

The first implementation slice is a Tauri 2 desktop app with a React and Vite UI. It focuses on the selected first-run workspace: a Codex-like navigation model, a universal composer, contextual workspace directives, and inspectable surfaces for knowledge, plugins, automations, memory, and approvals.

## Current Slice

- Desktop shell with Chats, Projects, Knowledge, Plugins, and Automations navigation.
- Merged profile and settings entry.
- Universal composer with text, voice, attachments, `@` tools, slash commands, and send affordances.
- Contextual directive cards that fill the composer instead of behaving like task cards.
- Knowledge view with sources, memory provenance, and source pinning.
- Plugin view with connector permissions, health, and composer insertion.
- Automation view with draft/active status and approval routing for scheduled work.
- Approval flow with once/session/rule/modify/deny decisions and audit history.
- Local recovery for composer drafts, pinned sources, automation status, and approval audit.
- Protocol types for approvals, memory, connector health, and directives.
- Fixture-backed connector adapters for local files, GitHub, Vercel, Slack, Notion, Linear, and Google Drive.

## QA Evidence

- Desktop screenshot: `output/qa/praxis-home-1440x1024-v6.png`
- Mobile screenshot: `output/qa/praxis-home-390x844-v6.png`
- Visual QA report: `design-qa.md`

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

Current local build outputs:

- `apps/desktop/src-tauri/target/release/bundle/msi/Praxis_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Praxis_0.1.0_x64-setup.exe`
