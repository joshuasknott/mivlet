# Design — Agent-Runtime AI Backends (Codex, Cursor, Copilot, Grok)

Status: **Proposed** — pending user approval before implementation.
Date: 2026-06-26
Owner: Arden desktop

## 1. Objective (restated as deliverables)

Add four agent-runtime AI backends to Arden — **Codex, Cursor, GitHub Copilot, Grok** —
that reach users' *existing* subscriptions through each vendor's official
transport (Codex app-server, ACP over stdio/JSON-RPC, Copilot SDK). Each backend
owns its own sessions, streaming, approvals, and file-change events. Arden
**normalizes** them into its protocol and **routes every consequential action
through the existing Rust approval system**.

This goal also lays shared foundation the later API-key goal builds on:
`BackendProvider` / capability surface, credential boundary, approval routing,
and the three-path onboarding shell.

### Success criteria (the checklist the verifier will check)

1. `packages/protocol` gains `BackendProvider`, capability, auth-state, and
   model-list types; `ConnectorManifest` gains a `backend` facet.
2. Rust owns credential access + backend auth state + approval routing; React
   sees only auth state + capabilities, never raw tokens.
3. Adapters follow the connectors logic/data split: real adapter logic is a
   separate module from fixture/preview catalogs.
4. Codex app-server adapter (subscription + OpenAI API-key auth).
5. Generic ACP adapter (stdio/JSON-RPC) shared by Cursor and Grok; depends on
   installed CLI; **fails closed with an install prompt** if absent.
6. Copilot SDK adapter (subscriber / OAuth app / automation token / BYOK).
7. Adapters declare capabilities **dynamically**; never fake a capability they
   lack — fail closed instead.
8. Every tool call / file write / consequential action from any backend routes
   through Arden's `ApprovalRequest` system, grants, rules, audit, and
   fail-closed high-risk confirmation. Backend-originated approvals are recorded
   as audit entries, never used to bypass Arden's layer.
9. Credentials in OS secure storage; until wired, the local-store boundary is
   flagged pre-release. **Never log, snapshot, or persist tokens into
   `RuntimeSnapshot`.**
10. Compliance: never promise any X/Premium tier includes Grok Build (entitlement
    detected post-login only); no CLI redistribution until licensing reviewed;
    do **not** surface Claude/Gemini subscription options this goal.
11. Onboarding: subscription path functional (Codex/Cursor/Copilot/Grok),
    API-key path shown pending, local-model path disabled-but-present. Gate on
    "Connect one AI backend to continue."
12. Deferred (out of scope): native API keys + Arden-owned agent loop (next
    goal), local models, enterprise backends, OpenCode, real OAuth for existing
    fixture connectors, voice/realtime, marketing/CI/release-signing.
13. Green: `npm run check`, `cargo fmt --check`, `cargo check`, `cargo clippy`,
    `cargo test`. No real credentials. Fixture/preview fallbacks keep the UI
    testable outside Tauri.
14. Goal report added to `docs/`.

## 2. Architecture decisions

### 2.1 Where each concern lives (mirrors current split)

| Concern | Package | New modules | Pattern source |
|---|---|---|---|
| Capability/provider/auth types | `@arden/protocol` | (extend `index.ts`) | type-only, like `ConnectorManifest` |
| Fixture/preview backend catalogs | `@arden/connectors` | `backends/fixtures.ts` | mirrors `fixtures.ts` |
| Backend adapter logic (normalize + capability declaration + transport description) | `@arden/connectors` | `backends/codex.ts`, `backends/acp.ts`, `backends/copilot.ts`, `backends/registry.ts` | mirrors `local-files.ts`/`knowledge-search.ts` (pure logic, no network I/O at this stage) |
| Credential boundary + auth-state storage | Rust runtime | `backends.rs` (models + commands) + `paths.rs` entry | mirrors `approvals.rs` + `paths.rs` |
| Frontend runtime bridge (Tauri invoke w/ fallback) | `apps/desktop/src` | extend `runtime.ts`; new `lib/backend-capabilities.ts` | mirrors existing `runtime.ts` guards |
| Onboarding shell UI | `apps/desktop/src/components` | `pages/OnboardingPage.tsx` (+ route) | mirrors `pages/PluginsPage.tsx` |
| Approval routing of backend actions | existing approval path | adapters emit `ApprovalRequest`s into the existing flow | no new approval code path |

