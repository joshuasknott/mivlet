# Product-spine migration strategy

**Status:** Wave 0B migration design. This is an implementation plan for Wave
0C, not evidence that the legacy stores now conform.

## Decisions and boundary

The accepted ontology, identity-tenancy ADR, and record-authority matrix remain
normative: Fable owns internal users, workspaces, memberships and authorization;
Clerk supplies external identity and sessions only; a workspace is the sole hard
tenancy boundary; records retain their assigned local or Convex authority. A
schedule is a Routine time trigger, a connector is a definition, and a
Connection is the authorized instance. No migration uploads local content merely
because a member signs in or joins a workspace. Credentials, approval permits,
private keys, and raw tokens never enter canonical records, sync payloads, or
portable archives.

The Wave 0B parity guard covers the product-spine contract/schema version,
exported array vocabularies, and explicitly registered numeric limits only. It
does not generate Rust structures, validate every TypeScript field against
Serde, or prove SQLite/Convex adapters conform. Those adapters get per-family
serialization and isolation tests in Wave 0C.

Open implementation choices are deliberately not settled here: the bootstrap
transaction/idempotency boundary across Convex and devices; offline grace
duration; invitation-recipient proof; identity-recovery evidence; selected
workspace persistence; retention/deletion policy; and the exact conflict merge
rules for each shared record family.

## Migration rules

1. Add canonical tables/fields, indexes, authority markers, and compatibility
   readers before moving data. Every step is idempotent, observable and records
   a source ID, source version, target ID, checksum, timestamp, and outcome.
2. Resolve Fable internal user, workspace, active membership and record
   authority before copying an authority-bearing record. Never infer them from
   display name, email, selected workspace, or a Clerk Organization claim.
3. Backfill in bounded batches. Invalid, ambiguous, duplicate, cross-workspace,
   malformed, or secret-bearing records go to an encrypted quarantine ledger;
   they are not merged, silently repaired, or deleted.
4. Compatibility readers may read an unmigrated legacy source after a canonical
   miss, but they are read-only. Each record has one persisted authority marker
   and exactly one writer. Cutover changes that marker atomically; dual writes
   are prohibited.
5. Before cutover, retain immutable source snapshots or export checkpoints and
   a reverse mapping. Rollback changes the read/write selector back only after
   stopping the new writer and reconciling canonical writes; it never replays a
   mutation into both stores.
6. Every conversion preserves IDs where safe, revisions, timestamps, tombstones,
   idempotency receipts, audit provenance, content hashes and explicit lineage.
   It never treats a legacy provider account, organization, queue lease, or
   workflow graph as portable authority.

## Family map and cutover requirements

