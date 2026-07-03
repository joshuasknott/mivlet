# Overnight Security Discovery Report

**Branch:** `grok/overnight-security-discovery` (local worktree only)  
**Date:** 2026-07-03  
**Scope:** Read-only repository-wide security discovery pass.  
**Constraints:** No production code changes, no pushes/merges/deploys, no live credentials or external services. One report under `docs/security/`. One local commit only.  
**Methodology:** Full source review of listed boundaries using file reads, targeted greps, static call-graph analysis (entrypoint → validation/control → sink), cross-reference to threat model (`docs/security/threat-model.md`), inspection of existing tests/unit tests (no execution against live), attempted `cargo check` / `cargo test` (targeted) / `pnpm` filter tests.  
**Prompt 03 note:** Reviewed relevant areas (e.g. export/import design, encrypted storage, tool/web surfaces) per instructions without duplicating any prior implementation work; kept strictly report-only.  
**Existing threat model reference:** All candidates evaluated against Assets, Trust Boundaries, Key Risks, and Controls in `docs/security/threat-model.md`. No absent future features classified as vulns.

## Summary of Categories
- **Confirmed:** Clear gaps or weaknesses with direct evidence against current controls.
- **Plausible (needs validation):** Suspicious patterns; evidence incomplete without live repro or additional runtime data.
- **Defense-in-Depth:** Layered controls that are effective or correctly fail-closed; noted for completeness.
- **Non-Findings:** Areas that appear sound per inspection and threat model; counter-evidence checked.

For each candidate: exact file(s)/function(s), entrypoint→control→sink, prerequisites, impact, confidence (low/med/high), attempted reproducer/test, counterevidence attempted.

---

## Confirmed Findings

### 1. Web-fetch egress lacks SSRF / outbound destination controls
- **Evidence:** `apps/desktop/src-tauri/src/tools.rs:884` (`run_web_fetch_egress`), `534` (`web_fetch_url_from_args`), `889` (`reqwest::Client::new(); client.get(url)`), `718` (in `execute_tool_call`).
- **Entrypoint → control → sink:** React/TS `createDesktopToolExecutor` (desktop-tool-runtime.ts:39) or schedule → `executeRuntimeToolCall` (runtime.ts) → Tauri `invoke("execute_tool_call")` → `execute_tool_call` (validates name/binding/permit) → `ToolOutcome::NeedsWebFetch` → `run_web_fetch_egress` (scheme recheck) → direct `reqwest.get` (no IP filtering, no private-range block, no allowlist).
- **Prerequisites:** Agent (or scheduled job) with "read-only" (or higher) permission that receives/chooses a web-fetch tool call; approval granted for the action (medium risk).
- **Impact:** SSRF to localhost services, link-local (169.254), RFC1918, cloud metadata endpoints (169.254.169.254), internal hosts reachable from desktop. Can leak instance metadata, hit internal APIs, or cause internal DoS if attacker-controlled prompt or schedule exists.
- **Confidence:** High.
- **Reproducer/test (no live creds):** In source: `web_fetch_url_from_args` unit tests only assert http(s) prefix (tools.rs: tests). No integration test blocks 127.0.0.1 or 10./192.168. In runtime: after approval, supply `{"url":"http://127.0.0.1:9/"}` or metadata URL. Existing `WebFetchOutcome` tests are pure shape only.
- **Counterevidence attempted:** Full read of `run_web_fetch_egress`, `Client` builder (no `ip_filter`/`no_proxy`/timeout policy beyond connect/read), `execute_tool_outcome`, permission_policy effect "web-fetch", threat-model "Remaining Security Work" explicitly calls out need for "outbound network policy controls and SSRF protection". No other guards present. (Reviewed adjacent overnight-web-fetch-ssrf area without duplicating.)

