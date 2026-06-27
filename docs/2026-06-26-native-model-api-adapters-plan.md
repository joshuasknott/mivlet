# Native Model API Adapters — Implementation Plan (summary)

> Full TDD task breakdown lives in `docs/superpowers/plans/2026-06-26-native-model-api-adapters.md`.
> Design of record: `docs/2026-06-26-native-model-api-adapters-design.md`.

## Goal

Build the native model API adapter family (OpenAI, Anthropic, Gemini API+Vertex,
xAI, OpenRouter) where **Fable owns the entire agent loop**, extending — not
rebuilding — the prior goal's `BackendProvider`/capability surface, credential
boundary, approval routing, and onboarding shell.

## Architecture (one paragraph)

TypeScript (`@fable/connectors/native-api/`) owns **shaping + the loop** as pure,
fixture-testable logic behind an injectable `HttpTransport` seam. Rust owns
**key lookup + HTTP/SSE egress + real cancellation** via a new
`stream_backend_completion` / `cancel_backend_completion` command pair that emits
normalized `BackendAgentEvent`s over a Tauri event channel. The key is added as
an `Authorization`/`x-api-key`/`x-goog-api-key` header inside Rust; TS never sees
it. One shared OpenAI-compatible client covers OpenAI/OpenRouter/xAI; Anthropic
Messages and Gemini get provider-specific shaping behind the shared interface.
Tool calls route through the existing `ApprovalRequest` system before Fable
executes them; unregistered tools fail closed.

## Tech

- `@fable/protocol` — extend `BackendType`, `BackendAuthState`, vocab; add
  `BackendAgentEvent`, `NativeCompletionRequest` request/event types.
- `@fable/connectors` — `native-api/` modules: `openai-compat.ts`,
  `anthropic.ts`, `gemini.ts`, `registry.ts`, `agent-loop.ts`, `transport.ts`,
  `tools.ts`, `pricing.ts`, recorded fixtures. Pure, vitest-only.
- Rust (`src-tauri/src/`) — `native_api.rs` (key+egress+cancel), extend
  `models.rs` vocab + `backends.rs` catalog, register commands in `lib.rs`.
  Add `reqwest` with `features=["json","rustls-no-provider","stream"]`
  (verified to resolve **offline** against the existing `Cargo.lock`).
- Desktop — `runtime.ts` (run/cancel wrappers + event listen),
  `OnboardingPage.tsx` (API-key path → functional), `useShellRuntime.ts`
  (wire loop events → approvals/memory/usage), render deltas.

## Sequencing (7 stages, each ships green)

1. **Protocol + vocab extension** — extend unions/vocabularies; add
   `BackendAgentEvent` + normalized request types. (typecheck green; existing
   tests still pass.)
2. **Connectors: native-api shapers + registry + fixtures** — pure shape/parse
   per provider + the `FixtureTransport`; vitest, no network. Vocabulary +
   compliance tests.
3. **Connectors: agent loop + tools + pricing** — `runAgentLoop` over the seam;
   tool-call→ApprovalRequest; unregistered-tool fail-closed; usage accounting;
   cancellation. Fixture-driven.
4. **Rust: vocab + catalog + credential store extension** — extend
   `SUPPORTED_BACKEND_PROVIDER_IDS`, `BACKEND_TYPES`, `CATALOG`; the five native
   entries served fail-closed; secrets-never-leak extended. `cargo test` green.
5. **Rust: live transport + cancellation** — `native_api.rs`: key header per
   provider, `reqwest` streaming, SSE→event emission, cancel map. Pure-helper
   unit tests; no socket in tests.
6. **Desktop: runtime bridge + onboarding API-key path** —
   `streamRuntimeCompletion`/`cancelRuntimeCompletion` + event listen; API-key
   path functional with compliant copy; local-model still disabled. App tests.
7. **Wire the loop into the shell + report** — composer→run, render deltas,
   route tool-calls into approvals, memory write-back, usage render; final
   `npm run check` + `cargo fmt --check`/`clippy`/`test`; goal report in `docs/`.

## Gates to keep green at every stage

`npm run check` (typecheck + test + build + tauri:check) and, from
`apps/desktop/src-tauri`: `cargo fmt --check`, `cargo check`, `cargo clippy
--all-targets`, `cargo test`. **No real network in any test.**