| Legacy family | Canonical target and prerequisites | Backfill/cutover/rollback evidence |
| --- | --- | --- |
| Clerk subject, user profile, org fields; default local workspace | `InternalUserRecord`, external identity link, `WorkspaceRecord`, owner membership/device link. Verify provider+issuer+subject uniqueness; organization is temporary provenance only. | Quarantine duplicate subjects and unmatched `default` data. Provision one workspace explicitly, then move scoped data only after membership exists. Revert selection to legacy scope while mappings remain; never make an org or email live authority. |
| Project-required threads and legacy workspace/project ownership | Workspace-owned thread with optional project association. Workspace, membership, visibility and authority must exist first. | Preserve thread/project IDs; unassigned threads become standalone rather than gaining a synthetic project. Test cross-workspace reads, project removal, and rollback of the ownership marker. |
| `connector_account`, `backend_connection`, provider runtime, connector cache | `Connection`, `ProviderRoute`, capability implementation/provenance, and `CapabilityGrant`. External account identity is display/audit provenance, never a Fable user. | Copy only secret-free metadata and secure-store binding references; leave tokens where they are. Compatibility reads continue until health/auth/capability tests pass. Revert the selector, not credentials. |
| Goals and plans | Goal stays a workspace record; legacy plans become `MissionPlan`/`PlanRevision` only when their context and revision history can be represented. | Preserve unmappable plan payload as legacy provenance and do not fabricate dynamic workers. Test goal-only, plan revision, and failed conversion quarantine paths. |
| Agent runs, workflow runs, checkpoints and artifacts produced by runs | `Run`, append-only `RunEvent`, optional `Worker`, `Artifact`/`ArtifactVersion`; run initiation and workspace must be explicit. | Convert history without inventing missing events; preserve raw safe evidence references. Queue/lease/permit state remains driver-local and is recovered, not exported. Test event sequencing, idempotency, interrupted-run recovery and artifact lineage. |
| Existing artifacts and portable attachments | Versioned Artifact with content hash, provenance, contextual links and retention state. | Copy content only under its existing authority and size policy. Invalid locators/content hashes quarantine. Test export/import round trips and no hidden context, grant or approval transfer. |
| `AutomationRule`, `ScheduleEntry`, schedule, `ScheduledJob`, workflow definitions/runs, scheduler queue | `Routine`, immutable `RoutineVersion`, `RoutineTrigger`, occurrence history and a Run. Time schedules become `time-once`/`time-recurring`; definitions may use `workflow-compatibility` only temporarily. | Pause or lease-fence a legacy scheduler before marking a routine writer canonical. Preserve next-fire and missed-run semantics; never import leases/fencing tokens as product records. Roll back by restoring the one scheduler selector after reconciling occurrences. Test each source kind, deduplication, retries, approvals, blocked auth and no mandatory route pin. |
| Convex project-only sync, local outbox/cursors/shadows/conflicts/tombstones | Authority-matrix shared records plus workspace/internal-user/device attribution, cursor and tombstone envelopes. | Add composite workspace predicates and reauthorize queued writes at flush. Existing project-only rows remain compatibility input. Test rejected cross-workspace operations, cursor replay, conflict quarantine, tombstone propagation and revocation before flush. |
| Portable archives/imports | Versioned canonical archive sections plus legacy section adapters. | Export canonical and legacy provenance only; imports validate authority/membership and create no automatic cloud upload. Credentials and local-only paths are excluded. Test downgrade/read compatibility, interrupted import, collision quarantine and recovery from an export checkpoint. |

## Ordered Wave 0C sequence

1. Introduce migration ledger/quarantine, authority marker, compatibility-reader
   framework, and fixture corpus. Do not change current writers.
2. Create internal users, external links, workspaces, memberships and device
   links; migrate Clerk/default-workspace metadata and prove adversarial tenant
   isolation.
3. Add explicit workspace ownership to threads, projects, goals, approvals,
   knowledge/memory, runs and artifacts. Migrate standalone threads without
   projects.
4. Move connection/account/runtime metadata and capability-grant policy while
   keeping credential custody unchanged.
5. Migrate mission/run/artifact history, then routine/trigger definitions and
   occurrences. Fence the affected scheduler before each one-writer cutover.
6. Align Convex records, outbox, cursor, shadow, conflict and tombstone
   envelopes to the authority matrix; enable only assigned shared records.
7. Version portable export/import around the new records and run recovery,
   cross-workspace and no-secret round trips.
8. Remove compatibility readers and legacy tables only after the removal gates
   below are met and a documented recovery window has elapsed.

## Parallel and collision boundaries

Safe parallel work after a frozen contract snapshot: pure protocol validation,
fixtures, adapter serialization tests, Convex policy tests, and migration-ledger
reporting. Keep serial ownership for identity/tenancy; connector-account to
Connection; thread/project scope; schema/migrations; `portable.rs`; cloud-sync
repositories; and routine/scheduler cutover. A scheduler extraction can proceed
only outside the same files/steps as the user-facing routine migration. Any
change to `schema.rs`, migrations, portable archives, outbox/cursors/shadows,
or authority selection has one named owner per rollout step.

## Tests, rollback and removal gates

Each family requires fixtures for valid conversion, idempotent replay, malformed
input, ambiguous ownership, cross-workspace rejection, interrupted batch,
rollback, tombstone/deletion, and export/import where portable. Connection tests
also prove credentials remain in their existing custody; routine tests prove
one execution per occurrence; identity tests cover duplicate bootstrap,
invitation hijack, revoked member/device and recovery.

Cutover is reversible only while the source snapshot, reverse mapping,
compatibility reader, and observed reconciliation report remain available.
Recovery resumes from the ledger checkpoint and repeats only incomplete source
records. Remove a legacy reader/table only when all records are accounted for
(migrated or explicitly quarantined), canonical and source counts/checksums
reconcile, parity and adapter tests pass, cross-workspace negatives pass,
portable round trips pass, a rollback drill succeeds, the minimum product path
passes, and the recovery/retention owner approves removal.
