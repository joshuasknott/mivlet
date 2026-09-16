# Threat model

Mivlet is a pre-release local-first desktop application. This model covers the
reachable local product plus the repository's optional broker, account/sync,
and hosted-computer foundations. It does not assert that any remote environment
has been deployed or independently reviewed.

## Protected assets

- model-provider, connector, identity-session, and vault credentials;
- conversation, knowledge, memory, Connection, approval, and audit data;
- exact approval permits and request fingerprints;
- agent workspace files, selected Windows applications, and preserved legacy volumes;
- optional remote membership, device, capability, and hosted-computer state;
- release artifacts and update metadata.

## Trust boundaries

- React/WebView to typed Tauri commands;
- Rust to encrypted SQLite and the operating-system credential store;
- Rust to model providers, connector providers, installed runtimes, Cua Driver, and
  optional remote services;
- native permission to background or foreground input in the user's Windows session;
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
credentials, host paths, raw window/driver handles, browser-debug URLs, cookies, or process
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
PKCE (public Google and desktop↔broker S256, plus broker-owned PKCE where the
provider documents it), exact callback state, and isolated credential custody.
The broker handles only confidential connector authorization and stores no
conversation or provider secrets.

### Prompt injection and unsafe effects

Retrieved files, connector results, websites, and model output cannot grant
authority. Tools use strict schemas and bounds. The approval record binds the
exact proposed effect and is rechecked immediately before dispatch. Replayed or
stale permits, changed browser controls, unknown tools, and scope changes fail.

### Native application control

The bundled driver operates one exactly selected Windows window. The existing
global policy authorizes each tool; Full Access still uses the same exact
single-use permit. High-risk minting requires a native OS confirm; WebView
cannot mint by echoing a confirmation phrase. There is no separate app grant. Native authority binds workspace, agent, request,
generation, process identity and a native window
marker. The driver receives a bounded manifest and a cleared environment, and
runs in an owned kill-on-close job. No shell, registry, arbitrary driver method,
daemon or network endpoint is exposed by this integration.

This shares the user's session and is not an application sandbox. A permitted
app can use its own file and network access. Foreground focus loss, background
target takeover, dialogs, closure,
replaced handles, stale observations and runtime failure revoke input authority.
Password-field checks fail closed, but arbitrary private screen content cannot
be reliably classified. Choose non-sensitive windows and complete private steps
without agent control. Workspace file tools remain separately path-confined.

### Human/agent control collision

An authorized selection binds its background/foreground delivery mode to one
window lease with 30-minute maximum and five-minute
idle expiry. A native activity window and Ctrl+Alt+Esc revoke it independently of
React and driver response locks. Stop invalidates queued work and terminates the
owned runtime. Already dispatched Windows input cannot be undone. Observations
are single-use, expire after 30 seconds and reject changed window dimensions.
Restart/reconnect never restore a lease and unknown inputs are not retried.
Stop invalidates the turn generation: a stopped turn cannot reselect and resume.
Background selection does not activate its target. Physical input into that
window or its becoming foreground revokes the lease; other apps remain usable.
Foreground selection requires a new exact approval and fresh observation.
Background preflight refusals send no input, while runtime errors are treated as
uncertain and never silently retried or escalated. Background screenshots are
disabled because the pinned capture path can fall back to a desktop crop and
does not expose enough provenance to exclude covering windows. Stop during
background input fences new leases until the killed driver's temporary window
flags are restored, after process exit and only on the same window identity.

### Optional account, sync, and hosted boundaries

Local use remains available without them. Any deployed remote entry point must
derive identity server-side, verify current workspace membership and device
state, scope data before access, and reject cached client authority. Sync must
use explicit record allowlists and exclude credentials, permits, browser
profiles, container state, raw connector caches, and host paths.

Hosted capabilities are short-lived, scoped, generation-fenced, and single-use.
The runner independently validates the capability and public-network policy.
Service Bearer credentials cannot launch process or browser effects. HMAC
signing uses a distinct secret from the lifecycle Bearer. Undeployed or
incomplete configuration must remain unavailable rather than falling back to a
fixture.

Convex auth refuses the test mock Clerk issuer unless
`MIVLET_CLERK_ALLOW_MOCK=1` (legacy `FABLE_CLERK_ALLOW_MOCK`). That pair is
local/dev only: `anonymous:` and `dev:` Convex backends and in-memory tests may
use it. Production, preview, and staging deployments fail closed at config
load. CI runs `node scripts/ci/refuse-mock-clerk.mjs`, which rejects the same
pair in GitHub Actions env and in tracked env/workflow/wrangler files.

### Supply chain and release

Lockfiles, dependency audits, Rust advisory policy, typed builds, CSP tests,
desktop manifests, and installer smoke tests reduce risk but do not replace
artifact signing, update-channel security, reproducible builds, or independent
review. Generated output and credentials must stay out of commits.

## Known gaps

- No public signed release or updater channel is complete.
- Native app allowlisting does not constrain the app's own filesystem or network
  capabilities. No production vulnerability-response process is complete.
- Hosted sign-in/secret handoff, production account recovery, multi-device
  authorization, metering, abuse controls, and disaster recovery are not live-
  validated.
- Remote sync is not claimed to be end-to-end encrypted.
- A stolen unlocked device or compromised operating-system account can access
  data available to that user; Mivlet is not a replacement for full-disk
  encryption and OS account security.

Security-sensitive changes require negative scope/replay tests, secret scans,
the relevant TypeScript and Rust gates, and runtime evidence proportional to the
boundary changed.