### 2.2 Capability model (dynamic, fail-closed)

Capabilities are a closed set declared *per provider instance* at runtime, not a
static provider flag. An adapter returns the exact set it can honor for the
current auth/entitlement state. The UI may only render controls for capabilities
the adapter actually declared.

```ts
export type BackendCapability =
  | "authentication"      // can reach a logged-in account
  | "threads"             // session/thread lifecycle
  | "streaming"           // token streaming
  | "tool-requests"       // requests tool execution from Arden
  | "approvals"           // surfaces its own approval events
  | "file-changes"        // emits file change events
  | "usage-cost"          // reports usage/cost
  | "model-availability"  // exposes a selectable model list
  | "cancellation";       // supports canceling an in-flight run
```

`BackendProvider` describes a *backend type's* shape; a `BackendInstance`
describes a *connected* one with resolved capabilities + auth state:

```ts
export type BackendType = "codex-app-server" | "acp" | "copilot-sdk";
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "install-required"   // CLI/SDK missing — fail closed
  | "entitlement-pending" // logged in but entitlement unknown (e.g. Grok Build)
  | "unavailable";

export interface BackendModel { id: string; label: string; available: boolean; }

export interface BackendProvider {
  id: string;            // "codex" | "cursor" | "copilot" | "grok"
  backendType: BackendType;
  label: string;
  description: string;
  authState: BackendAuthState;
  capabilities: BackendCapability[];   // resolved, dynamic
  models: BackendModel[];
  installHint?: string;  // shown when authState === "install-required"
  entitlements?: string[]; // detected post-login only (e.g. "grok-build")
}
```

`ConnectorManifest.backend?: BackendProvider` attaches a backend facet to a
connector entry so the existing connectors view can render backend status.

### 2.3 Credential boundary (Rust owns secrets)

- New `backends.rs` defines `BackendCredentialEnvelope` carrying **only** an
  `authState` + `providerId` + a non-secret `label`. The token/secret itself is
  held in a process-scoped store (a `Mutex<HashMap<…>>` now; OS keychain later)
  and **never** crosses the Tauri command boundary into JS.
- Commands: `list_backends()` → `Vec<BackendProvider>` (auth state + caps only),
  `store_backend_credential(providerId, secret)` (Rust writes to store, returns
  nothing but ok), `clear_backend_credential(providerId)`,
  `record_backend_event(...)` (records a backend-originated action as an
  `ApprovalAuditEntry` via the existing audit path — see 2.4).
- `RuntimeSnapshot` is **not** extended with any token field. The only new
  snapshot field is `connectedBackendIds: string[]` (provider ids, not secrets),
  so recovery restores *which* backends were connected, then Rust re-resolves
  auth state from its own store on next `list_backends()`.
- The local-store fallback is behind a `BACKENDS_PRE_RELEASE` const in Rust
  (logged once on first credential write) so it's clearly flagged pre-release.

### 2.4 Approval routing (every consequential action)

Adapters do **not** execute tool calls or file writes directly. When a backend
reports a consequential event (tool call, file write, shell command), the
adapter normalizes it into the existing `ApprovalRequest` shape and pushes it
into the same approval queue the UI already renders. Resolution flows through
`resolve_approval_request` → audit + grant as today.

When a backend *already* approved something internally (e.g. Cursor's own
approval), Arden records it as an **audit entry** (`record_approval_decision`
with `decision: "once"` and a note naming the backend) — it does **not** skip
Arden's layer for subsequent new actions.

### 2.5 Compliance invariants (enforced, not just documented)

- Grok: `entitlements` only ever populated **after** a successful login check;
  nothing in fixture/preview data claims Grok Build is included in any tier.
- No CLI binaries are vendored/redistributed; the ACP adapter only spawns a
  user-installed CLI and fails closed (`install-required`) if absent.
- Claude/Gemini providers are absent from catalogs and registry this goal.

