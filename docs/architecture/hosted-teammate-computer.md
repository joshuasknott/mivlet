# Hosted teammate computer

> **Status: deployment-gated foundation.** The repository implements bounded
> Cloudflare computer and browser endpoints, but this checkout has not
> provisioned or live-validated their production dependencies.

## Boundary

Convex records optional provisioning state for a workspace/teammate pair and
mints short-lived, generation-fenced capabilities. Rust holds the root account
credential, requests only the needed capability, and calls the hosted runner.
Bearer credentials, capability tokens, internal URLs, and takeover credentials
must not enter React state or the model transcript.

The runner exposes only these capability families:

- process launch, inspection, and termination in a container workspace;
- public-HTTPS browser navigation;
- bounded browser observation and exact control actions; and
- trusted snapshot/live-view metadata for the human UI.

There is no hosted recurring-work or background-conversation contract in the
current protocol.

## Approval and authorization

A model-originated process or browser effect needs Mivlet's normal exact tool
approval and the prepared hosted proposal. The native boundary consumes the
single-use permit, obtains a scope-specific hosted capability, and sends it to
the runner. Native mints that capability through Convex HTTP
`/native/execution-capability` with the OS-keyring Clerk session. The HTTP
gate asserts Clerk issuer and subject before the internal mint action; missing
or invalid identity is `401 authentication-required`. After a valid body, the
gate consumes a sliding mint window per Clerk subject and per subject+device
(60 and 30 mints per minute); excess requests fail closed as
`429 rate-limited` and never mint. Membership, role, and
soft device binding (claimed `deviceId` must be this principal's active device
and workspace link; no public-key challenge) are rechecked inside the mint
path. The runner rechecks the computer, generation, scope, expiry, nonce,
and one-time use.

Bearer `MIVLET_HOSTED_RUNNER_API_KEY` authorizes only computer lifecycle
(provision/ensure, status, destroy). Process and browser effect routes reject
Bearer and require a `MivletCapability` signed with the distinct
`MIVLET_HOSTED_RUNNER_SIGNING_KEY`. The runner consumes the capability nonce in
Durable Object storage before the effect; a replay of the same token fails
closed, including when the nonce store is unavailable. Re-running ensure on a
computer that already has a generation bumps that generation so prior
capabilities cannot target the replacement.

Browser navigation accepts only public HTTPS targets, rejects embedded
credentials and private or reserved destinations (including DNS answers),
strips fragments, and revalidates redirects and subrequests. Cloudflare
Browser Rendering cannot pin Chromium TCP peers (`route.continue()` would
re-resolve). The Worker completes HTTPS with a lookup bound to the validated
public address set, then fulfills the route. A later private, loopback,
link-local, or cloud-metadata answer is aborted. Observations and actions are bounded to
opaque current references; password, one-time-code, payment, transaction, and
WebAuthn fields are excluded or blocked. Screens and temporary human takeover
credentials stay in the trusted UI path.

Deleting a hosted computer invalidates its computer and browser authority. A
stale generation or capability cannot target its replacement. Process
`requestKey` idempotency is generation-fenced: a launch replay whose stored
process belongs to a previous computer lifetime is `capability-stale`. Browser
generation mismatch destroys stored browser state and does **not** reconnect
the previous Browser Run session.

## Deployment prerequisites

The separate [OpenCode and Agents fixture](hosted-opencode-prototype.md)
passes local Workerd model/tool execution, scheduling, exact approval and durable
receipt recovery in separate SDK databases. It accepts fixed synthetic data and
is not connected to this runner's routes or a real provider delegation contract.

The path requires configured identity and Convex state, a deployed Cloudflare
Worker, Container/Sandbox and Browser Rendering bindings, Durable Objects,
secrets, quotas, and a live smoke test. Convex production, preview, and staging
deployments refuse `MIVLET_CLERK_ALLOW_MOCK=1` with the mock Clerk issuer; CI
rejects that pair in tracked deploy configs. A build or Wrangler dry-run verifies
source compatibility and packaging only.

## Not claimed

- No production Worker, container, browser, Convex tenant, account recovery,
  metering, quota, monitoring, or disaster-recovery path is proven here.
- Ordinary conversations do not automatically move to a hosted computer or
  continue after the desktop closes.
- Secure third-party sign-in, secret handoff, connector credential delegation,
  file upload, multi-tab automation, and native desktop applications are not
  complete.
- A deployed service would need live authorization, network-isolation,
  retention, reset, upgrade, billing, abuse, and cross-device validation before
  product claims expand.
