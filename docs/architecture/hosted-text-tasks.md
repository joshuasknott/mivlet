# Hosted text tasks

An explicitly selected, queued root Work item can run one text request on the
task Worker. This is separate from the [hosted computer](hosted-teammate-computer.md)
and the awake-desktop [phone view](mcp-server.md#phone-and-web-view). It grants no
computer, browser, connector, repository, file or shell tools. Ordinary local
conversations do not move to the cloud automatically. The separately reviewed
public web research mode below extends this task path with bounded public reads.

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

## Public web research

The explicit `public-web-research` mode uses a v2 admission. Native captures
the agent instructions, fixed research policy, request, exact allowed DNS hosts
and starting URLs in the complete one-use review. The browser UI derives hosts
from up to four entered public HTTPS pages; neither redirects nor model-chosen
links may widen that scope. URLs and query strings may derive from the reviewed
request and are disclosed as external data. No local context, cookies, app
connections, credential headers, authenticated pages or browser input is added.

The shared provider loop advertises only `web-fetch`, and requires an existing
catalogue entry that explicitly supports tools. Each model call and page read
commits its digest and budget allocation before egress. The limits are four model
calls, six reads, 4,096 total requested output tokens (at most 1,024 per call),
120 seconds, 16 KiB per page and 64 KiB total source text. Recovered or uncertain
provider sends are never replayed. Stop is reachable during admission, including
while native approval is pending; cancelling the held review prevents a delayed
claim from acquiring Work.

The static reader uses Workers global Fetch with `global_fetch_strictly_public`
and no private network or origin bindings. This is the platform's public-network
boundary, not manual DNS/IP pinning. Each redirect is checked before another GET.
HTMLRewriter removes form, hidden and active-content subtrees before extracting
bounded text and links. Block boundaries and truncation remain explicit. Sources
retain the final URL, read time, text digest and byte count. Native checks those
authenticated receipts against the reviewed scope and budget. Website text is
untrusted evidence, with no instruction authority. Page text, URL-bearing binding
and source receipts are purged after 24 hours; the v1 seven-day receipt rule does
not retain research URLs.

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

The research implementation passed the Worker build and 113 unit tests. The
HTMLRewriter case is skipped in plain Node and was exercised in an actual
temporary Cloudflare Worker using the same compatibility flag and production
reader. It passed passive subtree removal, block text boundaries, truncation,
and a public example.com read. A private literal was rejected with 403/1003;
a hostname independently resolved by Google DNS-over-HTTPS to 127.0.0.1 was
rejected with 530/1016. A public redirect to a private literal was rejected before
following it. This is static private-destination evidence, not a controlled DNS
rebinding test. The real provider adapter, given an intentionally invalid key,
reached the expected authentication rejection without a paid model call.

That check exposed Workers' unsupported `redirect: "error"` Fetch option. Both
provider paths now use `manual` and reject every non-success response, including
redirects, without sending credentials to another URL. The temporary verification
Worker was removed after checks. Evidence is in
`output/agent-public-web-edge.json`. The native `hosted_` suite then passed all
25 tests, including research receipts and Stop during admission. The task Worker
was deployed as version `200e974d-ede0-46ba-9281-76d7e8b93ec5` (183.40 KiB,
45.67 KiB gzip; 2 ms startup), and all nine live authorization boundary checks
passed again with text and research modes advertised. No valid provider key or
paid completion was used.
