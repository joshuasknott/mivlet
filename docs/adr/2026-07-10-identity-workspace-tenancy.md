# ADR: Identity and Workspace Tenancy

Date: 2026-07-10

Status: Accepted

## Decision summary

Clerk is Fable's managed identity and session provider. It authenticates a
person, manages sign-in and recovery, and issues and revokes sessions. Clerk
does not define Fable tenants, workspace membership, invitations, product
roles, or authorization.

Fable owns stable internal users, identity-provider links, workspaces,
memberships, invitations, roles, devices, and authorization decisions. Convex
is the first hosted implementation of the Fable-owned shared authority, not the
owner of the product ontology.

One workspace model represents every hard-isolated Fable environment. A
workspace can have one member or many members without changing type. Fable
does not have separate Personal Home and Team Workspace types, does not use
Clerk Organizations as tenancy, and does not add a parent Fable Organization
layer now.

This decision is the authority for Wave 0B identity and workspace contracts
and Wave 0C tenancy implementation. It follows the [Product
Blueprint](../product/vision.md) and the ordering in the [Master Build
Plan](../product/master-build-plan.md).

## Scope and decision boundary

This ADR decides who owns identity and tenancy concepts, how an authenticated
principal becomes a Fable user, and which checks must precede access to a
workspace.

It does not decide the complete per-record encrypted SQLite versus Convex
authority matrix. That is defined by the [Core Record Authority
Matrix](../architecture/record-authority-matrix.md). In
particular, this ADR does not imply that all records in a one-member workspace
are local-authoritative or that all records in a multi-member workspace are
Convex-authoritative. Record placement, offline commitment, mirroring, and
conflict rules must follow that later matrix while preserving the identity and
authorization invariants here.

## Context

The approved product requires a Fable account, automatically creates an
initial workspace, supports multiple isolated workspaces, and treats a
workspace as personal or collaborative according to its current membership.
That direction conflicts with assumptions in the existing implementation
foundation and older documents:

- [Optional Clerk Identity for Tauri
  Desktop](2026-07-04-clerk-tauri-identity.md) treats a Fable account as
  optional, guarantees anonymous solo-workspace use, carries Clerk
  organization selection into the desktop identity, and proposes organization
  claims as a future team boundary.
- [Optional Cloud Team Backend](2026-07-05-cloud-team-backend.md) distinguishes
  local solo workspaces from explicitly cloud-backed shared workspaces, keys
  Fable membership directly by Clerk user and organization IDs, and requires a
  matching Clerk organization claim for workspace access.
- [Cloud Team Sync MVP](../architecture/cloud-team-sync-mvp.md) projects those
  assumptions into `clerkUserId`, `clerkOrgId`, and cloud-link fields.
- [Workspace and Project Data
  Scopes](../architecture/workspace-data-model.md) correctly establishes hard
  local workspace isolation and a `default` compatibility workspace, but it
  predates the stable internal-user and membership model.

Those foundations contain useful work: system-browser PKCE, native secret
custody, JWT validation, Convex authorization wrappers, workspace-scoped
queries, device attribution, an encrypted outbox, revisions, idempotency, and
tombstones. The conflict is in product identity and tenancy semantics, not in
the need for those security mechanisms.

## Product decision versus current implementation

### Product decision

The decision in this ADR is the intended product contract:

- every product user has a stable Fable internal user;
- every usable product scope is a Fable workspace;
- every workspace access path resolves through a Fable membership;
- Clerk sessions authenticate identities but never grant workspace access by
  themselves; and
- the same workspace contract supports one or many members.

### Current implementation state

The current checkout is a config-gated foundation and does not satisfy this
decision yet. As also recorded in [Status](../product/status.md):

- the Rust Clerk module treats identity as optional, stores Clerk credentials
  in a dedicated native keyring boundary, validates issuer, audience,
  authorized party, signature, time claims, and optional organization claims,
  and exposes the Clerk subject and organization metadata to React;
