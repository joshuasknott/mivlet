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
the runner. The runner rechecks the computer, generation, scope, expiry, nonce,
and one-time use.

Browser navigation accepts only public HTTPS targets, rejects embedded
credentials and private or reserved destinations, strips fragments, and
revalidates redirects and subrequests. Observations and actions are bounded to
opaque current references; password, one-time-code, payment, transaction, and
WebAuthn fields are excluded or blocked. Screens and temporary human takeover
credentials stay in the trusted UI path.

Deleting a hosted computer invalidates its computer and browser authority. A
stale generation or capability cannot target its replacement.

## Deployment prerequisites

The separate [OpenCode and Agents fixture](hosted-opencode-prototype.md)
passes local Workerd model/tool execution, scheduling, exact approval and durable
receipt recovery in separate SDK databases. It accepts fixed synthetic data and
is not connected to this runner's routes or a real provider delegation contract.

The path requires configured identity and Convex state, a deployed Cloudflare
Worker, Container/Sandbox and Browser Rendering bindings, Durable Objects,
secrets, quotas, and a live smoke test. A build or Wrangler dry-run verifies
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