### 2. Workspace root resolution for tools can fall back outside intended user content area
- **Evidence:** `apps/desktop/src-tauri/src/tools.rs:31` (`resolve_workspace_root`), `714` (call in execute), `338`/`368`/`401` (confine + run_*), `39` (current_dir or app_data_dir fallback).
- **Entrypoint → control → sink:** `execute_tool_call` → `resolve_workspace_root` (no Tauri `app.path().document_dir` or explicit workspace fs root) → `confine_path` (relative only) → `std::fs::open`/`write`/`Command::current_dir` in app_data or launch cwd.
- **Prerequisites:** Tool call (read/write/shell) approved; current_dir() fails or process launched without stable cwd (e.g. from Start Menu, certain installers, tests).
- **Impact:** File tools and shell may read/write/execute under `app_data_dir` (secrets-adjacent paths) or arbitrary launch dir instead of user-intended workspace root. Violates "workspace-confined" expectation in threat model.
- **Confidence:** Medium (depends on launch environment; Windows PowerShell vs explorer launch varies).
- **Reproducer/test:** Targeted test attempted via `cargo test ... confine_path`; env build stalled. Source inspection + `run_read_file`/`run_shell` call sites. Unit tests for `confine_path` exist (reject .. and absolute) but do not assert root choice.
- **Counterevidence attempted:** Inspected `paths.rs` (only app_data JSONs), no other root resolver for tools; lib.rs setup uses app_data for stores only. No explicit "project root" picker surfaced to confine.

### 3. Tauri webview CSP disabled + minimal capabilities increase XSS → IPC blast radius
- **Evidence:** `apps/desktop/src-tauri/tauri.conf.json:30` (`"csp": null`), `apps/desktop/src-tauri/capabilities/default.json:5` (only "core:default", "notification:default"), lib.rs:210 (all ~70 commands registered unconditionally), runtime.ts:1 (direct `invoke` from any frontend code).
- **Entrypoint → control → sink:** Any injected script in main webview (via compromised dependency, future remote content, dev tooling, or mobile-remote preview) → direct `invoke("execute_tool_call" | "store_backend_credential" | ...)` → Rust command (some have internal rechecks, but lists/snapshots/reads may leak).
- **Prerequisites:** XSS or script injection in the desktop webview (build-time or runtime).
- **Impact:** Bypass of React approval UI; direct access to read state, trigger tools if permits can be influenced or listed, read connector metadata, etc. Amplifies any frontend vuln.
- **Confidence:** High (explicit null + narrow caps).
- **Reproducer/test:** Static: no CSP source values. Desktop tests use mocked invoke. No CSP test in App.test.tsx or vite config.
- **Counterevidence attempted:** Checked `gen/schemas`, other capabilities (none), tauri docs patterns in comments; reviewed grok/overnight-tauri-csp area by inspection only. Threat model "UI to Rust runtime" boundary assumes trusted webview.

---

## Plausible-Needs-Validation

### 4. Loopback OAuth listener performs minimal HTTP parsing; potential request smuggling / header confusion on callback
- **Evidence:** `apps/desktop/src-tauri/src/oauth_loopback.rs:100` (`read_callback_target` takes first line only, `split_whitespace`, builds `callback_url` from it), `190` (timeout 5min), `220` (passes to `complete_auth`).
- **Entrypoint → control → sink:** `begin_connector_oauth` / loopback flow → browser open → listener.accept + read → `complete_auth` (state/redirect match + single-use).
- **Prerequisites:** Attacker-controlled redirect response or MITM on loopback (hard on 127.0.0.1) or malicious provider that returns crafted status line.
- **Impact:** If parser accepts weird targets, could influence `callback_url` passed downstream (though complete_auth does full Url parse + exact match later).
- **Confidence:** Low-medium (local listener, complete re-validates).
- **Reproducer/test:** Manual: `curl -v http://127.0.0.1:port/callback?state=..` with odd encoding. No dedicated parser tests beyond basic flow in connector_auth tests.
- **Counterevidence attempted:** Read full `complete_with_store` (714+): duplicate param check, state match, redirect component match (scheme/host/port/path), single-use remove *before* token exchange, age check. Redirects restricted to literal loopback per threat model.