- the UI displays identity status but does not make a hosted Fable account the
  mandatory product gate;
- Convex has no internal-user, identity-link, or invitation table;
- Convex workspaces, memberships, and devices store `clerkOrgId` and/or
  `clerkUserId`, and its policies require the session organization to match the
  workspace organization;
- the local cloud link stores a Clerk organization ID and a cached role;
- only a narrow project sync policy and local encrypted outbox foundation
  exist; the live Convex adapter and complete workspace journey do not; and
- the local `default` workspace is a compatibility owner, not yet a provisioned
  workspace belonging to a stable internal user.

No statement in this ADR should be read as claiming those gaps are already
implemented.

## Authoritative model

### Clerk-owned concepts

Clerk owns only the managed identity and session boundary:

- sign-up and sign-in ceremonies;
- authentication factors and verified identity attributes;
- credential recovery;
- external identity-provider account lifecycle;
- session issuance, expiry, refresh, and revocation; and
- signed claims needed to validate the authenticated external principal.

Fable may cache the minimum verified profile attributes needed for display,
invitations, support, and reconciliation. Cached email, name, avatar, or other
profile data is not a product authorization source.

Clerk Organizations, organization membership, organization roles, and
organization claims are outside the Fable tenancy and authorization model.
They must not be required to create, join, select, or authorize a Fable
workspace.

### Fable-owned concepts

Wave 0B contracts must represent at least these concepts independently of
Clerk and Convex field names:

| Concept | Required meaning |
| --- | --- |
| Internal user | Stable, opaque Fable identity referenced by all product records and audit actors. |
| Identity link | Mapping from an external provider plus issuer and subject to exactly one internal user. |
| Workspace | Hard-isolated product tenant with its own lifecycle and no personal/team type discriminator. |
| Membership | Fable-owned relationship between one internal user and one workspace, including role and lifecycle state. |
| Invitation | Fable-owned, expiring offer to create a membership in one workspace under a specified role. |
| Role | Fable-owned coarse authorization assignment; never copied from a Clerk organization role. |
| Device | Revocable Fable installation or client identity linked to an internal user for attribution and eligible operations. |
| Authorization context | Resolved internal user, target workspace, active membership, role/capabilities, session, and device facts used for one request. |

These records need stable Fable IDs. Hosted vendors may store or process them,
but vendor identifiers do not replace their Fable IDs.

### Stable internal identity mapping

The canonical mapping key is the tuple of identity provider, normalized issuer,
and provider subject. For the initial implementation, the provider is Clerk.
The mapped value is an immutable, opaque `internalUserId` generated by Fable.

The following rules apply:

1. Validate the external session before using any claim.
2. Look up an active identity link by provider, issuer, and subject.
3. If none exists, create the internal user and identity link through one
   idempotent bootstrap transaction, subject to account policy.
4. Use only the internal user ID in Fable-owned memberships, invitations after
   acceptance, workspace records, devices, runs, approvals, audit events, and
   other durable product relationships.
5. Treat email, phone number, display name, and organization claims as mutable
   attributes, not identity keys.

An email match must never silently merge users or attach a new provider
subject to an existing user. Account linking, provider migration, and recovery
from a changed subject require a deliberate, authenticated Fable flow with an
auditable proof and collision handling.

### Session and claim validation boundary

The desktop's native boundary may obtain, refresh, validate, and securely store
Clerk session credentials. React receives only secret-free account and session
status plus the Fable-facing display data it needs. Raw access, ID, refresh, or
session tokens never enter ordinary React state, logs, snapshots, portable
exports, or workspace records.

Every hosted entry point independently validates the token using trusted
configuration and the provider's signing keys. Validation must fail closed on
at least signature or algorithm mismatch, issuer mismatch, audience mismatch,
authorized-party mismatch where applicable, expiry, not-before, issued-at,
revocation or disabled-account state, and malformed required claims.