## 3. Adapter designs

Each adapter is a **pure module** in `@arden/connectors/backends/` that (a)
declares its `BackendType` and transport description, (b) resolves capabilities
for a given auth state, (c) provides fixture/preview catalogs. No live network
I/O this goal — transport is described but not spawned, keeping checks green
and the UI testable. (Spawning + streaming is deferred to the agent-loop goal.)

### 3.1 Codex app-server adapter (`backends/codex.ts`)
- `backendType: "codex-app-server"`, the recommended "Continue with
  ChatGPT/Codex" path.
- Supports subscription auth (ChatGPT login) and OpenAI API-key auth
  (BYOK, routed through the same credential boundary).
- Declares: authentication, threads, streaming, tool-requests, approvals,
  file-changes, model-availability, cancellation. Does **not** declare
  usage-cost for the subscription path (entitlement-dependent) — fail closed.

### 3.2 Generic ACP adapter (`backends/acp.ts`) — shared by Cursor + Grok
- `backendType: "acp"` (stdio/JSON-RPC).
- Two provider entries, `cursor` and `grok`, each with an `installHint`
  naming the required CLI and a `resolveAcpCapabilities(authState)` that returns
  `["install-required", …]` → empty capabilities when the CLI is absent.
- Grok's `entitlements` array is empty until a post-login check resolves it.

### 3.3 Copilot SDK adapter (`backends/copilot.ts`)
- `backendType: "copilot-sdk"`; desktop is a supported target.
- Auth modes: subscriber, OAuth app, automation token, BYOK — surfaced as
  selectable auth options; resolution still goes through Rust credential store.
- Declares: authentication, threads, streaming, tool-requests, approvals,
  file-changes, model-availability, cancellation, usage-cost.

### 3.4 Registry (`backends/registry.ts`)
- `listBackendProviders(): BackendProvider[]` merging logic-resolved providers
  with their fixture/preview catalogs; the single source the desktop shell reads.

## 4. Onboarding shell

New route `Onboarding` rendered **before** the main workspace when no backend is
connected (`connectedBackendIds.length === 0`). Three paths, vertical stack:

1. **Subscription** (functional): cards for Codex, Cursor, Copilot, Grok.
   Selecting one attempts connect via the credential boundary; on success the
   provider id is added to `connectedBackendIds` and the gate clears.
2. **API key** (pending): visible card labeled "Coming soon — native API keys"
   disabled, not clickable. (Foundation only this goal.)
3. **Local model** (disabled-but-present): card labeled "Local models — planned"
   disabled.

Gate copy: "Connect one AI backend to continue." A "Skip for now (preview)" link
allows reaching the workspace in fixture/preview mode for testing outside Tauri.

## 5. Testing strategy

- **Protocol**: type-only; covered by downstream compile.
- **Connectors**: `backends/registry.test.ts` + per-adapter tests asserting
  (a) fail-closed capability resolution for each auth state, (b) install
  prompts absent CLI, (c) Grok entitlements empty pre-login, (d) fixtures carry
  no credential/tier promises.
- **Rust**: `backends` module unit tests in `tests.rs` — credential store
  round-trip, `list_backends` never exposes secrets, snapshot has no token
  field, backend event → audit entry.
- **Desktop**: extend `App.test.tsx` — onboarding gate blocks until a backend
  connects; three paths render with correct enabled/disabled states; capability
  controls only render for declared capabilities.

## 6. Non-goals / deferred

Native API keys + Arden-owned agent loop (next goal), local models, enterprise
backends, OpenCode, real OAuth for existing fixture connectors, voice/realtime,
marketing/CI/release-signing, and **live transport** (spawning CLIs / opening
app-server sockets) which is deferred to the agent-loop goal.

## 7. Risk / open questions

- **OS keychain not wired this goal.** Mitigated by the pre-release local-store
  boundary + the invariants in §2.3. The store API shape is designed so the
  keychain swap is internal-only.
- **Live transport deferred.** Adapters describe transport and resolve
  capabilities but don't spawn. This keeps all checks green and matches the
  stated "foundation" framing; the agent-loop goal activates the transports.