### 5. ACP child process spawn uses PATH lookup for "cursor"/"grok" without absolute path pinning or allowlist of install locations
- **Evidence:** `apps/desktop/src-tauri/src/acp_process.rs:187` (`Command::new(spec.executable)` where executable from catalog), `367` (detect), no PATH sanitization or full-path enforcement.
- **Entrypoint → control → sink:** `spawn_acp_process` (Tauri cmd, provider allowlist only) → `Command::new("cursor" or "grok")` (PATH) → child with piped I/O.
- **Prerequisites:** Malicious executable of same name earlier in PATH (user or system PATH manipulation).
- **Impact:** Arbitrary code execution under Fable process context if wrong binary wins PATH.
- **Confidence:** Medium (common for CLIs; mitigated by user-install expectation).
- **Reproducer/test:** `PATH=/tmp/malicious:$PATH cargo test ... detect_acp_cli` (env-dependent).
- **Counterevidence attempted:** Catalog closed set only (`acp_executable_for`), arg length bound, no shell, pipes + supervised drain, "CLI owns its own auth" invariant. No extra_args interpolation.

### 6. Scheduler in-process tick + lease model has no cross-process instance guard (multiple Tauri processes)
- **Evidence:** `apps/desktop/src-tauri/src/lib.rs:100` (spawn tick), `scheduler.rs:10` (lease map is "cross-window" only within single process), `RUNNING_LEASE_MS` etc.
- **Entrypoint → control → sink:** Separate `fable.exe` processes → each initializes own `SchedulerState` + own tick → both may lease/execute same `deduplication_key` if DB constraint bypassed or timing.
- **Prerequisites:** User (or installer) launches multiple desktop instances against same app_data/vault.
- **Impact:** Duplicate scheduled runs / side effects.
- **Confidence:** Low (Tauri apps usually single-instance via OS; unverified here).
- **Reproducer/test:** Launch two instances; inspect `list_scheduler_queue` / job attempts. Tests in scheduler use in-memory or single process.
- **Counterevidence attempted:** DB has `UNIQUE(workspace_id, deduplication_key)` + lease_token fencing + `in-process tick` comment. No `single_instance` plugin or named mutex visible in Cargo.toml / lib.rs.

---

## Defense-in-Depth

### 7. Tool approval re-validation + permit consumption + binding checks (multiple layers)
- **Evidence:** `tools.rs:613` (validate_tool_approval_binding: mode/risk/action/arg preview match), `629` (verify_and_consume_execution_approval), `152` (resolve_approval), permission_policy.rs:147 (`ensure...`), approvals + execution_approvals modules.
- **Entrypoint → control → sink:** TS gate → Rust command → multiple rechecks → side effect. Exact arg preview set comparison.
- **Impact reduction:** Argument substitution, mode downgrade, replay, and stale permits fail closed. Matches threat model "General approval UI state is not execution authority... exact, fresh, unconsumed permit".
- **Confidence:** High. Tests cover binding, deny, permit.
- **Notes:** Strong; also audited via action_history.

### 8. Local file/folder import uses browser File API + Rust basename-only + size/fingerprint/content match + extension allowlist + cap
- **Evidence:** `useShellRuntime.ts:1384` (readFileAsText via File), `1449` (folder via webkitRelativePath, slice MAX), `knowledge.rs:80` (import_local_text_file: rsplit /\\ basename, size match, is_supported, MAX_BYTES, fingerprint), no Rust fs read of user paths for import.
- **Controls:** No path used for read (content supplied), recursive capped in UI, unsupported/empty/oversize/binary fail closed. Untrusted by default.
- **Matches threat model:** "Local imports retain provenance and bounded previews. Recursive folder import is capped..."
- **Non-vuln:** Path confinement not applicable here (unlike tools).

### 9. Encrypted SQLite + separate keyring services + AAD binding + transactional migration/export
- **Evidence:** `store/vault.rs` (AES-256-GCM + nonce + AAD `table:ws:id`), `store/keys.rs` (VAULT_KEYRING_SERVICE separate from backends/connectors), `store.rs` (init + integrity + migrations), `portable.rs` (validate_no_secrets + contains_secret_material heuristic + skip-existing + tx rollback + disconnected import state).
- **Matches threat model controls extensively.**
- **Gaps noted only in remaining work (CI for all keyrings).**

### 10. OAuth: high-entropy state, PKCE S256, exact redirect match, single-use verifier/ticket consume-before-egress, pending age, broker vs PKCE separation
- **Evidence:** `connector_auth.rs:783` (state+id match), `810` (redirect components), `791` (age), remove before exchange, `oauth_loopback.rs`, broker (single-use handoff), pkce.ts.
- **Strong per threat model.**

