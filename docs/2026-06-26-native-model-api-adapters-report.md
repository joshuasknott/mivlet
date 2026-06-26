# Goal Report — Native Model API Adapters (OpenAI, Anthropic, Gemini, xAI, OpenRouter)

Completed: 2026-06-26. Builds the native model API adapter family where **Arden
owns the entire agent loop** — tool dispatch, streaming, approval routing, memory
integration, usage/cost, and cancellation. Extends — does not rebuild — the prior
goal's `BackendProvider`/capability surface, credential boundary, approval routing,
and onboarding shell.

Spec: `docs/2026-06-26-native-model-api-adapters-design.md`.
Plan: `docs/2026-06-26-native-model-api-adapters-plan.md` + `docs/superpowers/plans/2026-06-26-native-model-api-adapters.md`.

---

## 1. Definition of Done — prompt-to-artifact checklist

| # | Requirement (from the objective) | Evidence | Status |
|---|---|---|---|
| 1 | Extend (not rebuild) `SUPPORTED_BACKEND_PROVIDER_IDS` + catalog + `BackendType` with the native providers and a native-API type | `models.rs`: `SUPPORTED_BACKEND_PROVIDER_IDS` = 9 ids, `BACKEND_TYPES` includes `"native-api"`. `protocol/index.ts`: `BackendType` includes `"native-api"`. `backends.rs` `CATALOG` serves the 5 native entries. | ✅ |
| 2 | One shared OpenAI-compatible client with per-provider shaping, behind an injectable HTTP-transport seam; OpenAI/OpenRouter/xAI share the path; Anthropic + Gemini provider-specific | `packages/connectors/src/native-api/`: `openai-compat.ts` (shared), `anthropic.ts`, `gemini.ts` (provider-specific), `transport.ts` (`HttpTransport` seam + `FixtureTransport`/`SequencedFixtureTransport`) | ✅ |
| 3 | Network egress + key handling owned by Rust; TS never sees the key, never opens a socket | `native_api.rs::stream_backend_completion`: looks up the key from the store, adds the provider header, issues the streaming `reqwest` call, emits SSE lines on `arden://backend/<id>`. Key never in any TS type/request/event | ✅ |
| 4 | Real cancellation of in-flight requests, not UI dismissal | `native_api.rs::cancel_backend_completion` + cancel map drops the in-flight future via a pinned oneshot receiver in `tokio::select!` | ✅ |
| 5 | Tool dispatch — model tool calls don't auto-execute; each routes through the ApprovalRequest system before execution; unregistered tools fail closed | `tools.ts` registry; `approvals.ts::buildToolApproval` shapes every tool call into an ApprovalRequest (unregistered → critical, refusal consequence); `agent-loop.ts` only executes via the injected executor after the shell approves | ✅ |
| 6 | Streaming normalized to the same event stream the runtimes emit; typed `BackendAgentEvent` in protocol | `protocol/index.ts`: `BackendAgentEvent` union (text-delta/tool-call/tool-result/usage/done/error/cancelled) emitted over the Tauri event channel | ✅ |
| 7 | Memory — pinned knowledge/memory enters context by trust level; approved inferences write back with provenance, freshness, kind | `memory-context.ts::buildContextPrefix` (trusted vs untrusted); write-back rides the existing `promote_knowledge_source_to_memory` path | ✅ |
| 8 | Per-request usage/cost accounting | `pricing.ts::priceFor` per provider; `usage` event emitted by each shaper; rendered in the agent panel | ✅ |
| 9 | Compliance hard: Claude API key/Bedrock/Vertex only; Gemini API key/Vertex only; no Grok entitlement assertion; no Claude.ai / Google AI Pro/Ultra subscription reuse | Fixture + catalog copy names only allowed paths; connectors test + Rust test + App test assert no forbidden phrases; onboarding copy reflects it | ✅ |
| 10 | Onboarding: API-key path functional; local-model still disabled; gate unchanged | `OnboardingPage.tsx`: API-key path interactive with 5 providers + secret input; local-model `aria-disabled`; gate copy unchanged | ✅ |
| 11 | Model tool output is untrusted→trusted; approval gates before any tool runs; keys are protected assets (pre-release local store, never logged/snapshotted/committed) | Fail-closed executor; `BACKENDS_PRE_RELEASE`; secrets-never-leak Rust tests cover the native providers | ✅ |
| 12 | Deferred: local models, enterprise beyond Vertex-under-Gemini, OpenCode, runtime backends (shipped), voice/realtime, marketing/CI/signing | Local-model card disabled; no enterprise/OAuth/transport-spawn for these; explicitly out of scope | ✅ |
| 13 | `npm run check`, `cargo fmt --check`, `cargo check`, `cargo clippy`, `cargo test` green; no real network in tests | §2 below — all gates green; all network behind `HttpTransport`, tests use fixtures | ✅ |
| 14 | Goal report added to `docs/` | This file | ✅ |

---

## 2. Check commands & results (canonical)

**TypeScript (run from repo root via `pnpm -w run check`):**
- `pnpm typecheck` → ✅ clean (protocol build + connectors + desktop)
- `pnpm test` → ✅ **68 connectors** + **28 desktop** tests
- `pnpm build` → ✅ vite build OK (CSS ~53 kB, JS ~400 kB)
- `pnpm tauri:check` → ✅ `cargo check` no errors/warnings

