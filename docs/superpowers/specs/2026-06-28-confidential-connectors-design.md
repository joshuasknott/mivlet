# Confidential OAuth broker + production connectors — design

Status: approved-by-objective. This is a factual design that resolves the genuine
architectural decisions the objective leaves open. The objective itself is the
product spec; this document fills in *how* the deployable broker is structured and
how the existing connector code connects to it.

## What already exists (Goal 1, commit `e572264`)

The desktop runtime and connector package already implement the hard, security-critical
parts. This work must not duplicate them:

- **`ConnectorRuntime`** (`packages/connectors/src/sdk.ts`): per-action approval
  boundary, token refresh-before-use + refresh-on-401, retries with backoff honoring
  `retryAfter`, pagination cursors, rate-limit metadata, cancellation via `AbortSignal`.
  Every write capability that is `consequential` requires a fresh, matching, per-action
  approval record or it throws `approval-required` before any egress.
- **Real provider adapters** for GitHub, Vercel, Linear (`create*Adapter`, REST/GraphQL
  egress via `ProviderHttpClient`), and Notion, Slack (`NotionAdapter`/`SlackAdapter`,
  real API egress). Each maps its provider's actual contract (pagination headers, GraphQL
  `pageInfo`, Slack `ok` envelopes, Notion `notion-version`), normalizes errors, and
  redacts secrets at the adapter boundary (e.g. Vercel env `value`, GitHub `email`).
- **Desktop OAuth + credential boundary** (`apps/desktop/src-tauri/src/connector_auth.rs`):
  PKCE S256, single-use `state`/verifier stored in the OS keyring and consumed before
  egress, callback validation (state match + redirect origin/path match + duplicate-param
  rejection), `resolve_broker_endpoints` fail-closed resolver that derives *only* the four
  OAuth paths (no model/search/import/action endpoint is derivable), token storage in the
  keyring, non-secret connection metadata on disk.
- **Existing coverage**: 102 passing tests, including broker fail-closed, callback
  substitution, approval gating for GitHub/Slack, redaction, pagination, rate limits,
  cancellation, malformed responses.

## The gap this work closes

`docs/connectors/auth-broker.md` says **"Status: deferred — this repository does not
contain a deployable auth broker app."** That broker is the primary deliverable. The
secondary gaps are consistency and runtime wiring:

1. No deployable broker app exists.
2. Notion/Slack adapters use a divergent auth shape (POST the whole callback object,
   expect `{tokens, account}` from a single broker endpoint) while GitHub/Vercel/Linear
   use the shared `oauthClient` PKCE contract. All five should share one contract.
3. The broker↔desktop handoff is described in prose but not a typed, versioned contract
   type shared by both sides.
4. The agent runtime advertises `*-read` tools but has no executor dispatch for the
   confidential connectors and no connector-write tools. (The `ConnectorRuntime` already
   enforces approval for writes; this is about *exposing* the surface to the agent loop.)

## Architecture decisions

### Decision 1 — broker host: Node/TypeScript app, not Rust, not Tauri

