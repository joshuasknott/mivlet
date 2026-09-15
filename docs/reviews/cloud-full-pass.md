# Cloud full-pass review

**Date:** 15 September 2026
**Revision:** `090a47ff` (`main`, merge of PR #60 workspace cleanup)
**Scope:** Analysis only. No application code was changed.
**Method:** Architecture and ADR read-through; targeted review of approval, computer, broker, hosted-runner, agent-host, connectors, knowledge, and Convex boundaries; TypeScript typecheck, quality, and package tests on Linux. Rust/Clippy/`agent-host` Windows executable tests were not runnable in this environment.

This is a source review of a pre-release local-first product. Hosted, broker, and Convex paths are implementation-complete in-repo and **deployment-gated**. Findings below distinguish **live local product** from **must-fix before any hosted deploy**.

---

## What Josh should do first

| Order | ID | Severity | Effort | Why first |
| --- | --- | --- | --- | --- |
| 1 | **L1** | P0 | Small | 15-minute execution freshness is documented, unit-tested, and **disabled on every production consume path**. |
| 2 | **L2** | P1 | Medium | Permit consume is read-modify-write JSON/SQLite without compare-and-swap. |
| 3 | **H1–H3** | P1 (P0 before deploy) | Medium | Hosted runner admin Bearer skips generation; nonce is unused; one secret both mints and administers. |
| 4 | **T1–T3** | P1 | Medium | Tests that would have caught L1, H1, and account-switch invalidation do not exist at the call-site layer. |
| 5 | **C1** | P1 | Small | CI `pnpm test` on Linux cannot run `@fable/agent-host`; several host tests lack a `win32` skip and fail closed with `ENOENT`. |

Everything else in this document is real, but those five close the gap between **claimed fences** and **what the code actually checks**.

---

## Architecture map

```text
Renderer (React / WebView)
  runtime/domains/*  → typed Tauri invoke only (preview returns null)
        │
        ▼
Rust native boundary  (apps/desktop/src-tauri)
  account_session → one Clerk binding, data dir, keyring namespace
  authorized_scope → renderer workspace IDs are assertions; only "default"
  approvals + execution_approvals → persist user decision, consume at dispatch
  tools / connectors / mcp_process / hosted_computer / local_computer
        │
        ├── encrypted SQLite (AES-256-GCM, OS vault key) + OS credential store
        ├── embedded OpenCode host (packages/agent-host, Bun Windows exe)
        ├── Cua Driver 0.25.0 stdio MCP (bundled, hashed, kill-on-close)
        └── optional Convex HTTP (account / hosted provision / capability mint)

packages/protocol     shared contracts + spine parity (Rust/TS)
packages/connectors   providers, MCP, voice, tool/approval shaping, broker HTTP
packages/knowledge    ingest / retrieve / assemble (untrusted-evidence labels)
packages/agent-host   ephemeral SDK session; tools only via Rust boundary

apps/broker           confidential OAuth (GitHub, Vercel, Linear, Notion, Slack)
apps/hosted-runner    Cloudflare computer + browser Durable Objects
```

**Trust rule the code is built around:** model JSON is never authority. Consequential effects require a persisted user decision, rechecked immediately before dispatch. Computer leases are transient, generation-fenced, and never restored from disk.

**Implemented locally:** Windows Tauri shell, encrypted vault (schema v42), named agents, voice, projects/Work/schedules, provider registry, native computer, token plugins, MCP, OAuth, approvals, passive Office authoring.

**Deployment-gated:** Clerk in production, Convex sync, broker Worker, hosted runner (Containers, Browser Rendering, Durable Objects, secrets).

**Explicitly not complete:** post-close conversation continuation, hosted sign-in/secret handoff, multi-device sync, signed installers/updater, macOS/Linux/mobile, production tenancy/DR.

ADRs of record: account-first onboarding, broker ephemeral storage, MCP OAuth registration, provider-driver registry, teammates/conversations/projects.

---

## Verification run (this pass)

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | **Pass** | Protocol spine parity, connectors/knowledge build, agent-host/broker/hosted-runner/desktop `tsc` |
| `pnpm quality` | **Pass** | ESLint max-warnings=0; explicit-any ratchet **127/127**; Prettier on a **narrow** file set; knip clean; 0 cycles across 556 modules |
| `pnpm --filter '!@fable/agent-host' -r test` | **Pass** | connectors 612 (5 skipped); knowledge 307; broker 109; hosted-runner 28; desktop 961 + 2 node tests |
| `pnpm test` (includes agent-host) | **Fail (expected here)** | 50/50 agent-host tests: `spawn .../mivlet-agent-host.exe ENOENT`. CI already excludes this package on Linux. Some test files assert `win32`; `additional-providers.test.mjs` / `providers.test.mjs` do not. |
| `pnpm perf:test` | **Pass** | 12/12 budget unit tests (no production bundle measured) |
| `pnpm release:test` | **Pass** | 6/6 Windows manifest contract tests |
| `pnpm tauri:check` / `cargo test` | **Not run** | Environment Cargo **1.83.0** cannot parse `edition2024` crates (`block-padding 0.4.2`). Native Windows job is the real Rust gate. |
| Live Windows computer / packaged installer / Wrangler deploy | **Not run** | Out of this environment. See `docs/development/local-computer-verification.md` and `docs/product/daily-driver.md`. |

GitHub Issues: none open. Recent closed PRs are feature/fix landings, not a tracked bug backlog.

---

## P0 — local product

### L1. Execution-approval TTL is never applied in production

**Status:** Confirmed. Unit tests and production call sites disagree.

**Invariant:** `EXECUTION_APPROVAL_TTL_SECONDS = 15 * 60`. `verify_and_consume_execution_approval` compares `consumed_at - decided_at` and must reject stale permits (`apps/desktop/src-tauri/src/execution_approvals.rs`).

**Bug:** Every production caller passes **`decided_at` as `consumed_at`**, so the delta is ~0 and TTL always passes:

| Call site | Third argument |
| --- | --- |
| `apps/desktop/src-tauri/src/tools.rs` `verify_tool_authority` | `&request.approval.decided_at` |
| `apps/desktop/src-tauri/src/connectors.rs` | `&resolution.audit_entry.decided_at` |
| `apps/desktop/src-tauri/src/capability_grants.rs` `commit_capability_grant` | `&resolution.audit_entry.decided_at` |
| `apps/desktop/src-tauri/src/hosted_computer.rs` (all consume sites) | `&resolution.audit_entry.decided_at` (and source resolution) |
| `apps/desktop/src-tauri/src/mcp_process/configuration.rs` | `&resolution.audit_entry.decided_at` |

Unit tests in the same module pass an independent later timestamp (`2026-06-27T12:20:01Z`) and **do** exercise TTL. Those tests never run through `tools.rs` / `connectors.rs`.

**Impact:** A persisted single-use permit remains consumable until process/account teardown or explicit invalidation. Walk-away machine, queued Work, or a compromised renderer that delays `execute_tool_call` can fire an approved write/computer/connector/MCP/hosted action hours later. Single-use and fingerprint checks still apply; **freshness does not**.

**Fix:** Pass wall-clock time (`Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`) as the third argument at every call site. Add one integration test that records a permit, warps or injects `consumed_at` 16 minutes later through `execute_tool_call` (or a thin wrapper), and expects stale. Do not “fix” this by changing the unit tests to match production.

**Priority reason:** Smallest change that restores a security invariant the threat model and tests already claim.

---

## P1 — high (local correctness, hosted-before-deploy, or renderer-adjacent)

### L2. Permit consume is not atomic

**Status:** Confirmed race.

`read_records` → mutate `consumed_at` → `write_records` has no file lock and is not a single SQLite `UPDATE … WHERE consumed_at IS NULL`. Production writes go through encrypted preferences when the store is up (`store.rs` `read_document` / `write_document`), but still as two operations.

**Impact:** Two concurrent `execute_tool_call` (or connector/hosted) invocations with the same `request_id` can both observe `consumed_at == None`. Single-use is then a best-effort property.

**Fix:** One SQLite transaction: `UPDATE … SET consumed_at=? WHERE request_id=? AND consumed_at IS NULL AND invalidated_at IS NULL RETURNING …`. Fail if zero rows. Add a two-task concurrency test.

### L3. Routine connector reads skip persisted permits

**Status:** Confirmed; partly by design.

`tools.rs` `verify_tool_authority`: if `routine_connector_read`, require `decision == "once"` and return **without** `verify_and_consume_execution_approval`. JS gate (`packages/connectors/src/native-api/tool-executor.ts`) also auto-grants `isRoutineConnectorRead`.

**Impact:** A renderer that can invoke `execute_tool_call` can perform `gmail-read` / `github-read`-class tools without a user click, as long as the approval JSON shape is valid. This is **not** a model-only bypass (the model still goes through the executor), but it **is** a renderer-compromise / confused-IPC hole relative to “every consequential tool consumes a permit.”

**Fix:** Document in the threat model as session-level account consent, **or** require a persisted permit for high-sensitivity connectors. If keeping the skip, add a negative test that a missing persisted permit still cannot perform **writes**.

### L4. Session/rule grants auto-satisfy the JS gate without minting a native permit

**Status:** Confirmed product/code split.

`packages/connectors/src/native-api/approvals.ts` only offers `once | modify | deny` for native tools, with an explicit comment that session grants wait until native can mint a fresh permit. `createApprovalGate` still auto-satisfies matching **low-risk** standing grants. `desktop-tool-runtime.ts` `resolutionFor` then synthesizes a **new** `once` resolution with a fresh `decidedAt` and does not call `resolve_approval_request` again.

**Impact:** A standing grant can let the executor proceed to Rust, which then looks up a **different** request id / fingerprint and fails closed — or, for routine reads (L3), succeeds without a new user decision. UI that still shows session/rule on some connector surfaces will surprise users.

**Fix:** Either mint a fresh exact native permit from a standing grant at the trusted boundary, or remove session/rule from every UI that cannot mint. Add a test: standing grant + second native write → either a new consumed permit or a clear native error, never a silent skip.

### H1. Hosted admin Bearer skips generation on process/browser routes

**Status:** Confirmed. Hosted is undeployed; this is **P0 before any live runner**.

`apps/hosted-runner/src/request-auth.ts`:

```ts
if (await serviceAuthorized(request, rootSecret)) return { authorized: true };
```

No `expectedGeneration`. `ComputerAuthority.requireCapabilityGeneration(undefined)` is a no-op. Process launch/inspect/kill and browser routes therefore skip generation fencing when `Authorization: Bearer <FABLE_HOSTED_RUNNER_API_KEY>` is present.

Architecture (`docs/architecture/hosted-teammate-computer.md`) says admin is provision/destroy; scoped operations use generation-fenced capabilities.

**Impact:** Stolen runner root secret already allows destroy/recreate. Additionally, Bearer on scoped routes **ignores generation after recreate**, so stale fleet automation is not fenced. Same secret also HMAC-signs capabilities (H3).

**Fix:** Reject Bearer on process/browser routes. Admin stays PUT/GET/DELETE computer only. Test: Bearer + `process:launch` → 401; capability with old generation after destroy → 409.

### H2. Capability nonce is not consumed; “one-time use” is documentation only

**Status:** Confirmed doc/code mismatch.

`verifyHostedExecutionCapability` checks HMAC, `computerId`, scope, lifetime, and **parses** `nonce`. Nothing stores or consumes it. Convex mints `cap-${uuid}` (`apps/desktop/convex/hostedExecution.ts`). Docs claim the runner rechecks nonce and one-time use.

**Impact:** A leaked capability is replayable until `expiresAt` (Convex: 2 minutes; protocol max: 5). Browser `act` / process `launch` can be repeated. `requestKey` idempotency on some routes mitigates duplicate launches, not replay of inspect/act.

**Fix:** Per-computer Durable Object nonce table, TTL-aligned, consume on first use. Or drop the “one-time” claim from the architecture doc until implemented. Tests must cover replay.

### H3. One env var is both fleet admin credential and capability HMAC root

**Status:** Confirmed.

`FABLE_HOSTED_RUNNER_API_KEY` is used as Bearer for provision (`convex/hostedExecution.ts` `provisionScheduled`) and as HMAC key for `signHostedExecutionCapability`.

**Fix:** Split `FABLE_HOSTED_RUNNER_SERVICE_KEY` (provision/destroy only) from `FABLE_HOSTED_RUNNER_SIGNING_KEY` (capabilities only). Renderer still must never see either.

### H4. Convex `requestExecutionCapability` is a public action

**Status:** Confirmed; native-only today.

The action is not `internalAction`. Rust `hosted_computer.rs` `call_convex` is the intended client; React uses Tauri `hosted-computer` domain and has **no** `ConvexReactClient`. A future renderer Convex client would pull capability tokens into JS, violating the threat model.

**Fix:** Make the action internal, or require a native-only Convex admin key. Add a comment/test that desktop `src/` cannot import this action.

### B1. Broker `refresh` / `revoke` are unauthenticated confidential proxies

**Status:** Confirmed; likely intentional OAuth proxy.

Anyone who obtains a refresh token can rotate or revoke via the broker (IP rate limit only). Handoff redeem is ticket + `state` (60s, single-use). Desktop PKCE `code_challenge` is **required on authorize** but **not bound** into the broker-owned PKCE verifier (`apps/broker` tests expect it absent from the provider URL). Durable path enforces `state` length ≥ 16; in-memory path does not (`computeStateHash` vs `stores.ts`).

**Impact:** Acceptable if refresh tokens stay in the OS store and the broker URL is trusted. High if tokens leak (logs, backups, malware). Contract text currently overclaims desktop PKCE.

**Fix:** Document the threat model; enforce `state` entropy on all backends; optionally bind desktop PKCE or sign refresh from the native session.

### T1. Agent-host tests on Linux abort the whole `pnpm test` graph

**Status:** Confirmed this run.

`packages/agent-host/test/support/host-process.mjs` always spawns `mivlet-agent-host.exe`. `agent-host.test.mjs` asserts `win32`; several other files do not. Root `pnpm test` runs agent-host first and fails 50/50 here. PR CI works around this with `pnpm --filter '!@fable/agent-host'`.

**Fix:** Skip (not fail) when `process.platform !== "win32"` or the exe is missing, in **every** host test file. Keep Windows CI as the real gate.

---

## P2 — medium / hardening / process

| ID | Finding | Path | Impact | Fix |
| --- | --- | --- | --- | --- |
| L5 | Thread payload AAD omits workspace (`format!("thread:{id}")`) while the function takes `_workspace`. Messages/collaboration include workspace. | `store/repos/thread.rs` | Ciphertext-swap if two workspaces ever share a thread id. Today only `"default"` workspace exists, so practical risk is low. | `format!("thread:{workspace}:{id}")` with a re-seal-on-read migration. |
| L6 | `confine_path` skips post-canonical containment when the target does not exist; relies on `contains_symlink` of prefixes. | `tools.rs` | Residual TOCTOU if a directory is replaced by a symlink between check and `create_dir_all`. | Canonicalize parent under workspace root; `O_NOFOLLOW` where available. |
| L7 | `local_computer_cancel` with a stale `expected_generation` still returns a snapshot; `stop_scope` no-ops if generation mismatches. | `local_computer.rs`, `control.rs` | Confused Stop for the wrong generation; lease may remain. Ctrl+Alt+Esc / global stop still work. | Fail closed when generation ≠ authority snapshot. |
| L8 | `draft.rs` still has unused `fn aad(id)` (`draft:{id}`) beside the real scoped AAD `draft:{workspace}:{thread}:{id}`. Same pattern in `approval.rs` / `connector_cache.rs` leftover helpers. | store repos | Confusion for the next AAD change; not a live encrypt bug if unused. | Delete unused helpers; make AAD construction one function per table. |
| H5 | `isPrivateHostname` rejects all IPv6 (`hostname.includes(":")`) and only checks dotted-decimal IPv4. Leading-zero / octal hostnames (e.g. `0177.0.0.1`) are not in `contracts.test.ts`. | `hosted-runner/src/contracts.ts` | Fail-closed for public IPv6 (availability). Possible SSRF if the browser interprets octal IPv4 as loopback. Undeployed. | Canonicalize via resolved addresses; reject any hostname that is not a public A/AAAA after DNS; test octal/decimal/hex forms. |
| H6 | Knowledge `assembleContext` defaults `isSourceAuthorized` to `() => true`. | `packages/knowledge/src/context/assemble.ts` | Caller omission includes unauthorized sources. Labels still mark evidence untrusted. | Require the predicate (type-level or runtime assert in desktop builds). |
| H7 | MCP initialize `instructions` from a connected server are passed through. | `packages/connectors` SDK client | Malicious MCP server can steer the model. Bounded by user connecting that server. | Surface instructions in the connection UI; never treat them as authority. |
| P1-CI | PR CI does not run `verify:build`, perf, or `audit:all`. Rust runs only when `scripts/ci/affected.mjs` marks `native`. | `.github/workflows/ci.yml` | TS-only PRs can miss embed-host / bundle / audit breakage until nightly `full.yml`. | Linux `verify:build` (or a slim embed-host build) on `code` jobs. |
| P2-fmt | `pnpm format:check` covers a handful of paths, not the repo. | root `package.json` | Format drift outside that glob is invisible. | Expand slowly, or drop the false sense of repo-wide Prettier. |
| P3-any | explicit-any ratchet is **at the cap** (127/127). | `scripts/quality/check-explicit-any.mjs` | Next `any` fails CI; pressure to weaken the ratchet. | Pay down a few `any`s when touching those files; do not raise the cap. |
| P4-rustenv | This cloud agent has Cargo 1.83; lockfile pulls `edition2024` crates. | environment | Cannot validate Rust here. | Not a product bug. Windows CI remains authoritative. |

---

## Security and reliability (cross-cutting)

### What is strong (do not regress)

- Renderer never holds provider/connector/vault secrets; CSP production `connect-src` is `ipc:` only (`tauri-csp.test.ts`).
- Conversation Markdown drops raw HTML, blocks images, and allows only `safeConversationLink` schemes (`MessageMarkdown.tsx`, `safe-output.ts`).
- Web preview iframes use `sandbox=""` (no scripts, no same-origin).
- Custom provider HTTP is loopback-only; remote custom HTTP is rejected (`native_api.rs`).
- `web-fetch` blocks credentials, unsafe ports, loopback/private/link-local/cloud-metadata, and re-checks DNS (`tools.rs`).
- Computer lease: generation, HWND reuse marker, background vs foreground latch, no persisted input permission, Stop / Ctrl+Alt+Esc, background screenshots disabled because Cua capture can crop the desktop.
- Account process pinning: identity change restarts; `authorized_scope` rejects non-`default` workspace IDs.
- Vault: AES-256-GCM, fresh nonces, row AAD on most tables, OS-stored key, fail-closed on newer schema / FK / integrity.
- Broker: single-use state and handoff, encrypted Durable Objects for staging/production, no conversation data, Google stays public PKCE off-broker.
- Agent-host: `:memory:` DB, deny-by-default tools, loopback provider bridge, no host shell, credentials stay in Rust.
- Office authoring: declarative aggregates only (`Sum/Average/Min/Max/Count`), structural validation, immutable publication.

### Residual threats the threat model already admits

- Stolen unlocked Windows session = full local vault + keyring.
- Native computer shares the user session; a permitted app keeps its own filesystem/network.
- Password-field heuristics fail closed, but private screen content cannot be classified.
- Remote sync is not claimed E2E encrypted (and is not a product claim).
- No signed updater channel.

### Reliability notes (local product)

- Work recovery on restart moves active items to `awaiting-user` and does not replay effects (`docs/architecture/work-execution.md`). Attachment-only-in-memory inputs fail closed with reattach copy — keep this honest in UI.
- Voice: echo-cancellation gating, interrupt, End, 45s lease heartbeat. Remaining debt is **live** device acceptance, not missing architecture.
- DeepSeek: non-thinking mode only; screenshot tools correctly unadvertised (`computer-vision.ts`). Do not market vision there.
- Full Access auto-resolves exact `once` approvals in the shell (`useWorkspaceApprovals.ts`) but still persists and consumes native permits — **except** L1 freshness and L3 routine reads.

---

## Test gaps (highest leverage)

These would have caught or locked L1–H2. Prefer them over more UI snapshot tests.

1. **Call-site TTL:** `execute_tool_call` / connector dispatch with `consumed_at = decided_at + 16min` must fail. Today only `execution_approvals.rs` unit tests pass an explicit later timestamp.
2. **Concurrent consume:** two tasks, one permit, exactly one success.
3. **Hosted Bearer ≠ scoped ops:** `authorizeCapabilityRequest` + `ComputerAuthority.launch` with Bearer and omitted generation must fail (or skip generation check must be deleted).
4. **Capability replay:** same token twice after nonce consumption (once H2 is implemented).
5. **`capability_grants.rs`:** no unit tests beside the hosted-runner protocol tests. Mirror `hosted-runner/src/capability.test.ts` on the desktop commit path.
6. **Account transition:** one Rust sequence — identity generation bump invalidates unconsumed permits, computer generation, connector cache writes. Partial coverage exists in `connector_cache.rs` and Clerk tests; not one fence test.
7. **Cross-workspace opaque IDs:** table-driven fail-closed deletes on collaboration/thread/message repos (`docs/architecture/workspace-data-model.md` rules 4–5). `authorized_scope` has two tests.
8. **Encryption migration:** v41→v42 decrypt per AAD label. Vault unit tests exist; migration+AAD integration does not.
9. **Agent-host non-Windows skip** in every file that uses `host-process.mjs`.
10. **Octal/encoded IP** cases in `hosted-runner` `contracts.test.ts` and native `web-fetch` tests.

Live acceptance (not unit tests) remains the daily-driver P0: packaged computer/browser/research, Google/GitHub/Vercel live workflows, crash/restart side-effect reconciliation (`docs/product/daily-driver.md`).

---

## High-leverage improvements (not bugs)

Ranked by leverage for the local daily driver, then hosted readiness.

### Local product (do these)

1. **Fix L1 + L2 together** in one PR: wall-clock consume + atomic SQLite row. Restores the approval story you already document.
2. **One account-isolation integration test** (gap 6). Cheaper than another settings screen.
3. **Make session/rule honest** (L4): hide the decisions or mint native permits. The comment in `approvals.ts` already knows this is unfinished.
4. **Linux CI `verify:build`** (or embed-host typecheck+build without the Windows exe tests) so TS PRs cannot skip the host compile.
5. **Pay down a handful of `any`s** so the 127 ratchet is not a merge blocker the next time someone needs one.

### Hosted / broker (before any deploy)

6. Split runner secrets; reject Bearer on scoped routes; consume nonces; make `requestExecutionCapability` internal.
7. Broker: `state` entropy on memory path; align PKCE contract text with broker-owned verifier; consider signed refresh.
8. Wrangler dry-run in PR CI when `apps/broker` or `apps/hosted-runner` change.

### Product / vision (no scope creep)

9. Close the **packaged** computer + one direct-API image route + one Codex route loop in `local-computer-verification.md`. Code movement is not that evidence.
10. Token plugins: expired-token fail-closed UX (reads-only, manual renewal is already documented — make the error the product).
11. Keep hosted vs local vs preview **copy** distinct everywhere a computer picker appears. The architecture is already honest; the failure mode is UI implying a fixture is live.

### Explicitly do not

- Add a host-shell fallback.
- Treat browser Vite preview as native capability.
- Raise the explicit-any cap or weaken TTL tests to match the bug.
- Claim multi-device sync or E2E remote encryption.
- Copy proprietary provider branding.

---

## Suggested implementation sequence

```text
PR A  L1 TTL call sites + integration test          (local P0, small)
PR B  L2 atomic consume + concurrency test          (local P1, medium)
PR C  T1 agent-host skip on non-Windows             (CI hygiene, small)
PR D  H1+H3 Bearer/secret split + tests             (hosted, before deploy)
PR E  H2 nonce consume or doc correction            (hosted, before deploy)
PR F  L4 session/rule honesty                       (product clarity)
PR G  account-isolation + capability_grants tests   (regression locks)
```

Do not bundle A with D. Local freshness and hosted fencing are different merge risks.

---

## Open GitHub / process

No open issues. Treat this file as the current prioritized backlog for security/correctness. When landing A–G, file issues only if a PR will not follow immediately — otherwise the code+test is the tracker.
