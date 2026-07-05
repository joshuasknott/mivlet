# Cloud Team Sync Threat Note

Date: 2026-07-05

Status: Accepted for Batch 7 design input

This note extends the main [threat model](./threat-model.md) for optional
cloud/team sync. It does not replace the local encrypted SQLite, connector, or
auth-broker threat models.

## Assets

- Solo local workspace data in encrypted SQLite.
- Shared workspace records in Convex.
- Local shared-workspace cache and outbox in encrypted SQLite.
- Clerk session/refresh credentials in the dedicated identity keyring service.
- Device identity keypair in the native keyring boundary.
- Shared workspace membership, roles, cursors, idempotency records, tombstones,
  and audit summaries.
- Optional shared large objects in Convex storage or future R2.

## Trust Boundaries

- React to Rust Tauri commands.
- Rust to encrypted SQLite and OS keyring.
- Rust/desktop to Clerk OAuth/OIDC.
- Desktop to Convex queries, mutations, and subscriptions using a Clerk JWT.
- Convex function authorization to Convex database records.
- Convex to optional object storage.
- Desktop to confidential OAuth broker for connector OAuth only.
- Desktop to connector provider APIs after local approval.

## Primary Risks

### Cross-tenant reads or writes

Risk: a query, mutation, index, or cursor path returns or mutates another
workspace's records.

Controls:

- Every Convex table that stores user data includes `workspaceId`.
- Every public Convex query/mutation derives the user from `ctx.auth` and checks
  Fable workspace membership before touching records.
- Clerk org membership is necessary but not sufficient; Fable role and workspace
  status are also checked.
- Queries must use workspace-scoped indexes where possible and filter by
  `workspaceId` before returning data.
- Tests include negative cross-workspace reads, writes, cursor pulls, tombstone
  pulls, and idempotency replays.

### Unauthorized offline writes after membership changes

Risk: a device queues writes while offline after the user's membership or role
has been revoked.

Controls:

- Offline shared writes are pending only; they are not globally committed until
  Convex accepts them.
- Convex validates current Clerk identity, workspace membership, role, device
  status, and record ownership for every mutation.
- Rejected queued writes remain local conflict/rejection records and are not
  retried silently.
- Device unlink marks the local shared cache stale and blocks outbox flush.

### Device theft or stale linked devices

Risk: a lost device keeps reading cached shared data or submits queued writes.

Controls:

- Device id and signing key live in the OS keyring boundary.
- Convex stores device records with active/revoked status.
- Mutations include `deviceId` and are rejected for revoked devices.
- Local unlink and remote device revoke are separate actions.
- Cached shared data remains protected by the local SQLite vault, but remote
  revocation cannot erase data from an offline stolen device. Product copy must
  be honest about this limitation.

### Data accidentally synced from private local state

Risk: credentials, raw connector data, private prompts, local model output,
approval permits, or unselected knowledge enter Convex.

Controls:

- The ADR's "never leaves the device" list is a hard sync denylist.
- Sync code uses explicit allowlists per record type rather than generic table
  replication.
- Connector-derived sharing requires a user-selected shared record, not raw
  connector cache replication.
- Changed-file secret scan is required for docs/config changes; code batches add
  runtime redaction tests before any sync writer lands.

### Idempotency or replay failure

Risk: retrying an offline mutation creates duplicate messages, duplicate
records, or repeated side effects.

Controls:

- Every outbox mutation has a stable `clientMutationId` and workspace/device
  scoped idempotency key.
- Convex stores consumed idempotency keys and returns the original result on
  replay.
- Connector writes and local execution permits are never represented as cloud
  sync mutations.
- Shared schedules/workflows require server acceptance before they become team
  authority.

### Tombstone bypass and data resurrection

Risk: stale clients re-upload deleted or forgotten records.

Controls:

- Tombstones are authoritative and revisioned.
- Tombstones win over stale update mutations.
- Pull streams include tombstones after the client's last cursor.
- Export includes tombstones needed to preserve deletion/forget semantics.

### Shared object URL leakage

Risk: a generated file URL is shared outside the workspace.

Controls:

- Convex storage IDs or R2 object keys are stored as metadata, not durable public
  URLs.
- Download URL generation happens only after authorization.
- URLs are treated as bearer access and kept short-lived where the provider
  supports that pattern.
- Object keys are unguessable and workspace-scoped.

## Explicit Non-Goals

- No cloud sync for connector credentials, OAuth tokens, PKCE state, or approval
  permits.
- No connector API proxying through Convex or the auth broker.
- No requirement to sign in for solo local use.
- No claim that the first shared MVP is end-to-end encrypted.
- No use of Cloudflare D1 as a parallel authoritative team database.

## Batch 7 Security Acceptance Criteria

- Missing Clerk or Convex config keeps solo startup and local work available.
- Convex functions fail closed without a valid Clerk identity.
- Cross-workspace query/mutation tests fail before any data is returned or
  changed.
- Viewer role cannot write; editor role cannot manage membership; revoked device
  cannot flush outbox.
- Idempotency replay returns the same result and does not duplicate records.
- Tombstone tests prevent stale update resurrection.
- Sync writer tests prove denied record classes are rejected before network
  egress.