After validation, the hosted boundary extracts the external issuer and subject,
resolves the active Fable identity link, and obtains the internal user. It does
not trust a client-supplied internal user ID, workspace ID as an authorization
grant, cached role, email, Clerk organization, or renderer assertion.

A valid Clerk session answers only “which external principal authenticated?”
It does not answer “which workspace may this person access?” or “what may this
person do there?” Those are Fable authorization questions.

### Account gate and offline behavior

Fable no longer has an anonymous or optional-account product mode. Initial
product onboarding requires a valid Clerk-backed Fable account before a person
can bootstrap or enter their Fable workspaces.

This does not require constant connectivity. A previously provisioned desktop
may support bounded offline access to eligible local records using a previously
verified internal-user/device binding. Wave 0B and the authority matrix must
define the acceptable offline grace, reauthentication, shared-cache, and
high-risk-operation rules. Offline state never permits cloud access, invitation
acceptance, membership changes, role changes, identity linking, or any action
that claims current remote authorization. A cached identity or role is not
sufficient to flush queued writes after reconnect; current session, membership,
workspace, and device state must be checked again.

### Workspace bootstrap

The first successful resolution of a new internal user triggers an idempotent
Fable bootstrap:

1. create the internal user and active Clerk identity link if they do not
   already exist;
2. create that user's initial workspace using the ordinary workspace contract;
3. create one active `owner` membership for the internal user; and
4. return the internal user, initial workspace, and membership as one coherent
   result.

Retries, concurrent first sessions, and multiple devices must converge on the
same bootstrap result and must not create duplicate users, initial workspaces,
or owner memberships. An invited user still receives an initial workspace; an
accepted invitation gives access to an additional workspace. Inviting a second
member does not convert, copy, relink, or retype the existing workspace.

The `default` local workspace is migration input only. Wave 0C must associate
eligible legacy data with a real Fable workspace and internal owner without
using `default` as an authorization fallback.

### Membership and invitation authority

Only an active Fable membership grants workspace access. Membership state and
role are read from Fable authority for the target workspace on every hosted
request and at every consequential local or synchronization boundary.

The initial role vocabulary is:

- `owner`: controls workspace lifecycle, ownership, members, export, erasure,
  and destructive policy;
- `admin`: manages members and shared settings except ownership transfer or
  another owner-only action;
- `editor`: creates and changes ordinary workspace records subject to
  capability, approval, and record policy; and
- `viewer`: reads permitted workspace records but cannot mutate them.

Wave 0B must define the exact permission matrix and lifecycle states. At least
one active owner must remain for every active workspace; removal, account
deletion, or role change must not orphan it.

Fable invitations, not Clerk Organizations, control joining:

- an active owner or otherwise explicitly permitted Fable member creates the
  invitation;
- the invitation names one workspace, intended role, inviter, expiry, and
  intended recipient constraint;
- invitation secrets are high-entropy, stored as non-recoverable digests, and
  never logged or placed in portable data;
- acceptance requires a freshly validated Clerk session that resolves to an
  internal user and satisfies the invitation's verified-recipient policy;
- acceptance atomically consumes the invitation and creates or reactivates at
  most one membership; and
- expiry, revocation, duplicate acceptance, role changes, and removed members
  fail closed and remain auditable.

Clerk may verify an email used by the invitation policy, but Clerk does not own
the invitation or create the membership.

### Authorization enforcement

Every read, write, subscription, sync mutation, artifact access, retrieval,
execution, and administrative action must enforce the same ordering:

1. validate the external session at the receiving trust boundary;
2. resolve an active Fable internal user through an active identity link;
3. load the target Fable workspace and require an active workspace state;
4. load an active membership for that internal user and workspace;
5. authorize the requested operation using the Fable role, capability grant,
   record policy, approval requirement, and execution-placement policy;
6. validate device or session eligibility where the operation requires it;
7. constrain storage and retrieval by the target workspace before reading or
   ranking content; and
