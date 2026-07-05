# Batch 7 Cloud Team Sync Plan

Date: 2026-07-05

Status: Proposed

## Goal

Build the first vertical slice of optional shared workspaces using Clerk +
Convex while preserving solo encrypted SQLite startup and the existing connector
OAuth boundaries.

## Batch 7A: Backend Contract And Local Sync Skeleton

Deliverables:

- Add Convex app/schema/function scaffold behind missing-config gates.
- Configure Clerk JWT validation for Convex using documented Clerk issuer
  settings, with local tests/mocks and no live credentials required.
- Add local SQLite migrations/repositories for:
  - `cloud_workspace_link`;
  - `cloud_sync_cursor`;
  - `cloud_mutation_outbox`;
  - `cloud_record_shadow`;
  - `cloud_conflict`.
- Add the Rust command boundary for cloud sync status, device link state,
  enqueue shared mutation, flush outbox, and pull after cursor.
- Add explicit sync allowlists and denied-record tests.
- Add Convex policy tests for no-auth, wrong workspace, wrong org, wrong role,
  revoked device, stale revision, tombstone resurrection, and idempotency replay.

Exit criteria:

- App starts and local solo features work with no Clerk/Convex config.
- With test config/mocks, a shared workspace can be represented locally and an
  outbox mutation can be accepted/rejected deterministically.
- No connector credentials, permits, local model prompts, or raw connector
  responses can enter the sync writer.

## Batch 7B: Product Vertical Slice

Deliverables:

- Add UI to create/join a shared workspace only when Clerk and Convex are
  configured and identity is signed in.
- Link the current device and show linked/stale/revoked sync states.
- Sync one low-risk collaboration record end to end, preferably shared
  workspace/project/thread/message metadata.
- Show pending, accepted, rejected, and conflict states in the local UI.
- Subscribe to Convex realtime updates and recover missed updates through the
  cursor pull.
- Add tombstone delete for the selected record type.
- Add export/unlink behavior that keeps credentials and private local data out
  of the shared archive path.

Exit criteria:

- Two clients using the same test Convex deployment can see an accepted shared
  record update.
- Offline queued mutation flushes once and only once after reconnect.
- Role/device revocation blocks future flush.
- Solo workspace behavior is unchanged when cloud config is missing.

## Batch 7C: Hardening Before External Users

Deliverables:

- Live Clerk development instance validation for claim shape, audience,
  authorized party, org selection, refresh, sign-out, and revoked-session
  behavior.
- Live Convex development deployment validation for auth, functions, indexes,
  realtime, and export.
- Platform keyring CI for identity/device storage where available.
- Cloud sync observability that redacts ids and never logs payloads.
- Security review focused on cross-tenant isolation, sync allowlists,
  idempotency, tombstones, and object URL handling.

Non-goals:

- Do not deploy the confidential OAuth broker as part of Batch 7.
- Do not move Google OAuth behind the broker.
- Do not sync credentials, raw connector payloads, local model prompts, or
  approval permits.
- Do not add D1 as a parallel team database.