The broker must be **hostable independently** of the desktop binary ("hosting portable
and narrowly scoped", "do not deploy production infrastructure"). Options considered:

- **Rust/Tauri sidecar** — couples the broker to the desktop toolchain and is awkward to
  run as a standalone HTTPS service.
- **Cloudflare Worker** — portable, but introduces a provider + wrangler toolchain and a
  runtime dialect (no Node `crypto`/`http`), complicating local dev parity.
- **Node/TypeScript app** — recommended. It shares the exact language, types, and
  `@fable/protocol` contracts already in the repo; runs identically locally
  (`http://127.0.0.1`) and behind any HTTPS host; needs no extra toolchain.

The broker is a new workspace package `apps/broker` (a standalone Node HTTP server). It is
**not** a dependency of the desktop build — `pnpm build` keeps building
`protocol → connectors → desktop`. The broker builds separately. This keeps the desktop
release path untouched and satisfies "Keep broker hosting portable and narrowly scoped."

### Decision 2 — broker is the *only* place secrets live

Provider client secrets are read from the broker process environment
(`FABLE_BROKER_GITHUB_CLIENT_SECRET`, etc.) at startup. They never appear in repo config,
the desktop binary, React, logs, or JSON. The desktop never receives a provider secret; it
only ever holds provider *tokens* inside the OS keyring. This matches the existing threat
boundary in `auth-broker.md`.

### Decision 3 — handoff model: short-lived, single-use authorization pass-through

The broker is a **confidential-OAuth PKCE orchestrator**, not a token mint. For
authorization-code flow it:

1. `GET /oauth/{provider}/authorize` — receives the desktop's `redirect_uri`, `state`,
   and PKCE `code_challenge`; builds the provider authorization URL using the broker's
   **confidential client_id** and the desktop-supplied PKCE/state; redirects the browser
   there. The desktop's `state` and `redirect_uri` are carried through.
2. `GET /oauth/{provider}/callback` — the **provider's** registered callback. Validates
   `state`, exchanges the provider code for tokens using the **client secret** (and the
   broker's own code_verifier when the provider requires it), resolves identity, and
   302-redirects the browser back to the **desktop's exact loopback `redirect_uri`** with a
   **short-lived (≤60s), single-use handoff token**.
3. `POST /oauth/{provider}/handoff` — the desktop redeems the single-use handoff token
   (over loopback or HTTPS) for the token set + account. The handoff token is consumed on
   read. This is the "short-lived, single-use handoff data between broker and desktop."

The desktop already expects the *provider* code+state to arrive at its loopback redirect.
Because the desktop cannot mint the confidential exchange itself, the broker performs the
exchange and hands the desktop a short-lived ticket the desktop then swaps for tokens over
a direct (non-browser) call. This prevents: callback substitution (handoff token bound to
the desktop's `state` and consumed once), state replay (single-use), token replay
(single-use handoff, consumed before repeat use), and confused-deputy (the broker only
acts for the provider flow it started, bound to the desktop redirect it was given).

For the existing desktop `completeAuth` path (which posts the *provider* code to
`/oauth/{provider}/token`), the broker's `/token` endpoint remains the exchange target but
now also accepts the handoff redemption. The desktop keeps its existing single-use
`state`/verifier semantics; the broker adds the handoff layer so the confidential secret
never has to be trusted to a browser redirect.

### Decision 4 — one shared OAuth contract for all five providers

Notion/Slack adapters move to the shared `oauthClient` (GitHub/Vercel/Linear already use
it). Their `startAuth`/`completeAuth`/`refresh`/`revoke` then go through the broker PKCE
endpoints like the other three. Notion and Slack tokens are access-token-only in practice
(no refresh rotation for these providers' installed-app flows); `refresh` is a no-op that
returns the token unchanged, which is correct and already what they do. This removes the
divergent "POST whole callback" path.

### Decision 5 — versioned, typed broker contracts

A new shared module defines the request/response shapes every broker route emits and the
desktop consumes, with a `contractVersion`. Both sides import the same type. Unknown
versions fail closed. This satisfies "Define typed, versioned broker contracts."

### Decision 6 — broker operational surface

Health check (`GET /healthz`), structured redacted JSON errors (never echo secrets/tokens),
per-request correlation IDs (`x-fable-request-id`, echoed), and a simple in-memory
fixed-window rate limiter per route + peer. CORS is locked to loopback/desktop origins.
No request body or header value containing a token/secret is logged.

### Decision 7 — local development without weakening production

`pnpm --filter @fable/broker dev` runs the broker on `http://127.0.0.1:8788`. The desktop's
`resolve_broker_endpoints` already accepts loopback HTTP for local dev (test-verified). A
`.env.example` documents the secrets. **No demo/fixture fallback exists in any production
code path** — fixtures stay test-only (already enforced; the broker adds no fixture path).

### Decision 8 — exposing connectors to the agent runtime

The `*-read` tools already advertised get executor dispatch through a new
`ToolRuntime.connectorRead` seam (mirroring the existing `googleRead`). Connector *write*
tools are exposed as a single `connector-write` tool whose dispatch routes through
`ConnectorRuntime.write`, which already requires a fresh per-action approval. Adversarial
tests prove the model cannot bypass approval: a `connector-write` tool call with no grant
(or a tampered approval) never reaches egress. This keeps "every consequential mutation
requires explicit approval" enforced by the existing runtime, not duplicated.

## Components

- `apps/broker/` — standalone Node server: routes, provider profiles, PKCE state store,
  handoff store, rate limiter, health, logging, typed contracts. Vitest unit tests for
  every security property; no live provider calls by default.
- `packages/connectors/src/providers/broker-contract.ts` — the typed, versioned
  broker↔desktop contract shared by broker and (via the package) any consumer.
- `packages/connectors/src/providers/{notion,slack}-api.ts` — refactored onto shared
  `oauthClient`.
- `packages/connectors/src/native-api/{tools,tool-executor}.ts` — connector read/write
  tool dispatch behind the approval gate.
- `apps/desktop/src-tauri/src/connector_auth.rs` — minimal update so the desktop completes
  the broker handoff (single-use handoff redemption) without exposing tokens to JS. The
  fail-closed resolver and keyring storage are unchanged.
- `docs/` — broker architecture & threat boundary, provider app/scope/callback setup,
  dev config, and an explicit "code completion ≠ external provider review" note.

## Non-goals (per objective)

No Knowledge/memory changes, no encrypted-storage migration beyond what the keyring
boundary already does, no broad UX, no schedules/voice/installer/signing/updater/
distribution, no push or merge.

## Definition of done

See the objective's Definition of Done. Concretely this branch delivers: a buildable,
not-deployed broker; all five connectors on one real-API contract; credentials that
survive restart via the OS keyring; production never silently using fixtures; every
consequential mutation gated by the runtime; the full check gate green; committed to
`codex/confidential-connectors`.