8. attribute the accepted or rejected action without storing raw credentials.

Convex public functions must remain thin, fail-closed authorization wrappers
over internal helpers, and every query, mutation, subscription, storage URL,
and hosted execution entry point must apply workspace membership checks before
returning tenant data. Fable-controlled services outside Convex must apply the
same contract.

Local repositories and Tauri commands must require an explicit validated
workspace scope. A missing, invalid, revoked, or inaccessible workspace must
not fall back to `default`, the last active workspace, a sole workspace, or a
client-cached role. Record ownership checks must prevent an ID from being read,
claimed, moved, or deleted through another workspace.

Approval authority is an additional boundary. Membership or an `owner` role
does not itself approve a connector action, provider charge, destructive tool
call, or another consequential side effect.

### Workspace switching

Workspace switching changes the selected Fable context; it does not change the
Clerk session or select a Clerk organization.

The workspace list is derived from the current internal user's active Fable
memberships. Selecting a workspace must verify membership before activating
its local scope, subscriptions, caches, connections, and navigation. Every
subsequent request still carries an explicit target workspace and is authorized
independently; the selected workspace is not a bearer grant.

The selected workspace may be remembered per device for convenience. Startup
must clear or replace that selection when the membership or workspace is no
longer active. Background runs, pending approvals, outbox entries, and open
views retain their explicit workspace identity and must not silently follow a
later UI switch.

### Device and session attribution

Fable generates device IDs independently of Clerk. A device is linked to an
internal user after authenticated registration and has its own lifecycle,
including revocation. Device identity supports provenance, cursor ownership,
idempotency namespaces, risk policy, and selective unlinking; it never
substitutes for a current session or workspace membership.

Consequential and shared actions must be attributable to, at minimum:

- internal user ID;
- workspace ID;
- Fable device ID when a device initiated or executed the action;
- a safe Fable session or authentication-event reference when applicable;
- membership/role or policy version used for the decision;
- approval actor and exact approval reference when approval was required; and
- time, operation, outcome, and execution node.

Raw Clerk tokens, connector credentials, and unnecessary mutable profile data
must not be copied into audit events. On reconnect, queued writes are
reauthorized against current user, membership, role, workspace, and device
state. A removed member or revoked device cannot flush authority captured
before revocation.

### Account recovery, deletion, and identity lifecycle

Clerk recovery restores access to the external identity. If recovery preserves
the validated issuer and subject, the identity link resolves to the same
internal user and no workspace data changes ownership.

If recovery or provider migration produces a different subject, Fable must not
relink by email alone. A privileged account-link or support-recovery procedure
must prove control, prevent collisions, preserve audit history, and leave a
revocable record of the old and new links.

Sign-out and session expiry do not delete the internal user or workspace data.
Deleting or disabling a Clerk identity also must not silently cascade-delete
Fable records. It disables or revokes the corresponding identity link and
blocks new authorization until Fable reconciles the lifecycle event.

Fable owns the product account-deletion workflow. It must coordinate:

- session and device revocation;
- pending invitation cancellation where appropriate;
- sole-owner transfer, workspace deletion, or an explicit recovery path;
- removal or anonymization of memberships and attributable records according
  to retention requirements;
- deletion or transfer of Fable-owned workspace data under the authority
  matrix;
- local cache, outbox, credential-reference, and device cleanup;
- export and recovery windows where policy allows; and
- the separate Clerk identity deletion request.

The workflow must be retryable and auditable. Partial failure must not leave an
orphaned active workspace, a live identity link to a deleted provider account,
or data accessible through a stale session.

### Provider, connector, and MCP credential separation

Fable account identity is distinct from every execution and integration
credential:

- Clerk session credentials stay in the dedicated identity secret boundary;
- model-provider and provider-route credentials stay in their own native or
  managed credential boundaries;
- connector OAuth credentials stay in connector-specific custody, including
  the narrow confidential OAuth broker where applicable;
