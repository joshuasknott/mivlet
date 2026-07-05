# Cloud Team Sync MVP Schema And Data Flow

Date: 2026-07-05

Status: Proposed implementation contract for Batch 7

## Scope

This is the Batch 7 vertical-slice contract for the selected Clerk + Convex
team backend. It is intentionally smaller than full workspace replication.

MVP slice:

- create or link a shared workspace when Clerk and Convex config are present;
- link a local device;
- sync shared workspace/project metadata;
- create shared messages or a similarly low-risk append-only collaboration
  record;
- read realtime updates from another client;
- queue mutations offline in encrypted SQLite and flush them idempotently when
  online;
- sync tombstones for deletes in the selected slice.

Out of MVP:

- connector credential sync;
- raw connector cache replication;
- local model prompt/response sync;
- shared workflow execution authority;
- R2 large-object storage;
- end-to-end encrypted team workspaces.

## Convex Tables

Names are illustrative; Batch 7 may adjust generated names while preserving the
contract.

| Table | Key fields | Purpose |
| :--- | :--- | :--- |
| `workspaces` | `workspaceId`, `clerkOrgId`, `name`, `status`, `revision` | Shared workspace authority. |
| `workspace_memberships` | `workspaceId`, `clerkUserId`, `clerkOrgId`, `role`, `status` | Fable role projection. |
| `devices` | `workspaceId`, `deviceId`, `clerkUserId`, `publicKey`, `status`, `lastSeenAt` | Device link/revoke and audit attribution. |
| `projects` | `workspaceId`, `projectId`, `revision`, `deletedAt`, payload | Shared project metadata. |
| `threads` | `workspaceId`, `threadId`, `projectId`, `revision`, `deletedAt`, payload | Shared thread metadata. |
| `messages` | `workspaceId`, `messageId`, `threadId`, `authorDeviceId`, `revision`, `deletedAt`, payload | Append-only shared messages for MVP. |
| `tombstones` | `workspaceId`, `recordType`, `recordId`, `revision`, `deletedAt`, `actorDeviceId` | Deletion/forget stream. |
| `idempotency_keys` | `workspaceId`, `deviceId`, `clientMutationId`, `status`, `result` | Retry/replay protection. |
| `workspace_revisions` | `workspaceId`, `nextRevision` | Monotonic revision allocator. |

Payloads contain only fields allowed by the ADR. Do not store credentials,
tokens, approval permits, raw connector responses, private prompts, or
unselected local knowledge.

## Local SQLite Additions

Batch 7 should add repository-backed local tables rather than direct React
storage:

| Local table | Purpose |
| :--- | :--- |
| `cloud_workspace_link` | Maps local workspace id to Convex workspace id, Clerk org id, role, sync state, device id, and last accepted revision. |
| `cloud_sync_cursor` | Tracks per-device pull cursor and last successful realtime/pull timestamp. |
| `cloud_mutation_outbox` | Durable encrypted queue of pending shared mutations. |
| `cloud_record_shadow` | Last accepted server revision/fingerprint/deletion state per shared record. |
| `cloud_conflict` | Rejected or conflicting local mutations that require user repair. |

These tables are local runtime state. They are not exported as credentials, and
they must be omitted or disabled when importing a portable archive as a solo
workspace.

## Sync Flow

### Link shared workspace

1. User signs in through the existing Clerk identity boundary.
2. User creates or joins a shared workspace.
3. Rust asks Convex to create/link the device using a short-lived Clerk token.
4. Convex validates Clerk user/org and writes membership/device records.
5. Rust writes `cloud_workspace_link` and initializes cursor state.

### Write shared record online

1. UI sends an allowed shared mutation to Rust.
2. Rust validates the local workspace is cloud-linked and the record class is
   shareable.
3. Rust writes an encrypted outbox row with a stable `clientMutationId`.
4. Sync worker submits the mutation to Convex.
5. Convex checks auth, membership, role, device status, idempotency, and base
   revision.
6. Convex writes the record and advances workspace revision atomically.
7. Rust marks the outbox row accepted, updates the shadow row and cursor.

### Write shared record offline

1. Rust writes the same encrypted outbox row.
2. UI shows local pending state.
3. No teammate-visible authority is claimed.
4. On reconnect, the sync worker flushes in creation order per workspace.
5. Rejections create local conflict rows and stop dependent mutations.

### Pull/realtime

1. When online, the desktop subscribes to current shared views through Convex.
2. On startup or reconnect, Rust also pulls records/tombstones after the last
   accepted revision to close any realtime gaps.
3. Pull apply is transactional in local SQLite.
4. Tombstones remove records from active local views and prevent resurrection.

## Conflict Handling

Batch 7 implements exact-base-revision conflict detection for mutable records and
append-only acceptance for messages.

Accepted:

- append a new message with a unique id;
- create a project/thread if id unused;
- delete a record if role permits and record exists.

Rejected to local conflict:

- update with stale base revision;
- write after tombstone;
- write after role/device revocation;
- write of a denied record class;
- duplicate id with different idempotency key.

## Minimal Convex Function Surface

- `viewer.getWorkspaceSnapshot({ workspaceId, afterRevision })`
- `viewer.subscribeWorkspace({ workspaceId })`
- `workspace.createOrJoin(...)`
- `device.link(...)`
- `device.revoke(...)`
- `mutations.applyOutboxMutation(...)`
- `membership.list(...)`

Public functions must be thin authorization wrappers over internal helpers so
tests can exercise the policy matrix directly.

## Large Objects

For Batch 7, prefer no binary object sync unless a small avatar/icon is required
for the vertical slice. If needed, use Convex storage with metadata in Convex
records. R2 requires a follow-up design before implementation.
