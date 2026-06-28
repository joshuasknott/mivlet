# Fable Status

Last audited: 2026-06-28.

This is the factual state of the repo, not the product pitch. Claims below were checked against current files in this checkout.

## Repo Shape

- The repo is a private pnpm monorepo named `fable`, with `@fable/desktop`, `@fable/broker`, `@fable/connectors`, and `@fable/protocol`.
- The desktop app is Tauri 2 plus React, TypeScript, and Vite.
- The Rust runtime is under `apps/desktop/src-tauri`.
- Product docs already exist for thesis, roadmap, architecture, connectors, release notes, and threat model.
- Brand assets exist under `apps/desktop/public/brand`.

## Implemented

- Desktop shell: local-profile onboarding, sidebar navigation, universal composer, theme toggle, model picker, permission picker, add menu, connector page, empty knowledge page, schedules page, profile page, and settings page.
- Composer: supports text entry, slash command insertion, local file import trigger, voice toggle UI, model selection, permission selection, and native-agent submit path when a connected native backend exists.
- Protocol package: defines approvals, memory, connectors, backend providers, runtime snapshots, native agent events, native tool specs, and tool-call request shapes.
- Local file import: supports `txt`, `md`, `markdown`, `json`, `csv`, `yaml`, and `yml`; rejects empty files, unsupported extensions, changed file sizes, and files over 2 MB; imported files are untrusted local knowledge with a 6,000-character preview.
- Knowledge search: lexical fallback search exists over known knowledge sources and returns cited snippets, scores, provenance, freshness, trust, and pin state.
- Approvals: Rust commands and shell UI support once/session/rule/modify/deny decisions, audit entries, approval rules, high-risk confirmation, and denied-action handling.
- Memory: Rust commands support listing, saving, exporting, disabling, editing through shell state, and approval-gated promotion from a knowledge source into durable memory.
- Local recovery: runtime snapshot, approval audit, approval rules, imported knowledge, memory state, schedules, and connected backend ids are persisted locally through app-data JSON files; browser preview also uses localStorage.
- Backend catalog: Codex, Cursor, GitHub Copilot, Grok, OpenAI, Anthropic, Gemini, xAI, and OpenRouter are modeled as agent-runtime backends. Only native API-key providers can become connected through the current credential command; subscription/CLI entries remain gated until real adapters exist.
- Backend credentials: Rust uses a keyring-backed credential boundary for backend secrets, with an in-memory fallback for headless/test paths. JavaScript receives auth state, capabilities, and models, not raw secrets.
- Native API agent loop: TypeScript owns provider request shaping and the pure agent loop; Rust owns API key lookup, HTTP/SSE egress, event emission, and cancellation for OpenAI-compatible, Anthropic, and Gemini-style providers.
- Tool execution: the registered tools are `read-file`, `write-file`, `run-shell`, and `web-fetch`; model tool calls route through approval before Rust re-validates and executes side effects.
- First-wave connector catalog: GitHub, Vercel, Google Drive, Notion, Gmail, Slack, and Google Calendar are modeled with scopes, auth mode, health/status metadata, search/import/action protocol shapes, and fixture adapters.
- Connector writes: fixture-side connector write preparation creates approval requests for GitHub, Vercel, Gmail, Slack, and Calendar actions instead of directly executing them.
- Tauri connector runtime: external connector commands expose status/auth/health/search/import/action boundaries. Google public-client connectors use loopback PKCE and OS secure storage; confidential-client connectors (GitHub, Vercel, Notion, Slack, Linear) are broker-gated and fail closed with `configuration-required` until the auth broker and provider configuration exist.
- Google connectors: Drive, Gmail, and Calendar expose authenticated reads and approval-gated writes, incremental scopes, refresh-token preservation, explicit active-account selection, bounded responses, cancellation, and normalized provider errors. External use still requires Google Cloud configuration and applicable verification.
- Schedules page: users can create, pause/resume, and delete local schedule records. Records persist through the runtime snapshot; no background scheduler executes them yet.
- CI file: `.github/workflows/ci.yml` exists and uses pnpm for typecheck, tests, build, Tauri check, Rust tests, clippy, and fmt on Windows.
- Tests exist across desktop, connectors, native API, local files, knowledge search, backend registry, and Rust runtime modules.

## Runtime Availability Matrix

