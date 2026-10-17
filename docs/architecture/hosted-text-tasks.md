# Hosted text tasks

An explicitly selected, queued root Work item can run one text request on the
task Worker. This is separate from the [hosted computer](hosted-teammate-computer.md)
and the awake-desktop [phone view](mcp-server.md#phone-and-web-view). It grants no
computer, browser, connector, repository, file or shell tools. Ordinary local
conversations do not move to the cloud automatically.

## Native ownership and consent

Native preparation holds the queued item and advances its generation before any
network wait. The review shows the exact agent instructions and user request,
provider, model, destination, limits and retention. Canonical conversation
history, captured context and attachments are not silently added. Secret-shaped
content and local paths are rejected. The user approves this exact text once
through the existing native approval system; session-wide approvals cannot
authorize a later cloud request.

Before admission, native persists an execution attempt, immutable request binding
and outbox in the existing encrypted store, then assigns the Work item to the
hosted owner. Local dispatch, continuation and app-close cleanup must respect
that ownership. A Work-specific dispatch gate closes the interval between
requesting a capability and sending admission: Stop invalidates the gate before
its canonical transaction commits. No Store operation runs while the identity
or dispatch lock is held.

An uncertain admission never causes an automatic resend or local fallback.
Status reads may reconcile it. Native validates the exact cloud binding,
generation, sequence, result length and SHA-256, then rechecks the current Work,
conversation generation, branch head and authority before appending the result
and finishing the canonical execution attempt. A changed head or reduced
authority retains the authenticated result for review instead of overwriting
the conversation. Account changes reject late responses.

Closing the app leaves admitted cloud work running. Explicit Work or project
Stop immediately fences local writes, persists `stop-pending` and wakes native
cancellation. The Worker persists cancellation before aborting an active fetch;
late results cannot commit through the cancelled generation. A network partition
can delay remote acknowledgement, and an upstream provider may already have
accepted a billable request. Sign-out preserves the local fence but cannot make
authenticated cancellation calls after its credentials are cleared. The UI must
retain this uncertainty rather than claim the provider stopped instantly.

## Authentication and credentials

The native-only Convex `/native/task-capability` endpoint verifies the Clerk
identity, active device, workspace membership and editor-or-higher role. It
rejects browser-origin requests and consumes the existing per-subject and
per-device mint limits. The signed capability binds the server's account ID,
workspace, agent, device, exact operation/resource and request SHA-256, with a
single-use nonce and a maximum 120-second lifetime.

The Worker accepts only `MivletTask` capabilities in the separate `mt1` signing
domain. Computer Bearer credentials and computer execution capabilities grant
no task access. Every operation rechecks the exact scope and body. Enrollment
binds its metadata; the separately entered API key travels directly from native
to the pinned Worker over HTTPS and never through Convex.

Cloud provider connections are explicit and agent-scoped. The existing native
protected-input window collects a separate API key with masked entry and capture
exclusion. Local provider keys, CLI sessions and OAuth credentials are never
exported. Cloud custody encrypts each key using AES-GCM with account, workspace,
agent, credential ID, provider and revision as authenticated data. The encryption
key is distinct from the capability signing key. No credential-reading RPC is
exposed; replacement, revocation and expiry are checked again before dispatch.
Keys expire after 30 days or can be explicitly revoked sooner.

## Worker execution and retention

`apps/hosted-runner/wrangler.tasks.jsonc` deploys only `TaskAuthority` and
`ProviderCustody` SQLite Durable Objects. Its generated bindings and TypeScript
configuration are separate from the container/browser deployment. It needs no
Container, Sandbox or Browser Rendering binding. Request and provider bodies are
not logged.

Supported text adapters are OpenAI, Anthropic, Gemini, xAI and DeepSeek. The
Worker reuses the shared request shapers and agent loop with tools disabled and
one model call. Endpoints are fixed HTTPS provider URLs, redirects are rejected,
and there is no automatic fetch retry. A real protocol terminator is required;
truncated streams and recovered in-flight sends remain uncertain. A persisted
dispatch flag prevents a recovered alarm from repeating a possibly billed send.
Generic price estimates are not represented as known billed cost.

The request permits at most 4,096 output tokens, 120 seconds and 65,536 bytes each
for input and result. Account storage admits at most two active tasks, 20 new
tasks per day, 40 retained tasks and eight cloud credentials. Task text and input
expire after 24 hours. The receipt remains for seven more days, then the object
uses `deleteAll` to reclaim its SQLite storage. Repeated expiry does not change
the receipt generation. Custody prunes expired credentials, reservations,
capability nonces and daily counters, and removes empty object storage.

## Deployment and evidence

On October 17, 2026, the text-only Worker was deployed to the existing Cloudflare
account at `https://mivlet-hosted-tasks.joshhknott.workers.dev`. Two independently
generated secrets were configured through deployment-secret APIs; their local
recovery copy is protected by Windows DPAPI, outside the repository. No provider
API key was supplied or model call made by this deployment check.

The existing Convex project retains its legacy name, `fable`. The persistent
development deployment `chatty-roadrunner-66` contains the account functions and
native capability endpoint, with the existing Clerk issuer/audience and the
separate task signing key and URL. Its expiry was cleared through the supported
management API and verified without changing any other deployment metadata.
It remains a development deployment. Its generated bindings
were produced by the Convex CLI. The eager auth configuration was also verified
by an actual function deployment; mock-auth restrictions remain in place.

Local verification passed protocol compatibility/spine checks, connector and
the Worker builds, 100 Worker unit tests including the phone relay, and deployment dry runs.
Live checks exercised service health, a real SQLite Durable Object scoped read,
missing/wrong/expired capability rejection, exact body hashing, single-use nonce
replay rejection and an absent-task response. The Convex endpoint rejected
unauthenticated and browser-origin requests with `no-store` responses.

These observations do not establish a signed-in native admission, a real
provider completion, physical-phone access, a persistent production Convex
deployment, or hosted computer/browser operation. Native and browser acceptance
must be recorded separately before expanding those claims. Reproducible evidence
from this run is under the ignored integration `output/` directory; no task text,
keys or capability tokens belong in deployment logs or repository artifacts.
