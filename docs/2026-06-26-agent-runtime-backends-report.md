# Goal Report — Agent-Runtime AI Backends (Codex, Cursor, Copilot, Grok)

Completed: 2026-06-26. Adds four agent-runtime AI backends that reach users'
existing subscriptions through each vendor's official transport, normalized into
Arden's protocol with every consequential action routed through the existing
Rust approval system. This also lays the shared foundation (BackendProvider /
capability surface, credential boundary, approval routing, three-path
onboarding) that the next API-key goal builds on.

Spec: `docs/2026-06-26-agent-runtime-backends-design.md`.
Plan: `docs/2026-06-26-agent-runtime-backends-plan.md`.

---

## 1. Definition of Done — prompt-to-artifact checklist

| # | Requirement (from the objective) | Evidence | Status |
|---|---|---|---|
| 1 | `BackendProvider` / capability types in `packages/protocol`; `ConnectorManifest` gains a backend facet | `packages/protocol/src/index.ts` — `BackendType`, `BackendAuthState`, `BackendCapability`, `BackendModel`, `BackendProvider`, `BackendCredentialRequest`, `BackendConsequentialEvent`, `BackendEventAudit`; `ConnectorManifest.backend?: BackendProvider` | ✅ |
| 2 | Rust owns credential access, session lifecycle, approval routing; React sees only auth state + capabilities, never raw tokens | `apps/desktop/src-tauri/src/backends.rs` — process-scoped credential store; `list_backends` returns auth state + caps only; secrets never cross the Tauri boundary. `runtime.ts` wrappers return auth state only | ✅ |
| 3 | Follow the connectors logic/data split: real adapter logic separate from fixture/preview catalogs | `packages/connectors/src/backends/` — `capabilities.ts`/`codex.ts`/`acp.ts`/`copilot.ts`/`registry.ts` (logic) vs `fixtures.ts` (data) | ✅ |
| 4 | Codex app-server adapter (subscription + OpenAI API-key auth) | `backends/codex.ts` — `resolveCodexProvider(authState, { usingApiKey })`; subscription caps exclude `usage-cost`, API-key path includes it | ✅ |
| 5 | Generic ACP adapter (stdio/JSON-RPC) shared by Cursor + Grok; fail closed with install prompt if CLI absent | `backends/acp.ts` — `resolveAcpProvider("cursor"\|"grok")`; `install-required` state yields empty caps + `installHint` | ✅ |
| 6 | Copilot SDK adapter (subscriber / OAuth app / automation token / BYOK) | `backends/copilot.ts` — `resolveCopilotProvider`; `COPILOT_AUTH_MODES = ["subscriber","oauth-app","automation-token","byok"]` | ✅ |
| 7 | Adapters declare capabilities dynamically; never fake a capability they lack — fail closed instead | `backends/capabilities.ts` — `resolveCapabilities` returns `[]` for every non-connected state; only `connected`/`entitlement-pending` yield caps | ✅ |
| 8 | Every consequential action routes through `ApprovalRequest`/grants/rules/audit + fail-closed high-risk; backend-originated approvals recorded as audit, not bypass | `backends.rs::normalize_backend_event` → `ApprovalAuditEntry` (`once` for preapproved, `deny` otherwise); flows into existing `record_approval_decision`/audit path; no bypass | ✅ |
| 9 | Credentials in OS secure storage; until wired, local-store boundary flagged pre-release; never log/snapshot/persist tokens into `RuntimeSnapshot` | `BACKENDS_PRE_RELEASE = true` + one-time `eprintln` warning; `RuntimeSnapshot` carries only `connected_backend_ids` (ids, not secrets); Rust test asserts snapshot file has no "secret"/"token" | ✅ |
| 10 | Compliance: never promise any X/Premium tier includes Grok Build; no CLI redistribution; don't surface Claude/Gemini | Grok `entitlements` always empty pre-login; connectors test asserts no `premium/plus/included in` text + no `grok build`; no CLI vendored; only codex/cursor/copilot/grok surfaced | ✅ |
| 11 | Onboarding: subscription functional (all four), API-key path shown pending, local-model path disabled-but-present; gate on "Connect one AI backend to continue" | `OnboardingPage.tsx` — three paths; gate copy exact; "Skip for now (preview)" link; `onboardingRequired` gate in `App.tsx` | ✅ |
| 12 | Deferred: native API keys + Arden-owned agent loop (next goal), local models, enterprise, OpenCode, real OAuth for fixtures, voice/realtime, marketing/CI/signing, live transport | API-key path rendered pending (not wired); local-model card disabled; no OAuth/transport spawned; deferred explicitly in spec §6 | ✅ |
| 13 | `npm run check`, `cargo fmt --check`, `cargo check`, `cargo clippy`, `cargo test` green; no real credentials; fixture/preview fallbacks keep UI testable outside Tauri | §2 below — all gates green; `hasTauriRuntime()` guards + null fallbacks; no real secrets | ✅ |
| 14 | Goal report added to `docs/` | This file | ✅ |

