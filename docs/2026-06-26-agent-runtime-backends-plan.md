# Implementation Plan — Agent-Runtime AI Backends

Spec: `docs/2026-06-26-agent-runtime-backends-design.md`. Phases run in dependency
order; each phase ends with `pnpm --filter` typecheck for the touched package so
errors surface early. Final gate runs the full check suite + cargo gates.

## Phase 1 — Protocol types (`packages/protocol`)
- Add to `src/index.ts`: `BackendType`, `BackendAuthState`, `BackendCapability`,
  `BackendModel`, `BackendProvider`, `BackendCredentialRequest`,
  `BackendConsequentialEvent`, and `BackendEventAudit`.
- Extend `ConnectorManifest` with optional `backend?: BackendProvider`.
- Extend `RuntimeSnapshot` with `connectedBackendIds: string[]` (ids only — no secrets).
- `pnpm --filter @fable/protocol build`.

## Phase 2 — Connectors backends (logic/data split, `packages/connectors/src/backends/`)
- `types.ts` — internal adapter types (re-exports protocol where possible).
- `capabilities.ts` — `resolveCapabilities(backendType, authState)` pure resolver + fail-closed semantics.
- `codex.ts` — Codex app-server provider descriptor + capability resolution (subscription + BYOK).
- `acp.ts` — generic ACP provider descriptors for `cursor` + `grok`; install-required fail-closed; Grok entitlements empty pre-login.
- `copilot.ts` — Copilot SDK provider descriptor (subscriber/OAuth/automation/BYOK).
- `fixtures.ts` — preview catalogs (models, install hints) for each provider; **no tier/entitlement promises, no Claude/Gemini**.
- `registry.ts` — `listBackendProviders(): BackendProvider[]` merging logic + fixtures.
- `registry.test.ts` — fail-closed, install prompt, Grok entitlement invariant, no Claude/Gemini.
- Re-export from `packages/connectors/src/index.ts`.
- `pnpm --filter @fable/connectors build && pnpm --filter @fable/connectors test`.

## Phase 3 — Rust backend module (`apps/desktop/src-tauri/src/`)
- `models.rs`: `BackendProvider` (serde), `BackendCredentialRequest`, `BackendEventAudit`,
  `BACKEND_TYPES`/`BACKEND_AUTH_STATES`/`BACKEND_CAPABILITIES` vocabularies, caps.
- `paths.rs`: `backend_credentials_path()` + `connected_backends_path()` helpers.
- `backends.rs`: process-scoped credential store (`Mutex<HashMap<ProviderId, SecretString>>`),
  `BACKENDS_PRE_RELEASE` flag, `list_backends`, `store_backend_credential`,
  `clear_backend_credential`, `record_backend_event` (→ existing audit path).
  Secrets never cross to JS; `list_backends` returns auth-state + caps only.
- `snapshot.rs`: `RuntimeSnapshot` gets `connected_backend_ids`; normalize/validate (ids only).
- Register commands in `lib.rs`.
- `tests.rs`: store round-trip, `list_backends` leaks no secret, snapshot has no token field, event→audit.
- `cargo fmt`, `cargo clippy --all-targets`, `cargo test`.

## Phase 4 — Frontend bridge + onboarding (`apps/desktop/src/`)
- `runtime.ts`: `listRuntimeBackends`, `connectRuntimeBackend`, `clearRuntimeBackend`,
  `recordRuntimeBackendEvent` (Tauri invoke w/ `hasTauriRuntime()` guard → null fallback).
- `lib/backend-capabilities.ts`: `hasCapability(provider, cap)`, capability → UI control map.
- `hooks/useShellRuntime.ts`: load backends on mount; track `connectedBackendIds`;
  `connectBackend(providerId)` / `disconnectBackend`; route backend events into the
  existing approval queue; expose `backendProviders`, `onboardingRequired`.
- `components/pages/OnboardingPage.tsx`: three paths (subscription functional /
  api-key pending / local disabled); gate copy; "Skip (preview)" link.
- `App.tsx`: render `OnboardingPage` before workspace when `onboardingRequired`.
- Update `App.test.tsx` runtime mocks + add onboarding gate tests.
- Wire backend facet into `PluginsPage` so connectors surface backend status.

## Phase 5 — Approval routing verification
- Confirm backend consequential events flow through `record_backend_event` →
  `ApprovalAuditEntry` and that UI approval resolution still goes through
  `resolve_approval_request`. No new bypass paths.

## Phase 6 — Green gates + report
- `npm run check` (typecheck + test + build + tauri:check).
- `cargo fmt --check`, `cargo check`, `cargo clippy --all-targets`, `cargo test`.
- Write `docs/2026-06-26-agent-runtime-backends-report.md`.
