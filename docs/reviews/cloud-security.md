# Cloud and local security review

- **Date:** 2026-09-15
- **Revision:** `090a47ff` (`main` at review start); P2 corrections from
  Codex review on PR #61 (replay window, mock Clerk issuer severity, Codex
  screenshot bridge).
- **Kind:** analysis only. No application code was changed.
- **Scope:** secrets custody, account/session, confidential OAuth broker, exact
  approvals and computer leases, native and hosted computer use, provider
  credentials, transcript/log leakage, hosted-runner gating, and fail-closed
  behavior.

This review is a source-code deep dive of the reachable local product plus the
repository's optional broker, Convex, and hosted-runner foundations. It does
not assert that any remote environment has been deployed, independently
pentested, or live-validated. It complements
[docs/security/threat-model.md](../security/threat-model.md) and the broker /
hosted-computer ADRs; it does not replace them.

## Method

Reviewed architecture and ADRs, then traced production reachability in:

- `apps/desktop` (React + Tauri/Rust)
- `apps/broker`
- `apps/hosted-runner`
- `apps/desktop/convex`
- `packages/protocol`, `packages/connectors`

Emphasis was on what the code actually does at the last trusted boundary, not
on comments or product copy. Residual risk that the threat model already
records as a known gap is listed under Informational unless the
implementation is weaker than that document claims.

Severity uses impact × exploitability in a realistic deployment (signed-in
desktop, optional hosted runner and broker). A finding that requires a leaked
root secret, unlocked OS account, or XSS in the WebView is ranked below an
unauthenticated remote issue with the same blast radius.

This document does not include exploit proofs, payloads, or reproduction
procedures.

## Executive summary

The local product has a serious security posture for pre-release desktop
software: OS keyring custody, AES-256-GCM vaults with fail-closed key loss,
exact single-use execution permits, generation-fenced native computer leases,
script-free Markdown, SSRF pinning on `web-fetch` and remote MCP, and a
native-only path for hosted capabilities. Several of those controls are
stronger than typical agent-desktop designs.

No **unauthenticated remote Critical** issue was confirmed in this checkout.
The highest-priority gaps appear when optional cloud services are deployed,
or when a secret that is supposed to stay server-side leaks:

1. Hosted execution capabilities are HMAC-bound and generation-fenced, but the
   signed `nonce` is never consumed, so a stolen capability is reusable until
   expiry **while that computer remains ready at the signed generation**.
   Destroying the computer ends that window.
2. The hosted-runner root Bearer credential is a generation-unfenced superuser
   on process and browser routes, not only on provision/destroy.
3. The broker can run public HTTPS with in-memory OAuth state if the Worker is
   labeled `local`. **Closed:** unlabeled/`local` plus a public URL, and
   `memory` plus public HTTPS, now return 503.
4. Connector OAuth tokens, especially GitHub `repo`, are broader than the
   documented read-only GitHub surface.
5. Durable conversation tool arguments and results are re-fed to models without
   a persistence-time redaction boundary.

Local Windows computer-use, Stop, HWND reuse, screenshot custody, and
approval consume-once checks largely match the threat model. Full Access is
an explicit high-trust mode, not a silent bypass.

---

## Critical

**None confirmed** for an unauthenticated network attacker against the current
source, given:

- hosted runner and broker are deployment-gated and fail closed without secrets;
- Convex mutations require Clerk identity, membership, and device links;
- the desktop WebView has a production CSP that denies provider/secret egress
  (`connect-src` is IPC-only) and Markdown drops HTML tokens;
- native commands re-validate workspace, generation, and permits.

Two High findings become **Critical in practice** if their prerequisite secret
or misconfiguration is present. They are listed as High with that call-out
rather than as stand-alone Critical bugs in undeployed source.

---

## High

### H1 — Hosted execution capabilities are replayable while the signed generation stays ready

**Paths:**
`packages/protocol/src/domains/hosted-execution-capability.ts`,
`apps/hosted-runner/src/request-auth.ts`,
`apps/desktop/convex/hostedExecution.ts`

**What the code does.** Convex mints a 2-minute HMAC capability with a random
`nonce`, a single scope, and the computer's `generation`. The runner verifies
HMAC, computer id, scope, and time window. It never records or consumes the
nonce. `requestKey` idempotency on launch/navigate prevents *duplicate keys*,
not reuse of the same token with new keys.

**Scenario.** A capability token leaves the native process (crash dump, debug
log, compromised renderer that already has IPC, operator paste). Replay is
possible only while **all** of these hold: the token is unexpired, the
computer is still `ready` with `keep_alive`, and `generation` still matches
the value signed into the token.

`ComputerAuthority.destroy` increments generation, writes lifecycle
`destroying` then `destroyed` (or `degraded` on failure), clears keep-alive,
and destroys the sandbox. Process and browser capability routes then reject
the token: `requireCapabilityGeneration` and `requireReady` fail on
non-ready or mismatched generation. An unexpired `MivletCapability` does
**not** survive computer deletion.

While that original ready generation remains active, the holder can call the
scoped route repeatedly: many distinct `process:launch` jobs, repeated
`process:inspect` of stdout, or repeated `browser:act` with fresh request
keys. `requestKey` idempotency only collapses duplicate keys, not new keys
on the same token.

**Why it matters.** Architecture and comments describe capabilities as
short-lived, scoped, generation-fenced, and single-use. The first three are
implemented. Single-use is not. This is the highest-priority hosted-runner
gap for a deployed service.

**Mitigation direction.** Persist consumed nonces (or bind each mint to one
`requestKey`) in the computer Durable Object. Reject reuse. Keep TTL short.
Do not log or return tokens to the renderer (the native path already keeps
them in Rust; preserve that).

### H2 — Root Bearer is a generation-unfenced superuser on execution routes