### 11. Connector reads/writes/cache/sync gated by fresh approvals + profile + health
- **Evidence:** `connectors.rs` (prepare/execute commands), `connector_approvals.rs`, `permission_policy`, `connector_sync.rs`, `connector_cache.rs` (read-only manifests).
- **Writes fail closed on read-only profile.**

### 12. Native streaming + ACP process adapters: provider allowlists, size/request_id validation, piped I/O, no secret cross, no shell
- **Evidence:** `native_api.rs:210` (NATIVE_PROVIDER_IDS + request_id charset/len + body size), `acp_process.rs` (closed catalog, length bounds, supervised children).
- **Good isolation.**

### 13. Browser/mobile preview boundaries: explicit fixture labels, no secret leakage, no live engine yet, fail-closed
- **Evidence:** `browser-automation.md`, protocol types (source: "fixture-preview"), mobile-remote authorization + threat extension, remote_handle_command rejects until transport.
- **Deferred live paths correctly fail closed.**

### 14. Scheduler: DB unique + lease fencing + plaintext lease cols + encrypted payload + in-process single-process guard + recovery
- **Evidence:** scheduler.rs + lib.rs tick + store repos.

### 15. Export/import/backup: secret scan, tx atomicity, no credential_refs, skip-existing, WAL notes, phrase delete
- **Strong.**

---

## Non-Findings

- Local import path handling (no backend FS open; browser grants the selection).
- Closed tool registry + name validation.
- Key separation (3 distinct keyring services).
- Redaction in action_history / logs.
- Read-only routes correctly block writes/schedules/shell.
- Single-use permits and state for approvals/OAuth.
- No direct JS shell/fs (all via Rust).

---

## Coverage Gaps Identified

1. **Test execution environment:** `pnpm test` blocked (node_modules absent); targeted `cargo test` (confine_path, web_fetch, tools) and `cargo check` reached dep compile phase but stalled (thiserror/rustc on host; possible missing Windows MSVC components or crates cache). Relied on source + `*.test.*` + `store_tests.rs` / `tests.rs` / connector conformance tests.
2. **No live keyring CI coverage** (threat model already notes: "Add platform CI for macOS Keychain and Linux Secret Service; Windows and mock-store coverage alone is insufficient").
3. **No SSRF / network egress policy tests** (only outcome shapes and scheme prefix).
4. **OAuth / loopback parser coverage limited** to happy + basic error paths; no fuzz or malformed HTTP target tests.
5. **Scheduler multi-instance / cross-process** not exercised (single-process tests only).
6. **ACP PATH resolution** no adversarial PATH tests.
7. **Tool root resolution** tests do not cover fallback to app_data or launch scenarios.
8. **CSP / capability surface** has no automated policy test.
9. **Browser automation / mobile-remote** mostly design + pure logic tests; transport not live.
10. **Export/import secret scanner** heuristic (normalized key names) — no property-based tests against real token shapes.
11. **Action history redaction** tested via unit but not end-to-end with all sinks.
12. **Connector sync / cache** boundary tests exist but limited end-to-end without providers.
13. **Native streaming body/request_id** bounds tested; cancellation + size truncation paths covered in unit but not adversarial streams.
14. **No automated "headless" scheduler tick simulation** outside Tauri process.

---

## Ranked Set of Independent Fix Prompts

Prioritized by impact + blast radius + alignment to threat model remaining work. Each is standalone (no ordering dependency).

1. **(Highest) Add SSRF + outbound network policy to web-fetch**  
   Prompt: "In apps/desktop/src-tauri/src/tools.rs, extend web_fetch_url_from_args and run_web_fetch_egress to reject private/reserved IPs (loopback, link-local, RFC1918, 169.254.169.254, ::1, etc.) and non-global destinations. Add a small allowlist config or explicit opt-in for localhost in development only. Keep the existing scheme check and approval layer. Add unit tests for the new validator using examples from the threat model. Update docs/security/threat-model.md Remaining work. Do not broaden web-fetch usage."

2. **Tighten workspace root resolution and document confinement intent for tools**  
   Prompt: "Refactor resolve_workspace_root (tools.rs) to prefer an explicit, user-chosen or app_data-adjacent workspace root (never silently fall back to app_data for file/shell ops). Make the root choice auditable. Add or strengthen tests that assert confinement root for read/write/shell. Update relevant docs and comments referencing 'workspace-confined'."