| Area | Current state |
| --- | --- |
| Local files, approvals, memory controls, knowledge search, runtime snapshots | Live local runtime paths. |
| Native API-key backends | Live when the user supplies a provider API key; keys stay in the local credential boundary. |
| Google Drive, Gmail, Google Calendar | Live provider egress exists, but only after Google desktop OAuth configuration and a connected test account. |
| GitHub, Vercel, Notion, Slack, Linear | Provider egress code exists behind the credential boundary, but auth is broker-gated and fails closed until the deferred auth broker and provider-console callbacks exist. |
| Browser preview connectors | Explicit synthetic fixture behavior only; never proof of a live provider connection. |
| Schedules, voice, Convex collaboration, encrypted SQLite | Incomplete or non-executing as described below. |

## Partially Implemented Or Preview-Only

- Onboarding collects an optional local display profile only. It does not create or require a hosted Fable account.
- The API-key path can hand native backend secrets to the Rust credential boundary, but subscription provider paths are represented as backend catalog states and install/setup flows, not proven live provider integrations.
- Browser preview can mark API-key backends as locally connected for testability. Connector reads remain explicitly fixture-backed and do not become live connections.
- Connector search/import in browser preview uses explicitly labeled synthetic fixture behavior.
- Knowledge imported through local files can feed composer directives and search, but the standalone Knowledge page currently renders an empty state.
- Schedules persist through the runtime snapshot, but no background scheduler or recurring execution engine was found.
- Voice is a toggle and status affordance; no dictation, audio capture, realtime voice provider, or transcript pipeline was found.
- Convex is optional via `VITE_CONVEX_URL`, but no Convex schema or collaboration implementation was found in this repo.

## Not Implemented Yet

- No deployed production auth broker or externally validated confidential OAuth session.
- No provider-console apps, deployed callback URLs, OAuth consent verification, or non-production live OAuth validation evidence in the repo.
- No externally validated live connector sessions in this checkout. Google public-client connectors still require provider configuration and test accounts; confidential-client connectors still require the deferred auth broker.
- No encrypted SQLite store is wired yet. Current local runtime state is app-data JSON plus browser localStorage fallback; backend secrets are separately handled by the OS keyring boundary.
- No local model runtime path. The onboarding UI labels local models as planned and disabled.
- No signed release, updater channel, macOS packaging, or Linux packaging. Release docs identify the Windows preview build path and unsigned distribution gaps.
- No product website, legal pages, downloads page, or public release pipeline in the audited files.

## Highest-Risk Gaps

- External connectors look close in the UI but are not live. The repo correctly fails closed, but product messaging must keep this distinction clear.
- Local state is not encrypted yet, despite architecture docs naming encrypted SQLite as the target.
- Schedules can be created and persisted, but they do not execute automatically.

## Evidence Checked

- `README.md`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/product/thesis.md`
- `docs/product/roadmap.md`
- `docs/product/architecture.md`
- `docs/product/connectors.md`
- `docs/product/release.md`
- `docs/security/threat-model.md`
- `apps/desktop/package.json`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src/hooks/useShellRuntime.ts`
- `apps/desktop/src/hooks/useNativeAgent.ts`
- `apps/desktop/src/components/Composer.tsx`
- `apps/desktop/src/components/pages/OnboardingPage.tsx`
- `apps/desktop/src/components/pages/ProfilePage.tsx`
- `apps/desktop/src/components/pages/SettingsPage.tsx`
- `apps/desktop/src/components/pages/KnowledgePage.tsx`
- `apps/desktop/src/components/pages/SchedulesPage.tsx`
- `apps/desktop/src/data/workspace.ts`
- `apps/desktop/src/lib/persistence.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/models.rs`
- `apps/desktop/src-tauri/src/paths.rs`
- `apps/desktop/src-tauri/src/snapshot.rs`
- `apps/desktop/src-tauri/src/memory.rs`
- `apps/desktop/src-tauri/src/connectors.rs`
- `apps/desktop/src-tauri/src/connector_auth.rs`
- `apps/desktop/src-tauri/src/connector_api.rs`
- `apps/desktop/src-tauri/src/collaboration_connectors.rs`
- `apps/desktop/src-tauri/src/google.rs`
- `apps/desktop/src-tauri/src/oauth_loopback.rs`
- `apps/desktop/src-tauri/src/backends.rs`
- `apps/desktop/src-tauri/src/native_api.rs`
- `apps/desktop/src-tauri/src/tools.rs`
- `packages/protocol/src/index.ts`
- `packages/connectors/src/index.ts`
- `packages/connectors/src/local-files.ts`
- `packages/connectors/src/knowledge-search.ts`
- `packages/connectors/src/providers/registry.ts`
- `packages/connectors/src/backends/registry.ts`
- `packages/connectors/src/native-api/agent-loop.ts`
- `packages/connectors/src/native-api/tools.ts`
- `packages/connectors/src/native-api/tool-executor.ts`
- `docs/connectors/auth-broker.md`