- MCP authorization stays with the relevant Connection boundary;
- local vault keys and device signing keys remain separate; and
- approval permits and capability grants are Fable authorization records, not
  credentials inherited from any of the above.

A Fable membership does not grant use of a member's personal connection. A
connection must explicitly record its owning internal user or workspace,
sharing scope, capability grants, and approval policy. Removing a member,
revoking a Clerk session, disconnecting a connector, and revoking a provider
route are separate operations with separate effects.

### Future identity-provider replacement

All durable product references point to the Fable internal user, not to Clerk.
The external mapping includes a provider identifier, issuer, and subject so a
future identity provider can be introduced alongside Clerk.

A replacement can therefore:

1. validate the new provider through an adapter implementing Fable's session
   boundary;
2. attach a new verified identity link to the existing internal user through a
   privileged linking flow;
3. run both links during a controlled migration;
4. revoke the Clerk link after verification; and
5. leave workspace IDs, memberships, invitations, roles, artifacts, audit
   actors, and other product data unchanged.

Provider-specific session claims must not leak into Fable's portable domain
contracts. Provider replacement may require users to reauthenticate, but it
must not require rewriting tenancy data.

## Security invariants

The implementation is not conformant unless all of these hold:

1. No unvalidated external claim influences identity or authorization.
2. Provider plus issuer plus subject maps to at most one active internal user;
   email and organization claims never act as user keys.
3. A valid Clerk session alone grants access to no workspace.
4. Every workspace access requires an active Fable user, workspace, and
   membership, checked at the receiving boundary.
5. The target workspace is explicit and is applied before data retrieval,
   ranking, mutation, subscription, storage access, or execution.
6. No absent or invalid scope falls back to `default`, the selected workspace,
   or another tenant.
7. Role, invitation, membership, workspace, user, device, and identity-link
   revocation fail closed and are rechecked before queued or consequential
   work executes.
8. Workspace switching never transfers credentials, context, cached records,
   pending work, or authority between workspaces.
9. One-member and multi-member workspaces receive identical isolation and
   authorization treatment.
10. Identity tokens, connector tokens, provider secrets, vault keys, device
    private keys, and approval permits remain in separate custody and never
    enter ordinary product records or exports.
11. At least one active owner remains for an active workspace, or the workspace
    enters an explicit locked/deletion recovery state.
12. Account deletion and provider lifecycle events cannot silently orphan,
    transfer, or expose workspace data.
13. Audit attribution uses Fable IDs and safe references, never raw tokens or a
    mutable email as the actor key.
14. Authorization denials reveal no cross-workspace existence or data.

## Compatibility and migration implications

Wave 0B contracts and Wave 0C migration must account for these changes:

- Add stable internal-user and identity-link records before replacing any
  existing Clerk-subject references.
- Backfill each known Clerk issuer/subject pair to exactly one internal user;
  quarantine ambiguous or duplicate mappings rather than merging by email.
- Replace `clerkUserId` in Convex memberships, devices, and actor references
  with internal user IDs while retaining temporary migration metadata only as
  needed for verification and rollback.
- Remove `clerkOrgId` from workspace authority, membership authorization,
  desktop cloud-link authority, and required claim checks. Historical values
  may be retained temporarily as non-authoritative migration provenance.
- Add Fable-owned invitation records and their acceptance/revocation lifecycle;
  Clerk organization invitations must not be imported as active Fable
  memberships without an explicit verified migration.
- Preserve existing Fable workspace IDs, record IDs, revisions, tombstones,
  idempotency results, and audit history wherever safe. An old organization-
  backed workspace may become an ordinary Fable workspace one-for-one, but the
  organization stops being its live authority.
- Replace the local cloud link's cached Clerk organization and role assumptions
  with Fable workspace, internal-user/device, and synchronization references.
  A cached role may be display or offline metadata only, never hosted authority.