3. **Enable a strict CSP and expand capabilities minimally for Tauri webview**  
   Prompt: "Replace `csp: null` in apps/desktop/src-tauri/tauri.conf.json with a production-safe CSP (default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' for current UI; object-src 'none'; base-uri 'self'; frame-ancestors 'none'). Add any required plugin permissions to capabilities/default.json explicitly rather than broad core:default. Add a smoke test asserting CSP presence. Coordinate with any dev-server relaxations."

4. **Harden loopback OAuth callback parsing**  
   Prompt: "Replace minimal line-split in oauth_loopback.rs read_callback_target with a proper (but minimal) HTTP request parser or at least stricter validation of method + target length + no embedded newlines. Add tests for malformed callbacks. Ensure downstream complete_auth remains the authority."

5. **Pin or validate ACP executables more strongly (PATH hygiene)**  
   Prompt: "In acp_process.rs, add an optional absolute-path override or PATH search restricted to well-known safe locations per platform. Log/audit the resolved executable path. Add a test that simulates PATH manipulation."

6. **Add single-instance guard or cross-process lease coordination for scheduler**  
   Prompt: "Add a process-wide named mutex / single-instance plugin or DB-level advisory lock so multiple Fable processes cannot simultaneously tick the same scheduler store. Or document+enforce single-instance. Update scheduler tests to simulate or assert the guard."

7. **Strengthen portable export/import secret scanner + add property tests**  
   Prompt: "Augment contains_secret_material (portable.rs) with more patterns and context-aware scanning of encrypted payloads after decrypt (or pre-seal). Add property-based or table-driven tests that seed real-looking tokens and assert rejection. Keep transactional + skip-existing."

8. **Expand keyring + migration coverage in CI and add mock + real platform tests**  
   Prompt: "Per threat model, add GitHub Actions jobs exercising keyring on Windows (current), Linux Secret Service (via dbus mock or container), macOS Keychain (via runner). Ensure migration idempotency + rollback tests run against real SQLite + vault in CI without live provider tokens."

9. **Add negative/out-of-bounds tests for native streaming and ACP arg sizes**  
   Prompt: "Add adversarial tests (oversize bodies, bad request_ids, huge extra_args) for stream_backend_completion and spawn_acp_process that assert fail-closed before any egress or spawn."

10. **Document and test browser/mobile preview isolation invariants**  
    Prompt: "Add explicit tests + docs assertions that fixture-preview sources never promote to trusted memory, never carry secrets, and that remote_handle_command is a no-op until a live trusted transport is registered. Cover revocation and offline paths."

---

## Appendix: Key Files Reviewed (non-exhaustive)
- Threat + architecture: `docs/security/threat-model.md`, `docs/architecture/encrypted-storage.md`, `docs/architecture/mobile-remote.md`, `docs/architecture/browser-automation.md`
- Tauri IPC / tools / paths / approvals: `apps/desktop/src-tauri/src/{lib.rs,tools.rs,paths.rs,approvals.rs,execution_approvals.rs,permission_policy.rs,knowledge.rs}`
- Storage / export: `apps/desktop/src-tauri/src/store/{*.rs, vault.rs, keys.rs, migrations/*}`, `portable.rs`
- OAuth / connectors: `apps/desktop/src-tauri/src/{oauth_loopback.rs,connector_auth.rs,connectors.rs,connector_*.rs,google.rs}`, `apps/broker/src/*`
- Native / processes / scheduler: `native_api.rs`, `acp_process.rs`, `scheduler.rs`, `lib.rs`
- Frontend boundaries: `apps/desktop/src/{runtime.ts,hooks/useShellRuntime.ts,lib/desktop-tool-runtime.ts}`, `packages/connectors/src/{local-files.ts,*.ts,scheduler/*,browser-*,mobile-remote/*}`
- Tests: many `*.test.*`, `store_tests.rs`, `tests.rs`, connector conformance/provider-hardening tests.

**End of report.** All analysis read-only. One commit will add this file only.

---

*Generated autonomously on grok/overnight-security-discovery. No production changes.*
