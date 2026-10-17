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

## Isolated offline coding

The separately typed v3 `offline-coding` operation is implemented across native
admission, task custody, the private coding runtime and native file import. It is
activation-gated: the existing Free task deployment has no `CODING_RUNTIME`
binding, and rejects coding before reserving or dispatching a provider request.
The account currently requires Workers Paid for Containers. No paid upgrade or
container deployment was performed by this work. The private runtime must pass
its real network and child-isolation checks before any coding model call.

Native preparation holds one unstarted root Work item, captures source from its
immutable `repositoryBinding`, and shows the complete source manifest, writable
names, exact check argv, image, messages and limits. The renderer supplies names,
never file bytes, archive paths or success claims. Snapshots bind the account,
computer scope, Work generation, task/run IDs, full retained-copy tree and HEAD;
only selected ordinary UTF-8 files and their public manifest cross the boundary.
Private, credential and control paths, links, aliases and LFS pointers are
rejected. Omitted files and the full local tree digest remain native.

One consumed task admission authorizes only that reviewed scratch operation;
it does not inherit local tool approvals or Full Access. Its private tools are
`scratch_list`, `scratch_read`, `scratch_write` and `scratch_check`. Writes and
deletions require exact writable names, which may be empty for read-only tasks.
Checks select a reviewed ID and argv array; no shell expansion or installs are
added. Each model/tool step journals its digest and budget before effects. An
unfinished effect is uncertain and is not automatically repeated.

The limits are four model calls, eight scratch tools, 4,096 aggregate requested
output tokens, 120 seconds, 32 MiB per tree, 2,000 files, 256 KiB per file and a
64 KiB answer. The full admission, including metadata, has a separate 512 KiB
limit; long paths reduce the reachable file count. A conservative native check
rejects oversized metadata before snapshot capture. Model messages remain
limited to 64 KiB; compact policy binds the full manifest digest, and bounded
listing exposes names on demand. Four coding tasks can be retained per account.
Immutable input/output transfer leases bind exact manifests, owner, device,
nonce and expiry, with 64 KiB chunks. Partial input transfer does not extend the
original deadline. Stop fences every subsequent chunk and seal. Refresh may
retry immutable result reads; it does not restart an admission or check.

`wrangler.coding.jsonc` defines a separate private service with no public route,
provider/account secrets, mounts, preview ports or outbound handlers. Its SDK is
the existing pinned `@cloudflare/sandbox@0.13.0-next.738.2`. Coding uses the same
release's Python image, pinned immutably as
`docker.io/cloudflare/sandbox:0.13.0-next.738.2-python@sha256:545b3df29a246f83e6fdb907180ea3169a91ee567d5478823a2248604c6bc353`.
The default image omits Python, so it cannot run the fixed custody wrapper. The
release's [Dockerfile](https://github.com/cloudflare/sandbox-sdk/blob/e952c0c41432cf91d2dedd1c9726f47c8a582ba4/packages/sandbox/Dockerfile)
defines `/usr/bin/python3` and `/usr/local/bin/node` in this variant. This does
not change the existing computer deployment's image or SDK version.

The runtime sets `enableInternet=false` before launch, using the platform's
[outbound-traffic boundary](https://developers.cloudflare.com/containers/configuration/outbound-traffic/).
Before project data is staged, fixed trusted probes compare reachable public
HTTP, HTTPS, DNS and resolver controls with the offline runtime. A failed private
TCP connect without a reachable positive control is not independent private-TCP
conformance evidence. Project children additionally run as UID/GID 65534 with
cleared groups, closed inherited descriptors, resource limits, `no_new_privs`
and an inherited amd64 seccomp filter. This is required because the pinned
container's local SDK control server is not a project trust boundary. The filter
denies network and control-escape syscalls, including socket/connect, ptrace,
process-memory access, `pidfd_getfd` and io_uring; unsupported ABI/filter setup
fails closed. Fixed pre-project positive loopback/Unix controls establish that
the corresponding filtered attempts are actually denied. No project code or
task text enters these probes. A proof is cached for at most eight hours for
the exact image/isolation marker; cancellation retires the exact runtime before
later staging or launch can wake it again.

The cloud provider key stays in encrypted provider custody. Entire decoded tool
calls, JSON property names, source contents, filename/argv metadata, check output
and final results are checked against the exact enrolled key before the relevant
model, sandbox or result boundary. Checks materialize a fresh candidate tree;
their filesystem changes are discarded, and receipts bind the candidate digest.
Task source, output and proposals are purged from cloud task storage after 24
hours. Native source custody remains bounded to four snapshots per copy. Before
another capture, native automatically releases only exact reconciled terminal
snapshots or provably unclaimed abandoned reviews. A live preparation guard spans
capture through review publication. Matching held reviews, active/uncertain
tasks, pending imports and recovery evidence remain protected. The copy and
snapshot leases exclude readers during retirement; only the atomic retirement
rename runs under the canonical Work transaction, and bounded recursive cleanup
runs afterward. Unknown preparation data is preserved.

An unreviewed file/check/tool request parks its exact proposal and authenticated
partial candidate as `needs-review`, with canonical Work awaiting the user.
There is no same-attempt scope expansion or functional Resume control: broader
work requires a new complete task review. The partial candidate may be reviewed
for import separately. Ordinary completed candidates remain `awaiting-import`;
neither state appends a success answer or changes local files merely because
the cloud returned one. Authenticated unchanged output may finish without a
file import because it has no local effects.

Native output staging validates the original snapshot, exact output manifest,
per-file hashes and writable paths. A separate one-use import approval rechecks
the original copy tree/HEAD, Work/run/generation and authority, creates a recovery
checkpoint, then applies only returned changes through the existing durable
filesystem journal. Omitted local files remain intact. Refresh repairs only an
already acknowledged native import receipt after lost IPC; it never reapplies
files. Canonical completion requires that exact encrypted native receipt. Stop,
changed conversation heads or reduced authority retain results separately.

Source and mocked checks establish these contracts, not a working deployed
Container. Activation requires a deliberately configured private coding service
binding, Workers Paid entitlement, successful installed-image network/child
conformance, and an actual separately enrolled provider completion. Dynamic
hosted browser execution and an asleep approval inbox remain unavailable; there
is no browser or host-shell fallback.

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