- Map eligible `default` workspace data into a provisioned Fable workspace
  through an explicit, retryable migration. Never adopt arbitrary local data
  into a signed-in account based only on a matching display name or email.
- Remove tenancy use of organization fields, organization-required status,
  `FABLE_CLERK_REQUIRE_ORG`, `FABLE_CLERK_REQUEST_ORG`, and allowed-organization
  configuration. The underlying PKCE, native secret storage, session refresh,
  and issuer/audience/signature validation remain useful.
- Expect reauthentication during rollout where the old token audience, scopes,
  or organization requirements differ from the new session contract.
- Do not create a migration that changes workspace type when membership count
  changes; there is no such type.

Migration must be staged, resumable, observable, and reversible until
cross-workspace isolation and mapping cardinality have been verified. Exact
record-by-record source authority and copy direction follow the [Core Record
Authority Matrix](../architecture/record-authority-matrix.md).

## Superseded statements

This ADR supersedes the following statements without editing the older files:

### In the 4 July Clerk/Tauri identity ADR

- A Fable account is optional for product use.
- Signed-out users retain a separate anonymous solo-workspace product mode.
- Organization selection, `org_id`, `org_role`, allowed organization IDs, or an
  organization-required state participates in Fable tenancy.
- Clerk organization context is projected into future Fable cloud/team
  authorization.
- The Clerk subject is suitable as the durable user ID exposed across product
  contracts.

Its decisions about public-client Authorization Code plus PKCE, system-browser
authentication, native/keyring token custody, strict callback handling, JWT
validation, and separation from connector OAuth remain applicable unless a
later implementation ADR changes them.

### In the 5 July cloud-team backend ADR

- Clerk owns organization identity for Fable workspaces.
- A matching Clerk organization and organization membership is a prerequisite
  for Fable workspace access.
- Fable memberships, devices, local cloud links, and authorization are keyed by
  Clerk user or organization IDs.
- Solo and shared are distinct workspace authority modes selected by converting
  or explicitly cloud-linking a workspace.
- Clerk is optional for the Fable account and workspace product.

The selection of Convex as the first shared-state backend, the narrow
Cloudflare connector-broker boundary, encrypted local outbox/cursor/shadow
patterns, server-side authorization, idempotency, revisions, tombstones, and
credential exclusion remain applicable subject to the separate authority
matrix and this ADR's internal-user model.

### In derived architecture documents and current code

Fields and flows named `clerkOrgId`, `clerkUserId`, owner organization,
organization-backed workspace, organization selection, and organization claim
matching are legacy implementation inputs, not the target contract. The
`default` workspace remains a migration compatibility mechanism but is not an
identity or authorization rule.

## Rejected alternatives

### Clerk Organizations as Fable tenancy

Rejected. It would make a vendor's organization lifecycle, invitations, role
model, claim shape, and limits part of Fable's product ontology. It also forces
one-member workspaces and invited collaboration through an organization model
that Fable does not otherwise need. Clerk Organizations could be integrated
later for a narrowly approved enterprise identity use case, but they would
still map into Fable-owned users, workspaces, memberships, and policy.

### Distinct Personal Home and Team Workspace types

Rejected. Member count is mutable and should not force data migration, URL/ID
replacement, connection transfer, authority conversion, or a second set of
contracts. One workspace begins with one owner and becomes collaborative by
adding a membership; it becomes single-member again by removing memberships
under owner-safety rules.

### Clerk subject as the universal product key

Rejected. It couples every durable record to one identity provider and makes
provider replacement, account linking, changed subjects, recovery, test
identities, imports, audit retention, and deletion harder. The subject is a
unique external identity-link key, not the Fable user key.

### Parent Fable Organization now

Rejected. The private product needs isolated workspaces, not enterprise
hierarchy, centralized administration, SCIM, consolidated billing, or
organization-wide policy. Adding an unused parent would complicate every
authorization and migration path. A parent Organization remains a deferred
product decision; future contracts can add it above existing workspace IDs
without pretending it exists today.