**Rust (run from `apps/desktop/src-tauri`):**
- `cargo fmt --check` → ✅ clean
- `cargo clippy --all-targets` → ✅ no warnings
- `cargo test` → ✅ **43 tests** pass (38 prior + 5 new native transport/catalog tests)

**No real network in tests:** every network path is behind the `HttpTransport`
seam; `FixtureTransport`/`SequencedFixtureTransport` replay recorded SSE fixtures
(openai.txt / anthropic.txt / gemini.txt). The Rust streaming command is exercised
through its pure-helper decomposition (header/endpoint/SSE normalization); no
socket is opened by any test.

---

## 3. Architecture (what was added)

### Protocol (`packages/protocol`)
- `BackendType` gains `"native-api"`.
- New types: `BackendAgentEvent` (the shared normalized event stream),
  `NativeCompletionRequest`, `NativeMessage`, `NativeToolCall`, `NativeToolSpec`,
  `BackendTool`. The API key never appears in any of these.

### Connectors (`packages/connectors/src/native-api/`)
Pure, fixture-tested logic (no network, no key):
- `transport.ts` — `HttpTransport` seam + `FixtureTransport`/`SequencedFixtureTransport`.
- `openai-compat.ts` — shared OpenAI Chat Completions shaper+parser (OpenAI/xAI/OpenRouter).
- `anthropic.ts` — Anthropic Messages shaper+parser (stateful `input_json_delta` buffering).
- `gemini.ts` — Gemini generateContent shaper+parser.
- `agent-loop.ts` — `runAgentLoop`: turns over the seam; tool-calls → ApprovalRequest;
  cooperative cancel; maxTurns safety.
- `tools.ts` + `approvals.ts` — Arden-owned tool registry + tool-call→approval shaping
  (unregistered tools fail closed).
- `pricing.ts` — per-provider usage/cost (fail-safe to 0).
- `memory-context.ts` — pinned memory/knowledge into context by trust level.
- `fixtures/` + `fixtures-loader.ts` — recorded SSE responses (test-only disk loader).

### Rust runtime (`apps/desktop/src-tauri/src/`)
- `native_api.rs` — key+egress+cancellation boundary: `auth_header_for` (Bearer /
  x-api-key / x-goog-api-key), `endpoint_for`, `normalize_sse_line`,
  `stream_backend_completion` (streaming reqwest → Tauri event channel),
  `cancel_backend_completion` (cancel map drops the in-flight future).
- `backends.rs` — catalog extended with the 5 native providers; `credential_store`
  exposed `pub(crate)` so the transport can read the key.
- `models.rs` — vocabularies extended (9 provider ids, `native-api` type).
- `lib.rs` — registers the two new commands.

### Desktop shell (`apps/desktop/src/`)
- `runtime.ts` — `streamRuntimeCompletion` / `cancelRuntimeCompletion` /
  `listenRuntimeBackendEvents` (Tauri invoke + `hasTauriRuntime()` guard + null fallback).
- `hooks/useNativeAgent.ts` — runs the loop, builds the `TauriTransport`, routes
  tool-calls into the shell's approval audit, renders transcript/usage.
- `hooks/useShellRuntime.ts` — `recordBackendToolCall` records model tool calls
  as backend consequential events (never auto-executes).
- `components/pages/OnboardingPage.tsx` — functional API-key path (5 providers +
  secret input); compliant copy.
- `App.tsx` — composer drives the agent loop when a native provider is connected;
  agent activity panel.
- `App.test.tsx` — functional API-key path, compliance copy, native connect,
  agent panel, runtime bridge tests.

---

## 4. Compliance invariants (enforced by tests)

- **Anthropic** — API key / Vertex / Bedrock only. No `claude.ai` in any served
  copy (connectors test + Rust test + App test).
- **Gemini** — API key / Vertex only. No `google ai pro` / `google ai ultra`
  (connectors test + Rust test + App test).
- **Grok** — no entitlement asserted for any tier (carried over from goal 1).
- **No credential leakage** — `list_backends` and the connected-backends manifest
  contain no secret strings for any provider, including the 5 native (Rust tests).
- **Fail-closed** — every non-connected native provider declares zero capabilities;
  unregistered tools fail closed; the executor refuses until the shell approves.

---

## 5. The key invariant (restated)

The API key is added as an `Authorization` / `x-api-key` / `x-goog-api-key` header
**only** inside `native_api.rs::auth_header_for`. It never appears in any
TypeScript type, request body, event, log, or `RuntimeSnapshot` (which is
unchanged by this goal). The TypeScript layer shapes requests/responses and owns
the loop as pure, fixture-tested logic; Rust owns the key + HTTP/SSE egress +
real cancellation.

---

## 6. Deferred (explicitly out of scope)

Local models, enterprise backends beyond Vertex-under-Gemini, OpenCode, the four
runtime backends (already shipped), voice/realtime, marketing/CI/release-signing.
Live transport for the *runtime* backends (spawning CLIs/app-server sockets)
remains deferred; this goal adds live transport only for the native API adapters.