**Paths:**
`apps/hosted-runner/src/request-auth.ts`,
`apps/hosted-runner/src/index.ts`,
`apps/hosted-runner/src/computer-authority.ts`

**What the code does.** `authorizeCapabilityRequest` returns `{ authorized: true }`
with no `expectedGeneration` when `Authorization: Bearer <root>` matches
`MIVLET_HOSTED_RUNNER_API_KEY`. `requireCapabilityGeneration(undefined)` is a
no-op. Lifecycle routes (PUT/GET/DELETE computer) already require the root
secret by design. Process and browser routes accept that same secret *and*
skip the generation fence.

**Scenario.** The root key leaks from Convex env, Wrangler secrets, CI, or a
log aggregator. The holder can provision, destroy, launch arbitrary `argv` in
the sandbox, inspect stdout, and drive the hosted browser on any valid
`computerId`, including after the user thought the node was rotated, as long
as they hit the current generation or use Bearer (which ignores generation).

**Why it matters.** A root secret is always high impact. The extra issue is
that execution routes do not force the scoped-capability path, so there is no
blast-radius split between “admin lifecycle” and “agent execution”. Desktop
and Convex correctly keep the root key off the renderer and mint
`MivletCapability` for tools. That client path is sound; the runner API is
wider than the protocol comments suggest.

**Prerequisite for Critical impact:** possession of the 32+ character root
secret.

**Mitigation direction.** Accept Bearer only on explicit admin routes
(ensure/status/destroy). Require `MivletCapability` plus generation on
`/processes/*` and `/browser/*`. Split provisioning vs execution secrets.
Rotate the root key on any suspected leak.

### H3 — Broker Worker can serve public OAuth with in-memory state if labeled local

**Paths:**
`apps/broker/src/worker.ts`,
`apps/broker/wrangler.jsonc`

**What the code does.** Defaults are `MIVLET_BROKER_ENVIRONMENT=local` and
`MIVLET_BROKER_STORAGE_BACKEND=memory`. Durable encrypted storage is required
only when environment is exactly `staging` or `production`. A Worker deployed
with the top-level vars (or `environment=local`) plus a public URL will run.
Memory stores are per-isolate: single-use pending/handoff is not coordinated
across isolates, and state dies on restart.

**Scenario.** An operator deploys the default Worker config to a public
`workers.dev` hostname, or forgets to select the `staging`/`production`
Wrangler env. OAuth authorize/callback/handoff then depends on whichever
isolate handled the request. Concurrent callbacks can miss pending state
(availability) or, worse, lose consume-once guarantees under isolate
concurrency.

**Why it matters.** The ADR requires durable encrypted storage for staging and
production. The fail-closed check is a string compare on a mutable label, not
on “am I reachable on the public Internet?”. Production env in
`wrangler.jsonc` is declared “for review only” and not to be deployed — that
comment is not a runtime control.

**Mitigation direction.** Refuse `memory` whenever `MIVLET_BROKER_PUBLIC_URL`
is HTTPS and not loopback. Treat unlabeled or `local` + public URL as 503.
Add a deploy gate that rejects non-durable public brokers. Keep the existing
durable encryption-key and DO-binding checks.

**Status.** Runtime gate in `apps/broker/src/worker.ts`: unlabeled/`local` plus
a public URL returns 503; `memory` plus public HTTPS returns 503. Staging and
production still require durable storage, encryption key, and DO bindings.

### H4 — GitHub OAuth token is full `repo` while the product surface is read-only

**Paths:**
`apps/broker/src/provider-profiles.ts` (`GITHUB_PROFILE.scopes`),
`apps/desktop/src-tauri/src/connectors.rs` (`GITHUB_SCOPES` labels `repo` as
`"read"`),
`packages/connectors/src/native-api/tools.ts` (GitHub tools are reads only),
`packages/connectors/src/providers/developer-connectors.test.ts` (writes
rejected)

**What the code does.** The broker requests `read:user`, `read:org`, and
`repo`. GitHub’s `repo` scope is full private-repository access, including
writes, webhooks, and collaborator administration — not a read-only grant.
The native GitHub connector enumerates only read capabilities and rejects
write tools. The catalog still describes `repo` as “Repositories, issues, and
pull requests” / `"read"`.

**Scenario.** The OS-stored GitHub token is stolen (malware, unlocked device,
future leak into a transcript). The thief has GitHub write power even though
Mivlet never exposed GitHub writes. Prompt injection cannot itself call
`issues.create` today, but the credential in the keyring is far more powerful
than the tool allowlist.

**Why it matters.** Least privilege is broken at the identity-provider
boundary. Connector writes for other apps correctly require fresh `once`
approvals; GitHub never needed `repo` write to serve the current tools.

**Mitigation direction.** Request the narrowest GitHub App / fine-grained
permissions that cover the read tools. If classic scopes remain, prefer
read-only repository scopes and drop `repo`. Stop labeling `repo` as read in
the catalog. Document that existing connections must re-authorize after a
scope cut.

