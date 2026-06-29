# Roadmap

## Milestone 1: First Usable Workspace

- Done: build the desktop home surface.
- Done: make contextual directives populate the composer.
- Done: add fixture-backed connectors and protocol types.
- Done: add basic tests, build checks, Tauri check, and visual QA.
- Done: add lightweight Chats/Projects navigation with nested threads.

## Milestone 2: Approvals, Memory, And Recovery

- Done: approval history, once/session/rule grants, modify flows, deny handling, and high-risk confirmation are backed by Rust runtime resolution.
- Done: imported local knowledge appears in source inspection, pinned context, and composer directives.
- Done: composer search returns cited workspace sources with provenance, freshness, trust, and snippets.
- Done: memory can be edited, pinned, forgotten, disabled, and exported through Rust-backed state controls.
- Done: runtime snapshots recover drafts, active view, pinned sources, automations, dismissed approvals, imported sources, and memory through Rust-backed state.
- Done: knowledge sources can be approved into pinned durable memory with provenance and approval audit history through a Rust-backed promotion command.
- Next: richer provenance controls backed by encrypted local state.

## Milestone 3: Real Connectors

- Done: Local files connector imports selected text/Markdown/JSON/CSV/YAML through the Rust runtime with browser fallback tests.
- Done: first-wave GitHub, Vercel, Google Drive, Notion, Gmail, Slack, Google Calendar, and Linear protocol/catalog and pure fixture adapters.
- Done: connector status, health, scopes, search/import, and approval-gated action command boundaries fail closed when secure configuration is absent.
- Done: native credential boundaries and provider egress code paths for API-key agent providers, Google public-client connectors, and broker-gated connector adapters.
- Next: deploy the Fable auth broker, configure provider-console apps, and validate each live OAuth flow with non-production test accounts.

## Milestone 4: Voice And Automations

- Dictation and push-to-talk.
- Realtime conversation provider boundary.
- Captions, transcripts, interruption, retention controls, and fallback.
- Done: Schedules, recurring automations, notifications, and audit trails (persistence uses raw JSON files).
- Next: Migrate schedules and workflows from raw JSON to structured encrypted SQLite tables.

## Milestone 5: Site, Release, And CI

- Brand and marketing site.
- Security docs, legal pages, downloads, and Vercel preview.
- CI for lint, type, Rust, unit, integration, E2E, and security checks.
- Done: local Windows MSI and NSIS build.
- Next: signing, release notes, updater flow, and macOS/Linux preparation.
