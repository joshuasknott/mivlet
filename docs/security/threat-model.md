# Threat model

Fable is a pre-release local-first desktop application. This model covers the
reachable local product plus the repository's optional broker, account/sync,
and hosted-computer foundations. It does not assert that any remote environment
has been deployed or independently reviewed.

## Protected assets

- model-provider, connector, identity-session, and vault credentials;
- conversation, knowledge, memory, Connection, approval, and audit data;
- exact approval permits and request fingerprints;
- teammate workspace files, persistent Linux home volumes, and browser profiles;
- optional remote membership, device, capability, and hosted-computer state;
- release artifacts and update metadata.

## Trust boundaries

- React/WebView to typed Tauri commands;
- Rust to encrypted SQLite and the operating-system credential store;
- Rust to model providers, connector providers, installed runtimes, Docker, and
  optional remote services;
- the host to each Docker-backed Linux teammate computer;
- Convex to the deployment-gated hosted runner;
- the desktop to the narrow confidential connector OAuth broker; and
- build inputs to packaged desktop and service artifacts.

## Core invariants

1. Secrets never enter ordinary React state, model context, logs, screenshots,
   local exports, fixtures, or portable records.
2. Every user-owned read or write starts with an explicit validated workspace;
   no missing scope falls back to another workspace.
3. External content, retrieved knowledge, web controls, and tool output are
   untrusted input, not instructions or authority.
4. Consequential effects require an exact, fresh, single-use approval checked
   at the final trusted boundary.
5. Local and hosted computer placement is explicit. One must never silently
   substitute for the other or for the user's host shell.
6. Fixture, build, dry-run, and local test evidence stays distinguishable from
   live deployment evidence.

## Principal risks and controls

### Renderer compromise or confused IPC

The renderer receives capability metadata and bounded display projections, not
credentials, host paths, Docker names, browser-debug URLs, cookies, or process
handles. Tauri commands validate identifiers, sizes, scope, generation, and
ownership again. The production content-security policy denies direct provider
and secret-service egress from the WebView.

### Local data disclosure or tampering

Sensitive SQLite payloads use AES-256-GCM with fresh nonces and row-bound AAD.
The vault key and integration credentials use separate credential-store
services. Startup performs integrity and foreign-key checks and fails closed on
a newer schema. Backups validate their manifest and vault marker before restore.
Plaintext query columns must remain non-secret.

### Provider and connector egress

Rust owns credential injection, endpoint allowlists, HTTPS policy, timeouts, and
bounded responses. Remote custom-provider HTTP is rejected; loopback is the
only plaintext exception. Connector OAuth uses system-browser authorization,
PKCE where applicable, exact callback state, and isolated credential custody.
The broker handles only confidential connector authorization and stores no
waitlist, conversation, or provider secrets.

### Prompt injection and unsafe effects

Retrieved files, connector results, websites, and model output cannot grant
authority. Tools use strict schemas and bounds. The approval record binds the
exact proposed effect and is rechecked immediately before dispatch. Replayed or
stale permits, changed browser controls, unknown tools, and scope changes fail.

### Local teammate computer escape

Each workspace/teammate gets one labelled Docker container, persistent home
volume, and narrow Fable-owned workspace bind. Commands run as UID 1000 with
timeouts and bounded output. Chromium keeps its sandbox; the debug bridge is
published only on host loopback. Container resources are capped and native code
validates labels before lifecycle actions.

Docker daemon access is privileged, containers share the Docker Linux kernel,
default container networking remains available, and the scoped bind is writable
when authorized. This is stronger separation than a browser profile or host
directory alone, but it is not a dedicated VM or a hostile-code guarantee.

### Human/agent control collision

Takeover creates a five-minute lease and advances the computer generation.
Pointer, key, browser, and return-control actions cite the current generation.
Agent browser actions fail while the human holds control, and observed control
references are single-use and invalidated by state changes.

### Optional account, sync, and hosted boundaries

Local use remains available without them. Any deployed remote entry point must
derive identity server-side, verify current workspace membership and device
state, scope data before access, and reject cached client authority. Sync must
use explicit record allowlists and exclude credentials, permits, browser
profiles, container state, raw connector caches, and host paths.

Hosted capabilities are short-lived, scoped, generation-fenced, and single-use.
The runner independently validates the capability and public-network policy.
Undeployed or incomplete configuration must remain unavailable rather than
falling back to a fixture.

### Supply chain and release

Lockfiles, dependency audits, Rust advisory policy, typed builds, CSP tests,
desktop manifests, and installer smoke tests reduce risk but do not replace
artifact signing, update-channel security, reproducible builds, or independent
review. Generated output and credentials must stay out of commits.

## Known gaps

- No public signed release or updater channel is complete.
- No per-container network allowlist, image-signing policy, or production
  vulnerability-response process is complete.
- Hosted sign-in/secret handoff, production account recovery, multi-device
  authorization, metering, abuse controls, and disaster recovery are not live-
  validated.
- Remote sync is not claimed to be end-to-end encrypted.
- A stolen unlocked device or compromised operating-system account can access
  data available to that user; Fable is not a replacement for full-disk
  encryption and OS account security.

Security-sensitive changes require negative scope/replay tests, secret scans,
the relevant TypeScript and Rust gates, and runtime evidence proportional to the
boundary changed.