## Consequences

Positive consequences:

- Fable's tenancy and authorization remain portable across identity and backend
  providers.
- Personal and collaborative use share one mental model, contract, isolation
  boundary, and migration path.
- Workspace access is explicit and testable independently of mutable identity
  claims.
- Invitations, roles, membership lifecycle, account deletion, and auditing can
  match Fable's product requirements instead of a provider's organization
  model.
- Provider, connector, MCP, device, approval, and account trust boundaries stay
  distinct.

Costs and risks:

- Fable must build and operate internal-user mapping, bootstrap,
  invitation/membership lifecycle, device lifecycle, authorization helpers,
  reconciliation, deletion, and recovery flows.
- Existing Convex and local cloud-sync schemas require a careful migration away
  from Clerk IDs and organization checks.
- Account-mapping mistakes could merge people or strand data; migration and
  recovery need strict cardinality checks and manual quarantine paths.
- Mandatory account onboarding changes the legacy local-first startup
  experience, and bounded offline use needs a deliberate policy.
- Convex authorization defects can still cause cross-tenant disclosure even
  with correct contracts; policy helpers and adversarial isolation tests are
  release gates.
- Fable becomes responsible for avoiding ownerless workspaces and coordinating
  provider deletion with product-data retention and erasure.

## Wave 0B and Wave 0C requirements

Wave 0B must turn this decision into provider-neutral TypeScript and Rust
contracts with parity tests. It must define identifiers, lifecycle states,
role permissions, authorization context, invitation acceptance, bootstrap
idempotency, error taxonomy, and safe audit attribution without embedding
Clerk organization semantics.

Wave 0C must implement and test:

- internal users and provider/issuer/subject identity links;
- idempotent initial workspace and owner membership bootstrap;
- multiple workspaces and membership-derived switching;
- invitation create, revoke, expire, accept, and replay behavior;
- role changes, member removal, last-owner safety, and immediate revocation;
- server-side and local workspace authorization before data access;
- internal-user/device/session attribution and queued-write reauthorization;
- schema and data migration from Clerk user/org fields and `default` local data;
- account sign-in gating plus the approved offline policy;
- deletion, recovery, and identity-link reconciliation; and
- adversarial cross-workspace, cross-user, stale-session, revoked-device,
  revoked-member, duplicate-bootstrap, and invitation-hijack tests.

## Open implementation questions

These questions do not reopen the product decision, but they must be resolved
in Wave 0B contracts, the authority matrix, or focused implementation ADRs:

1. Which exact internal-user, identity-link, membership, invitation, device,
   and workspace lifecycle states are required, and which transitions are
   reversible?
2. What is the complete role-to-permission matrix, and when, if ever, are
   custom roles justified?
3. How are invitation recipient constraints normalized and verified without
   making email the internal identity key?
4. What bootstrap idempotency key and transaction boundary work across Clerk,
   Convex, multiple devices, retries, and partial failure?
5. What offline grace period and local reauthentication are acceptable for
   previously provisioned accounts, and which operations always require a live
   session?
6. What Fable session/authentication-event reference is safe and useful for
   audit, and how is Clerk session revocation reconciled without storing raw
   tokens?
7. Is a device global to an internal user with per-workspace authorization, or
   represented by separate workspace links, and what proof is required to link
   or recover it?
8. Which Clerk webhooks or polling reconciliation are required for user,
   session, verified-email, and deletion events, and how are replay,
   ordering, and webhook secret custody handled?
9. What privileged evidence and operational process may link a replacement
   identity subject when ordinary recovery does not preserve the subject?
10. How do export, retention, anonymization, legal holds, sole-owner transfer,
    and deletion recovery interact for internal users and workspaces?
11. Where is the per-device selected workspace stored, and how are open views,
    pending approvals, and background work invalidated after membership
    revocation?