---

## 2. Check commands & results (canonical)

**TypeScript (run from repo root):**
- `npm run check` → ✅ = typecheck + test + build + `tauri:check`, all green
  - `npm run typecheck` → ✅ clean (protocol build + connectors + desktop)
  - `npm run test` → ✅ **27 connectors** + **24 desktop** tests
  - `npm run build` → ✅ vite build OK (CSS 51.22 kB, JS 396.84 kB)
  - `npm run tauri:check` → ✅ `cargo check` no errors/warnings

**Rust (run from `apps/desktop/src-tauri`):**
- `cargo fmt --check` → ✅ clean
- `cargo clippy --all-targets` → ✅ no warnings
- `cargo test` → ✅ **34 tests** pass (24 prior + 10 new backend boundary tests)

---

## 3. Architecture (what was added)

### Protocol (`packages/protocol`)
New types: `BackendType`, `BackendAuthState`, `BackendCapability`,
`BackendModel`, `BackendProvider`, `BackendCredentialRequest`,
`BackendConsequentialEvent`, `BackendEventAudit`. `ConnectorManifest.backend?`
attaches a backend facet. `RuntimeSnapshot.connectedBackendIds` records *which*
backends are connected (ids only — secrets never persist).

### Connectors (`packages/connectors/src/backends/`)
Logic/data split mirroring the existing connector pattern:
- `capabilities.ts` — dynamic, fail-closed capability resolution
- `codex.ts` / `acp.ts` / `copilot.ts` — adapter logic (transport described, not spawned)
- `fixtures.ts` — preview catalogs (models, install hints; no tier/entitlement promises, no Claude/Gemini)
- `registry.ts` — `listBackendProviders()` single source for the shell
- `registry.test.ts` — 17 tests guarding fail-closed, install gating, Grok entitlement compliance

### Rust runtime (`apps/desktop/src-tauri/src/`)
- `backends.rs` — credential boundary: process-scoped store (`BACKENDS_PRE_RELEASE`),
  `list_backends` / `store_backend_credential` / `clear_backend_credential` /
  `record_backend_event`. Secrets never cross to JS; catalog served server-side.
  Logic functions are pure over an explicit store so tests pass fresh stores.
- `models.rs` — `BackendProvider`/`BackendCredentialRequest`/`BackendConsequentialEvent`
  serde shapes + `BACKEND_TYPES`/`BACKEND_AUTH_STATES`/`BACKEND_CAPABILITIES` vocabularies.
- `paths.rs` — `connected_backends_path()`.
- `snapshot.rs` — normalizes `connected_backend_ids`.
- `lib.rs` — registers the four new commands.
- `tests.rs` — 10 new tests: store round-trip, secret never leaks through list
  or snapshot, ACP install-required, Grok entitlements empty, event→audit no-bypass,
  unsupported/empty-secret rejection.

### Desktop shell (`apps/desktop/src/`)
- `runtime.ts` — `listRuntimeBackends` / `connectRuntimeBackend` /
  `clearRuntimeBackend` / `recordRuntimeBackendEvent` (Tauri invoke + `hasTauriRuntime()`
  guard + null fallback for outside-Tauri testing).
- `lib/backend-capabilities.ts` — capability → UI affordance helpers.
- `hooks/useShellRuntime.ts` — backend state + loading effect + connect/disconnect +
  `onboardingRequired` gate; backend facet on connectors.
- `components/pages/OnboardingPage.tsx` — three-path shell.
- `App.tsx` — renders onboarding before the workspace when gated.
- `components/pages/PluginsPage.tsx` — surfaces connected AI backends.
- `App.test.tsx` — 7 new onboarding tests (gate, four providers, install hint,
  connect clears gate, api-key/local disabled, no Grok-Build tier promise, skip).

---

## 4. Compliance invariants (enforced by tests, not just documented)

- **Grok entitlements** — empty in every fixture and every Rust-served provider
  state; the serialized catalog contains no `premium`/`plus`/`included in` text.
- **Fail-closed** — every non-connected auth state declares zero capabilities.
- **ACP install gating** — Cursor/Grok are `install-required` with an install hint
  until a credential is present; no CLI is ever vendored.
- **No Claude/Gemini** — only codex/cursor/copilot/grok appear in the registry.
- **No credential leakage** — `list_backends` and the snapshot file are asserted
  to contain no secret/token strings.

---

## 5. Deferred (explicitly out of scope this goal)

Native API keys + Arden-owned agent loop (next goal), local models, enterprise
backends, OpenCode, real OAuth for existing fixture connectors, voice/realtime,
marketing/CI/release-signing, and **live transport** (spawning CLIs / opening
app-server sockets). Adapters describe their transport and resolve capabilities
but do not spawn — keeping all checks green and matching the "foundation"
framing; the agent-loop goal activates the transports.