Related over-scope (accepted residual, not a fake read-only Connect):
Vercel `deployment:write`, Linear `write`, and Slack `chat:write` /
`reactions:write` match native write actions and are **required on every
Connect**. Execution still needs a fresh exact approval. A stolen token is
write-capable by design; catalogs label these grants write. Linear
`issues:create` / `comments:create` were trimmed as create-only subsets of
`write`. See [native OAuth scopes](../product/connectors.md#native-oauth-scopes).
GitHub does not have that write surface.

### H5 — Durable tool arguments and results are not redacted before persistence or model replay

**Paths:**
`apps/desktop/src/lib/conversation-runtime.ts`,
`apps/desktop/src/hooks/useNativeAgent.ts`,
`apps/desktop/src/lib/agent-run-service.ts`,
`apps/hosted-runner/src/computer-authority.ts` (`inspect` stdout/stderr up to
256 KiB)

**What the code does.** `createDurableRunWriter` stores tool-call and
tool-result `content` in encrypted message revisions. Action-history and
connector-cache redaction exist, but the conversation persistence path does
not call `redactSecrets` / `redact_safe_detail` at append time. Later turns
rebuild model context from those records. Hosted process inspect attaches raw
stdout/stderr to the snapshot that becomes tool output.

**Scenario.** A connector read, MCP tool, `read-file`, or hosted `env`/`cat`
places a token, cookie, or password into tool output. That string is stored
for the thread lifetime and sent to the next provider request. Heuristic
redaction in other layers misses tokens that lack `sk-` / `Bearer` / `ghp_`
markers.

**Why it matters.** This is the main transcript-leakage channel that the
threat model’s “secrets never enter model context” invariant does not fully
enforce. Vault encryption protects the database at rest relative to the OS
keyring; it does not stop provider egress or future-turn replay.

**Mitigation direction.** Redact or summarize at the durable `record()`
boundary for tool-call and tool-result. Fail closed or truncate hosted
stdout that matches secret markers. Prefer structured “output omitted”
receipts for high-risk tools. Align TypeScript and Rust marker sets, but do
not treat regex as sufficient.

### H6 — Loopback OAuth handoff puts a redeemable ticket in the browser URL

**Paths:**
`apps/broker/src/broker.ts` (callback 302 sets `handoff` and `state`),
`apps/desktop/src-tauri/src/oauth_loopback.rs`,
`apps/desktop/src-tauri/src/connector_auth.rs`

**What the code does.** After the confidential token exchange, the broker
redirects the system browser to `http://127.0.0.1:<port>/callback?handoff=…&state=…`.
Redeem requires those two query values and is single-use with a short TTL.
There is no additional desktop-held proof (the desktop `code_challenge` is
required on authorize and then ignored; broker-owned PKCE is what binds the
provider exchange).

**Scenario.** Another local process, extension, or accessibility client
observes the callback URL or wins the loopback accept race and POSTs
`/oauth/{provider}/handoff` first. They receive the connector access and
refresh tokens. Mivlet then sees an already-used handoff.

**Why it matters.** This is a same-machine attacker, which the threat model
already treats as severe for unlocked devices. It is still a realistic
desktop threat (malware, hostile local server, shared Windows session) and is
sharper than necessary: both secrets needed to redeem are in the query
string.

**Mitigation direction.** Keep the ticket out of the query string (fragment,
or a POST from a loopback page that holds a pre-image). Bind redeem to a
desktop-only secret established at authorize (hash of a redeem nonce stored
in pending). Consume pending *and* require that nonce. Shorten TTL further.

### H7 — Hosted browser “public HTTPS” policy is hostname-only

**Paths:**
`apps/hosted-runner/src/contracts.ts` (`validatePublicHttpsUrl`,
`isPrivateHostname`),
`apps/hosted-runner/src/browser-authority.ts` (`guardPage`)

**What the code does.** Navigation and Playwright route guards reject
non-HTTPS, embedded credentials, hostnames without a dot, localhost aliases,
IPv4 literals in private ranges, and IPv6 literals (via `:`). They do **not**
resolve DNS and pin addresses. Desktop `web-fetch` and remote MCP *do* resolve
and reject forbidden IPs, then pin the answer set on the HTTP client.

**Scenario.** An attacker-controlled public hostname is authorized as a
browser target. At request time it resolves to link-local, RFC1918, or cloud
metadata. `guardPage` still sees a public hostname in the URL and continues
the route. Impact depends on what the Cloudflare Browser Rendering network
can reach; that is not proven in this repository.

**Why it matters.** The hosted-computer architecture claims private and
reserved destinations are rejected. The implementation matches that claim for
literal URLs, not for DNS rebinding. Local `web-fetch` already solved this
class of bug.

**Mitigation direction.** Resolve and deny forbidden IPs at navigate and on
each subrequest, or rely on a documented Browser Rendering network policy and
test it. Mirror `tools.rs` pinning where the runtime allows. Keep fragment
stripping and credential rejection.

---

## Medium

### M1 — Desktop `code_challenge` is required then discarded

**Paths:** `apps/broker/src/router.ts`, `apps/broker/src/broker.ts`,
`packages/connectors/src/providers/broker-contract.ts`

Authorize requires `code_challenge` with S256. `MivletBroker.authorize` never
stores or checks it. Provider PKCE is generated inside the broker for
GitHub/Vercel/Linear (`broker-pkce`). Notion and Slack use `pkce: "none"`.

The contract comment says the desktop challenge is carried to the provider so
the confidential exchange stays PKCE-bound. That is not what the broker does.

**Scenario.** No remote token theft by itself: handoff still needs state plus
ticket. The gap is a missing binding between the desktop that started
authorize and the desktop that redeems. Combined with H6, a local race does
not need a desktop-held verifier.

**Mitigation direction.** Either persist the challenge and require the
verifier on redeem, or remove `code_challenge` from the public contract and
document broker-only PKCE plus handoff/state. Prefer PKCE on Notion/Slack if
those providers accept it.

### M2 — Pending OAuth state can be overwritten (`INSERT OR REPLACE`)

**Paths:** `apps/broker/src/durable-stores.ts`, `apps/broker/src/stores.ts`

Create pending keyed by `state` / `state_hash` replaces an existing row.
Desktop generates high-entropy state, so collision is unlikely. If state is
ever weak, reused, or attacker-influenced, the stored redirect URI and
verifier can be swapped before callback.

**Mitigation direction.** Reject duplicate state. Enforce a minimum entropy
floor in the broker (durable hashing already expects 16–512 characters).

### M3 — Unauthenticated broker refresh and revoke

**Paths:** `apps/broker/src/router.ts`, `apps/broker/src/broker.ts`

`POST /oauth/{provider}/refresh` and `revoke` require the refresh/access
token in JSON, not a desktop attestation. That matches “desktop holds
tokens,” but a network-exposed broker becomes a rotation/revocation oracle at
60 requests/minute per peer (`CF-Connecting-IP`).

**Mitigation direction.** Place the broker only on Cloudflare with tight
WAF/rate limits; add device-bound proof for refresh; consider IP allowlists
as defense in depth, not as the control. Keep redacted logging
(`redactForLog`).

### M4 — Node broker defaults to `0.0.0.0` in production

**Path:** `apps/broker/src/server.ts`

`MIVLET_BROKER_HOST` defaults to all interfaces when `NODE_ENV=production`. A
bare Node deploy without a proxy exposes handoff/refresh.

**Mitigation direction.** Default to loopback; require an explicit opt-in to
bind publicly; terminate TLS in front.

### M5 — Hosted browser blocks sensitive *fills*, not all sensitive *clicks*

**Path:** `apps/hosted-runner/src/browser-authority.ts`

Observation omits password/OTP/payment-like controls from the list. `fill` on
password or matching autocomplete is rejected. `click` / `press` /
`download` are not re-checked against pay, WebAuthn, or confirm buttons that
remain visible.

**Scenario.** An approved `browser:act` clicks “Pay” or a WebAuthn control on
an otherwise public HTTPS page. Navigation stays on public HTTPS; money or
auth ceremony may still complete.

**Mitigation direction.** Extend the sensitive-control check to click/press.
Optional page-level heuristics for checkout and identity providers. Keep
human Live View for those steps.

### M6 — Hosted Live View URL and JPEG preview are renderer secrets

**Paths:**
`apps/hosted-runner/src/browser-authority.ts` (`liveViewUrl`,
`previewDataUrl`),
`apps/desktop/src/shell/ComputerInspector.tsx`,
`apps/desktop/src/components/agents/LiveWorkRail.tsx`,
`apps/desktop/src/lib/desktop-tool-runtime.ts` (`modelSafeBrowserObservation`)

Live View is a 5-minute `https://live.browser.run` URL with a `wss` query
secret. The model-facing tool string strips preview bytes and the URL (good).
The human UI keeps both in React state and opens Live View in a new window.

**Scenario.** XSS or a malicious extension with WebView access reads
`liveViewUrl` and takes over the hosted browser. Screenshots in inspector
state can show session content (email, MFA). Account switch destroys the
WebView (good); logging/sync of snapshots would be worse.

**Mitigation direction.** Treat snapshot/Live View as secret-adjacent: no
logs, no Convex, no exports. Shorten TTL. Prefer opening Live View through a
native command that does not leave the URL in React longer than needed.

### M7 — `write-file` confinement TOCTOU for not-yet-existing paths

**Path:** `apps/desktop/src-tauri/src/tools.rs` (`confine_path`)

Existing targets are canonicalized under the workspace root; symlink
components are rejected via `contains_symlink`. For a path that does not yet
exist, the last component is not canonicalized. A junction/symlink planted
between check and `create_dir_all` / write can redirect the create.

**Mitigation direction.** Open with `O_NOFOLLOW` / `CREATE_NEW` on the final
component, or write to a temp file in a known-safe directory and rename after
a final containment check (as artifact copies already attempt).

### M8 — Artifact “open in system app” residual TOCTOU

**Path:** `apps/desktop/src-tauri/src/local_computer/artifacts.rs`

Receipt verify → write launch copy → re-hash → `ShellExecuteW`. Replacement
between re-verify and the associated app’s path-based open remains. The code
documents this. Impact is launching a swapped document, not a Mivlet
sandbox escape.

**Mitigation direction.** Tighten ACLs on the launch copy; accept residual
risk for UX, or pass a handle to a helper.

### M9 — Message `detail_kind` is plaintext JSON; sealed `message.payload` is unused on read

**Path:** `apps/desktop/src-tauri/src/store/repos/message.rs`

Append seals `detail` into `message.payload` with AAD `message:{id}` (workspace
id ignored) and also writes `serde_json::to_string(detail)` to plaintext
`detail_kind`. `list` parses `detail` from `detail_kind` only. Revision
*content* (including tool output) is encrypted — H5 is about that content
leaving via providers, not about vault bypass.

Plaintext `detail_kind` still exposes tool names, call ids, approval ids, and
attachment metadata without the vault key. Encrypted-storage.md says query
columns should be enums/ids/fingerprints.

**Mitigation direction.** Store a short kind enum in `detail_kind`. Read
detail from sealed payload. Include `workspace_id` in message AAD.

### M10 — Backend credential reads fall through to an in-process HashMap

**Path:** `apps/desktop/src-tauri/src/backends.rs` (`CredentialStores::get`)

Writes require the OS keyring. Reads treat keyring errors like misses and
consult a process `HashMap` used for tests/headless. Production writes never
populate that map, so a broken keyring yields `needs-auth` (fail closed for
use). The seam remains: a future bug or test hook could serve keys that are
not OS-protected.

Keyring error strings can include platform detail (`{other}`).

**Mitigation direction.** Distinguish `NoEntry` from keyring `Err` and fail
closed in production. `cfg(test)` the HashMap. Generic user-facing errors.

### M11 — API keys are stored before live verification

**Paths:** `apps/desktop/src-tauri/src/backends.rs` (`store_credential_into`),
`apps/desktop/src/hooks/shell-runtime/useProviderConnections.ts`

Format validation and native credential shape checks run before `KeyringStore.set`.
HTTP verify happens afterward in the UI, which clears on failure. A crash in
the window leaves an unusable key in the OS store until the next connect.

**Mitigation direction.** Verify inside one Rust command before `set`, or
stage then promote.

### M12 — Connector cache `search_text` is plaintext derived from previews

**Path:** `apps/desktop/src-tauri/src/store/repos/connector_cache.rs`

Encrypted payload plus `looks_secret` redaction, then a plaintext search
column from title/provenance/`contentPreview`. Marker-free secrets in
previews become searchable without the vault key.

**Mitigation direction.** Hash/truncate the index; fail upsert if preview
still looks secret; keep redaction at write.

### M13 — Production CSP `frame-src https:` is broad; iframes are script-free

**Paths:** `apps/desktop/src-tauri/tauri.conf.json`,
`apps/desktop/src/components/navigation/PanelContent.tsx`,
`apps/desktop/src/components/conversation/MessageMarkdown.tsx`

Web previews use `<iframe sandbox="" referrerPolicy="no-referrer">` for
user-clicked HTTPS links. Empty `sandbox` disables scripts, forms, and
same-origin — this matches the product claim of script-free frames. Markdown
drops `html` tokens and sanitizes links. Production `connect-src` is
IPC-only.

Residual: any HTTPS origin can be framed (phishing, tracking pixels, click
jacking of the framed site). Combined with a future XSS, Tauri’s command
surface has no per-command ACL beyond “signed-in account”
(`account_session::guard`). That is standard Tauri; XSS is still high
impact (H-adjacent, listed here because current HTML surfaces are strict).

**Mitigation direction.** Keep script-free sandbox. Narrow `frame-src` if
product allows. Do not add `unsafe-inline` scripts. Longer term, capability
tokens per command class for credential write, export, and computer control.

### M14 — Custom provider HTTP loopback and OpenCode port race

**Paths:** `apps/desktop/src-tauri/src/native_api.rs`,
`apps/desktop/src-tauri/src/managed_runtime.rs` (`start_opencode_turn`)

Custom OpenAI-compatible URLs may use `http` only on loopback. OpenCode
binds `127.0.0.1` with a 32-byte password, but the code `bind((127.0.0.1,0))`,
drops the listener, then starts `opencode serve` on that port. A local
process can occupy the port in between; Mivlet would then send Basic auth to
whoever accepted.

**Mitigation direction.** Pass the bound socket or retry on bind failure.
Keep `--hostname=127.0.0.1` and high-entropy passwords. Explicit consent for
custom loopback endpoints.

### M15 — `requestExecutionCapability` authz lives on an internal query

**Path:** `apps/desktop/convex/hostedExecution.ts`

The public action delegates membership/device/role checks to
`authorizeExecutionCapability` (`internalQuery`). Today
`requireActiveDevice` still runs and throws without identity. Convex context
forwarding into internals is a footgun across versions.

**Mitigation direction.** Call `requireActiveDevice` at the start of the
action with `ctx.auth` as well. Integration-test the action HTTP API with
and without a Clerk token.

### M16 — Hosted process `argv` is length-bounded, not command-allowlisted

**Paths:** `apps/hosted-runner/src/contracts.ts` (`validateLaunchRequest`),
`apps/hosted-runner/src/computer-authority.ts` (`sandbox.exec`),
`apps/hosted-runner/Dockerfile`

Any argv list (≤128 args, ≤16 KiB each, cwd under `/workspace`) runs in the
Cloudflare sandbox image `docker.io/cloudflare/sandbox:next` (floating tag).
Container escape is the sandbox vendor’s threat model and is not auditable
from this repo. The unpinned `:next` tag is a supply-chain issue for any
deployed runner.

**Mitigation direction.** Pin the sandbox image digest. Keep dual approval
(source command + launch proposal) on the desktop. Document that hosted
shell is not a substitute for a hardened VM. Consider an argv allowlist for
the first production node.

### M17 — MCP poll frames reach the renderer unredacted

**Paths:** `apps/desktop/src-tauri/src/mcp_process/configuration.rs`
(`poll_remote_mcp_messages`),
`apps/desktop/src/runtime/domains/mcp.ts`

Remote MCP JSON frames are forwarded to JS. Argument validation rejects
credential-shaped *keys* at execute time; poll is a different path. A hostile
MCP server can put tokens into WebView memory.

**Mitigation direction.** Redact frames at the native boundary. Prefer
keeping sensitive MCP traffic renderer-free.

### M18 — Google desktop client secret may live in process environment

**Path:** `apps/desktop/src-tauri/src/connector_auth.rs`
(`MIVLET_GOOGLE_OAUTH_CLIENT_SECRET`)

Documented for some Google desktop clients; the secret is copied into the OS
store keyed by client id. Process env still increases crash-dump and child
inheritance risk versus a public PKCE client.

**Mitigation direction.** Prefer public PKCE where Google allows. Never put
the secret in React, Convex, or logs.

### M19 — Export and backup trust the user and the OS account

**Paths:** `apps/desktop/src-tauri/src/store.rs` (`export_local_data`,
`backup_local_data`),
`apps/desktop/src-tauri/src/memory.rs`

Exports are credential-free (`credentialsIncluded: false`) but contain
decrypted documents, prompts, and tool text (see H5). Memory export applies
`redact_export_value`. Backups are encrypted SQLite bound to the OS vault
key: theft on the same account is full workspace replay; cross-machine
restore without the key fails closed (good).

**Mitigation direction.** Export-time redaction pass; UI warning that exports
are secret-adjacent. Keep credentials out of backups.

### M20 — `stop_scope` drops pending selection without the global Stop revoke path

**Paths:** `apps/desktop/src-tauri/src/local_computer/control.rs`,
`apps/desktop/src-tauri/src/local_computer.rs`

Global `stop()` revokes and drains. `stop_scope` clears matching `pending`
without `revoke_and_drain_later()`. `local_computer_cancel` compensates when
generation still matches. A caller that only invoked `stop_scope` could
leave tickets live during window selection.

**Mitigation direction.** Revoke pending authority inside `stop_scope`, or
make it private to the cancel command.

### M21 — Clerk session keyring entry is not account-scoped by name

**Path:** `apps/desktop/src-tauri/src/clerk_identity.rs` (`SESSION_KEY` =
`clerk-session`)

Backend and vault keys use `account_session::credential_key()`. Clerk session
uses a fixed user name under `com.fable.workspace.identity.clerk`. Sequential
accounts on one OS user overwrite; sign-out clears. Residual if sign-out
fails.

**Mitigation direction.** Prefix with `account_binding` like other services.

### M22 — Heuristic redaction is inconsistent and incomplete

**Paths:**
`apps/desktop/src-tauri/src/store/repos/action_history.rs`,
`apps/desktop/src/lib/safe-output.ts`,
`packages/connectors/src/agent-runtime/utils/redact.ts`,
`apps/desktop/src-tauri/src/local_computer/desktop_tools.rs`
(`credential_shaped`)

Marker lists differ (`sk-` vs `github_pat_` vs `api_key=`). Password-field
UIA checks fail closed; arbitrary screen content cannot be classified
(already in the threat model).

**Mitigation direction.** One shared marker module; fail closed on unknown
secret-shaped persistence at write boundaries; keep the honesty that pixels
cannot be reliably classified.

### M23 — Convex auth config defaults to a mock Clerk issuer

**Paths:** `apps/desktop/convex/auth.config.ts`

**What the code does.**

```ts
domain: process.env.MIVLET_CLERK_ISSUER ?? "https://mock-clerk.mivlet.local",
applicationID: process.env.MIVLET_CLERK_AUDIENCE ?? "mivlet-convex-test"
```

Desktop Clerk setup *does* fail closed without `MIVLET_CLERK_ISSUER` and, in
production, without an explicit audience
(`apps/desktop/src-tauri/src/clerk_identity.rs`). Convex falls back to the
mock issuer/audience when those env vars are unset.

This is **not** a token-forgery or identity-bypass path. Convex still
verifies the JWT signature against the configured issuer’s JWKS.
`https://mock-clerk.mivlet.local` is not an attacker-controlled issuer or
JWKS endpoint. Omitting the env vars does not let someone authenticate by
minting a JWT that merely copies that issuer and audience.

**Scenario.** A Convex deployment is created without `MIVLET_CLERK_ISSUER` /
`MIVLET_CLERK_AUDIENCE`. Real Clerk tokens fail to authenticate because the
deployment is pointed at a non-existent mock issuer (availability /
misconfiguration). Local tests that rely on the mock stay coupled to the
same config file used for deploy. A JWT that is not signed by that issuer’s
JWKS is rejected before membership or device checks run.

**Why it matters.** Hosted identity is the root of workspace, device, and
capability minting. A mock fallback belongs in test-only config, not in
deployed `auth.config.ts`. The right control is still fail-closed when
issuer/audience are unset; the impact is an operator footgun, not an
unauthenticated bypass.

**Mitigation direction.** Fail Convex auth configuration when issuer/audience
are unset. Keep mock values in test-only config. Add a deploy check that
rejects the mock domain.

---

## Low

### L1 — Broker and hosted-runner observability sample 100% of logs

**Paths:** `apps/broker/wrangler.jsonc`, `apps/hosted-runner/wrangler.jsonc`,
`apps/hosted-runner/src/index.ts`

Request route, method, duration, and error *codes* are logged; bodies and
tokens are not. Sinks must still be access-controlled. Broker `redactForLog`
is the right pattern.

### L2 — Unauthenticated `/health` on the hosted runner

**Path:** `apps/hosted-runner/src/index.ts`

Returns `{ status: "ok", service: "mivlet-hosted-runner" }`. Minimal
disclosure. Fine for probes; do not expand.

### L3 — Rate limit 60/min; health unbounded; peer from `CF-Connecting-IP`

**Paths:** `apps/broker/src/rate-limiter.ts`, `apps/broker/src/router.ts`,
`apps/broker/src/worker.ts`

Durable limiter is shared across isolates; memory limiter is not (see H3).
Handoff tickets are 256-bit; brute force is not the concern. Refresh
enumeration is (M3). Off-Cloudflare Node must not trust spoofable peer
headers.

### L4 — Hosted Bearer compare hashes with `timingSafeEqual` and fails closed if missing

**Path:** `apps/hosted-runner/src/request-auth.ts`

SHA-256 of both values, then `crypto.subtle.timingSafeEqual`. If that API is
absent, authorization returns false (fail closed, service down). Prefer
comparing the raw secret in constant time where the runtime allows; hashing
first is acceptable.

### L5 — Capability clock skew window is 30 seconds

**Path:** `packages/protocol/src/domains/hosted-execution-capability.ts`

`now < issuedAt - 30_000` allows slight future skew. Combined with H1 this
slightly widens replay. Keep small.

### L6 — Hosted computer ids are deterministic FNV-1a of workspace and agent

**Path:** `apps/desktop/convex/hostedExecutionPolicy.ts`

Ids are naming, not authorization (comment is correct). Knowing workspace and
agent ids predicts `computerId`. Attackers still need Bearer or a capability.
Do not treat the id as a secret.

### L7 — OpenCode / hosted-runner prototypes must not share production secrets

**Path:** `apps/hosted-runner/prototypes/opencode/`

Separate Workerd fixture with synthetic data. Keep it unwired from production
`wrangler.jsonc` (currently true).

### L8 — Dev CSP is intentionally weaker

**Path:** `apps/desktop/src-tauri/tauri.dev.conf.json`

`unsafe-eval` and wider `connect-src` for Vite. Production tests in
`tauri-csp.test.ts` enforce the tight policy. Do not ship the dev config.

### L9 — Fixtures use obvious fake secrets

Tests use `sk-FAKESECRET…`, `ghp_…` placeholders. Not production credentials.
Keep scanners and “credentials never in fixtures” policy.

### L10 — Keyring / vault error copy and legacy Fable identifiers vs Mivlet naming

Widespread `com.fable.*` keyring services, `MIVLET_*` env, `MivletCapability`,
`mivlet-auth-broker`. No weaker parallel “legacy Fable” auth route was found;
Clerk org keys are rejected. Renaming is operational hygiene, not a bypass.
Do not break keyring services without a migration.

### L11 — Collaboration records and sync allowlists

`collaboration_record` AAD includes workspace/owner/kind/id. Comments exclude
credentials, approval grants, and computer leases from those rows and from
remote sync. Cloud mutation outbox payloads are sealed. Residual: any future
sync mapper must keep that allowlist; remote sync is not claimed E2E
encrypted (threat model).

### L12 — Voice audio crosses IPC with bounds; transcripts can contain spoken secrets

Native voice keeps provider credentials in Rust. User-spoken secrets in
captions are a product/behavior issue, not a custody bug.

### L13 — Diagnostics are count-only

`apps/desktop/src-tauri/src/diagnostics.rs` does not decrypt payloads. Keep it
that way for support bundles.

### L14 — rustls was recently patched; rustsec exception remains for `quick-xml`

`04cb8a16` updates rustls to 0.23.45. `docs/security/rustsec-policy.md`
documents a reachability exception for `quick-xml` via notifications until
2026-10-31. That exception is reviewed in-gate; it is not a product network
parser.

---

## Informational (by design or already in the threat model)

### I1 — Full Access auto-resolves exact approvals, including confirmation phrases

**Paths:**
`apps/desktop/src/hooks/shell-runtime/useWorkspaceApprovals.ts`,
`apps/desktop/src-tauri/src/approvals.rs`

Full Access calls `resolveApprovalDecision` with the request’s own
`confirmationPhrase` and `automatic: true`. Rust still requires the phrase to
match and still consume-once at dispatch. This is the documented high-trust
mode (“Work Freely”), not a bypass of the persist layer. Background native
input still cannot silently become foreground; Full Access does not add app
grants.

Residual product risk: users may not grasp that Full Access pre-authorizes
MCP critical tools, hosted browser, and local desktop actions. Keep UI
warnings. Optional: still require typed confirm for `critical`.

### I2 — Native Windows computer use shares the interactive session

Matches [docs/architecture/local-teammate-computer.md](../architecture/local-teammate-computer.md)
and the threat model. Controls verified in source: driver hash pin, cleared
environment, kill-on-close job, delivery mode forced from the grant, HWND
identity plus native marker, password-field fail-closed, screenshot custody in
Rust, 30-minute / 5-minute idle lease, 30-second single-use observations, Stop
independent of React, generation bump on restart without restoring a lease, no
host-shell tool, no lease persist in `native-control.json`.

This is an authorization boundary, not an application sandbox. Permitted apps
keep their own filesystem and network. Already-dispatched input cannot be
undone.

### I3 — Renderer XSS implies native IPC

Tauri commands after sign-in include `store_backend_credential`, backups,
exports, tool execution, MCP, and computer control. Guard is account-session
continuity only. Current Markdown and iframe hardening make XSS hard, not
impossible. Defense in depth is M13.

### I4 — No signed updater or public release channel

Known gap. Supply chain for updates is unset. CUA driver preparation verifies
Authenticode and hashes at resource install; native start verifies the
executable hash again.

### I5 — Stolen unlocked OS account

Vault key and credentials are in that user’s keyring. Mivlet is not a
substitute for disk encryption and OS account security.

### I6 — Hosted sign-in, metering, abuse, DR, multi-device recovery

Not live-validated. Incomplete hosted configuration fails closed
(`runner-configuration-required`, Worker 401 if root secret missing or short).

### I7 — Token plugins are a closed, read-only native list

`apps/desktop/src-tauri/src/token_plugins.rs` `IDS` is closed. Credentials
omit `Debug`. Manual token paste into the OS store; no writes or knowledge
sync. Renewal is the user’s problem; stolen plugin tokens have provider-side
blast radius.

### I8 — MCP stdio is user-approved local command execution

Configuration requires a fresh one-time approval and fingerprint match. After
that, the command is a local process Mivlet spawns. That is the feature.
Unknown tools stay behind exact approval; official read tools may skip consume
only on a curated list.

### I9 — Provider-owned ACP/SDK routes mediate yes/no through Mivlet approvals

Claude, Cursor, Grok, Antigravity, and OpenCode: consequential permissions
are supposed to hit the same exact-approval boundary. Screenshot delivery is
unavailable on those routes until a native tool-result/image bridge exists
(fail closed; vision metadata is not enough).

**Codex is not in that unavailable set.** The Codex app-server route has a
native screenshot bridge: `codex_app_server.rs` enables visual desktop tools
for models that advertise image input and implements `claim_desktop_tool`
(dynamic-tool claim, then native `inputImage` response).
`packages/connectors/src/native-api/computer-vision.ts` treats
`backendType === "codex-app-server"` as a shared computer-tool route and
returns available when `model.capabilities.vision === true`. Screenshot
control still fails closed when the current Codex catalogue model has not
advertised image input.

---

## Fail-closed inventory (verified)

| Prerequisite | Behavior |
| --- | --- |
| Vault DB exists, OS key missing | Refuse to re-key (`store/keys.rs` `resolve_for_database`) |
| Schema newer than binary / FK / corruption | Startup fails |
| Provider credential missing | No native egress (`require_key`) |
| Custom provider non-loopback HTTP | Rejected |
| CUA hash mismatch / missing Stop / missing input hooks | No grant |
| Hosted runner URL/key missing or key &lt; 32 chars | Convex throws `runner-configuration-required`; runner 401 |
| Hosted runner URL not public HTTPS origin | Desktop and Convex reject |
| Broker durable mode missing DO bindings or encryption key | Worker 503 `configuration-required` |
| Broker staging/production + memory | Worker 503 |
| Broker `local`/unlabeled + public URL, or `memory` + public HTTPS | Worker 503 `configuration-required` |
| Clerk issuer missing on desktop | Identity configuration-required |
| Clerk production audience missing | Configuration-required |
| Remote MCP private IP / DNS to private | Rejected; HTTP client pins resolved addrs; no redirects |
| `web-fetch` private/link-local/metadata / DNS rebinding | Rejected and pinned |
| Desktop `run-shell` | Hard error; hosted path only |
| Unknown model / unaudited vision | Screenshot delivery unavailable (Codex app-server and audited OpenAI/Anthropic/xAI routes are the exceptions when the model advertises vision) |
| Approval fingerprint change, replay, TTL, interrupt | Consume fails |
| Connector writes with `session`/`rule` | Rejected |
| Password UIA / credential-shaped observe | Observation refused |
| Background screenshot | Disabled (desktop-crop fallback risk) |

Gaps in this table are H1 (nonce while the signed generation stays ready),
H2 (Bearer generation skip on execution routes),
H7 (hosted-browser DNS), and M23 (Convex mock issuer as a deploy footgun,
not an identity bypass). H3 (local+public memory) is now a Worker 503.

---

## Positive controls to preserve

Do not regress these without a replacement:

- OS keyring split: backend keys, connector tokens, vault master, Clerk
  session, MCP OAuth JSON; vault key never silently replaced.
- AES-256-GCM with fresh 96-bit nonces and row AAD; tests for swap/tamper.
- Execution permits: SHA-256 of the full `ApprovalRequest`, consume-once,
  15-minute TTL, invalidate on interrupt; computer tools bind workspace /
  agent / generation.
- Hosted capabilities minted only from Rust `call_convex`, never designed as
  a React Convex client (`apps/desktop/src` has no `ConvexReactClient`).
- Native screenshot sessions: renderer sees opaque ids; PNG held in Rust;
  generation, window identity, observation, privacy, and foreground rechecked
  at capture and before egress; one screenshot per provider response. Codex
  app-server uses `claim_desktop_tool` for vision-capable models; audited
  direct OpenAI/Anthropic/xAI routes have a separate native image bridge.
  Other provider-owned ACP/SDK routes do not.
- CUA: hash pin, deny-write handle, cleared env, method allowlist, delivery
  forced from grant, Stop on a native thread, generation bump on load.
- Markdown: no HTML, images as text, `safeConversationLink`, depth cap.
- Web preview: `sandbox=""`, `noreferrer`, HTTPS only.
- Production CSP tests: no `unsafe-eval`, no wildcard `connect-src`.
- Broker: consume-once pending and handoff, redirect allowlist, duplicate
  callback param rejection, identity from provider identity endpoint, store
  encryption HKDF+AES-GCM+AAD, no tokens in logs.
- Account process: one binding, watchdog restart, WebView destroy, computer
  shutdown, no retarget of credential namespace after admit.
- Embedded OpenCode host: `:memory:` DB, no credential in child, bun dotenv
  autoload disabled (encrypted-storage.md).
- Managed runtimes strip ambient vendor API keys before spawn.
- ZIP import: no `..`, no symlinks, size caps, `create_new`.
- Office generate/validate/publish split; formula allowlist.

---

## Suggested verification (negative tests, not exploits)

When these areas change, add or extend tests that:

- Replay the same `MivletCapability` token with a new `requestKey` after first
  success and expect rejection once nonce consumption exists.
- Call process/browser routes with root Bearer and expect 401 if H2 is fixed.
- Boot a Worker with `MIVLET_BROKER_ENVIRONMENT=local`, memory backend, and an
  HTTPS public URL; expect 503 (`apps/broker/src/worker.test.ts`).
- Persist a tool result containing a non-`sk-` secret and assert it is not in
  the next provider payload.
- Authorize GitHub and assert requested scopes no longer include write-capable
  `repo` if H4 is fixed.
- Navigate the hosted browser to a public name that resolves to a forbidden
  IP and expect abort (once H7 is fixed).
- Keep existing replay, TTL, HWND, Stop, CSP, and MCP argument tests.

Do not weaken those assertions to pass a suite.

---

## Mapping to the existing threat model

| Threat-model claim | Review result |
| --- | --- |
| Secrets never enter React / transcripts / logs | Mostly true for credentials; **false for tool output replay (H5)** and Live View URLs in React (M6) |
| Exact single-use approval at final boundary | True for native permits; Full Access is explicit; hosted capability nonce is **not** single-use (H1) |
| Hosted capabilities generation-fenced and single-use | Generation-fenced on `MivletCapability`; **not** on root Bearer (H2); **not** single-use (H1) |
| Undeployed hosted config stays unavailable | True on desktop/Convex missing secrets |
| Broker stores no conversation or provider API keys | True; it does store connector client secrets and briefly holds user tokens |
| Fixture ≠ live evidence | Still true; this review is source analysis only |
| Known gaps (updater, E2E sync, unlocked device, native app sandbox) | Unchanged; listed under Informational |

---

## Priority order for future work

1. Consume hosted capability nonces (H1) and stop treating root Bearer as an
   execution credential (H2).
2. Fail closed on public broker + memory (H3) — Worker 503 on unlabeled/`local`
   plus a public URL, and on `memory` plus public HTTPS.
3. Cut GitHub OAuth to read-only power (H4).
4. Redact tool I/O at the durable conversation boundary (H5).
5. Bind desktop redeem (H6 / M1) and pin hosted-browser DNS (H7).
6. Then the Medium backlog: Convex mock-issuer deploy guard (M23), TOCTOU,
   CSP frames, Live View custody, argv pinning, MCP frame redaction.

No application code was modified for this review.
