//! Schema and data migrations for the durable store.
//!
//! See `docs/architecture/encrypted-storage.md`.
//!
//! - **Schema migrations** ([`apply`]) run forward-only step functions keyed by
//!   version, inside the migration transaction. v1 DDL is applied by
//!   [`crate::store::schema`]; this module owns v→v+1 steps for future versions.
//!
//! Pre-v37 JSON ingestion was retired after the schema-v37, recovery-backup,
//! portable-transfer, foreign-key, and restart fixtures passed. Forward SQLite
//! migrations remain data preserving and are the only startup migration path.

use rusqlite::Connection;

pub(crate) mod local_events;

/// Apply forward schema migrations from `from` → `to` (inclusive of `to`).
///
/// v1 DDL is created by [`crate::store::schema::SCHEMA_V1`] before this runs,
/// so for a fresh database `from == 0` and `to == 1` is a no-op here (the
/// tables already exist). Future versions register a step closure for each
/// `from → from+1` boundary.
pub fn apply(conn: &Connection, from: u32, to: u32) -> super::Result<()> {
    let mut current = from;
    while current < to {
        match current {
            // 0 → 1: tables already created by SCHEMA_V1; nothing more to do.
            0 => {}
            // 1 → 2: add the connector-cache tables. Fresh databases already
            // have them through SCHEMA_V1; existing v1 databases receive them
            // through the idempotent SCHEMA_V1_TO_V2 delta.
            1 => conn.execute_batch(crate::store::schema::SCHEMA_V1_TO_V2)?,
            // 2 → 3: extend audit_event with non-secret query columns for the
            // inspectable action-history surface. Fresh databases already have
            // the columns through SCHEMA_V1; existing v2 databases receive them
            // through SCHEMA_V2_TO_V3. SQLite lacks `ADD COLUMN IF NOT EXISTS`,
            // so the step probes for the `category` column and only runs the
            // ALTER batch when it is absent (idempotent over a partial apply).
            2 => apply_v2_to_v3(conn)?,
            // 3 → 4: introduce the workspace ownership root, attach legacy
            // user-owned records to the compatibility workspace, and create
            // the workflow hand-off tables, then add the durable scheduler
            // tables from the schedule-SQLite integration.
            3 => apply_v3_to_v4(conn)?,
            // 4 → 5: make knowledge/memory identities workspace-composite,
            // add durable lifecycle columns and workspace-bound dependencies.
            4 => apply_v4_to_v5(conn)?,
            // 5 → 6: add a plaintext `search_text` column to connector_cache so
            // lexical search filters via SQL LIKE without decrypting payloads.
            // Existing rows are backfilled lazily by the store on first read.
            5 => apply_v5_to_v6(conn)?,
            // 6 -> 7: add local cloud-team sync cache/outbox tables.
            6 => apply_v6_to_v7(conn)?,
            // 7 -> 8: replace the Clerk-organization-shaped local sync cache
            // with Mivlet-owned identity, membership, workspace, and device
            // mirrors. The SQL rebuild is data-preserving and runs inside the
            // Store migration transaction.
            7 => apply_v7_to_v8(conn)?,
            // 8 -> 9: add the per-internal-user hosted workspace selection.
            // The historical local `default` workspace remains untouched.
            8 => apply_v8_to_v9(conn)?,
            // 9 -> 10: retain secret-free hosted account-device observations.
            9 => apply_v9_to_v10(conn)?,
            // 10 -> 11: conversations become explicitly workspace-owned and
            // receive immutable revision checkpoints. Existing project-bound
            // rows derive their owner through project; no synthetic project is
            // ever created.
            10 => apply_v10_to_v11(conn)?,
            // 11 -> 12: provider connections become account-owned. Legacy
            // provider-only rows cannot be safely attributed and are retained
            // in an inaccessible quarantine table instead of being guessed.
            11 => apply_v11_to_v12(conn)?,
            // 12 -> 13: projects gain explicit local authority, member-private
            // ownership, optimistic revisions, lifecycle, and durable delete
            // tombstones. Existing encrypted payloads and ids are retained.
            12 => apply_v12_to_v13(conn)?,
            // 13 -> 14: add canonical local/member-private goals. Legacy
            // snapshot goals are deliberately not guessed into authority.
            13 => apply_v13_to_v14(conn)?,
            // 14 -> 15: Knowledge and Memory become explicitly owned by the
            // authenticated member (or stable local internal-user subject).
            // Only project rows with a provable private owner are adopted;
            // ambiguous rows and opaque documents are quarantined.
            14 => apply_v14_to_v15(conn)?,
            // 15 -> 16: artifacts gain an authenticated private owner and
            // immutable owner-bound version history. Legacy ciphertext cannot
            // be safely rebound to an owner, so it remains quarantined.
            15 => apply_v15_to_v16(conn)?,
            // 16 -> 17: normalized, owner-qualified encrypted artifact review
            // history linked to exact immutable versions.
            16 => apply_v16_to_v17(conn)?,
            // 17 -> 18: exact-version, owner-qualified artifact handoffs.
            17 => apply_v17_to_v18(conn)?,
            // 18 -> 19: establish the canonical Connection storage boundary.
            // Legacy connector-account metadata remains the compatibility
            // source because it has no authenticated creator; only a stable,
            // secret-free proposed identity is recorded for later adoption.
            18 => apply_v18_to_v19(conn)?,
            // 19 -> 20: persist the exact active Connection per connector in
            // the authenticated canonical store. Legacy active flags are not
            // guessed into authority by the migration.
            19 => apply_v19_to_v20(conn)?,
            // 20 -> 21: persist secret-free semantic capability implementation
            // observations. Evidence never grants authority and is usable only
            // while its exact canonical Connection revision remains current.
            20 => apply_v20_to_v21(conn)?,
            // 21 -> 22: add encrypted, member-private launch configuration for
            // local STDIO MCP servers. Migration creates no launch authority.
            21 => apply_v21_to_v22(conn)?,
            // 22 -> 23: add explicit, owner-qualified capability grants. The
            // migration creates no implicit authority or inferred rows.
            22 => apply_v22_to_v23(conn)?,
            // 23 -> 24: persist member-private missions and immutable generated
            // plan revisions. No mission or execution authority is inferred.
            23 => apply_v23_to_v24(conn)?,
            // 24 -> 25: add the encrypted append-only mission run journal.
            // Migration creates no runs, checkpoints, or execution authority.
            24 => apply_v24_to_v25(conn)?,
            // 25 -> 26: persist redacted checkpoint state separately from the
            // immutable checkpoint event. No checkpoint is inferred.
            25 => apply_v25_to_v26(conn)?,
            // 26 -> 27: persist immutable encrypted mission-worker output
            // receipts linked to exact completion events. No output is inferred.
            26 => apply_v26_to_v27(conn)?,
            // 27 -> 28: persist immutable encrypted mission-worker tool-result
            // receipts linked to exact run events. No tool result is inferred.
            27 => apply_v27_to_v28(conn)?,
            // 28 -> 29: persist bounded encrypted provider-route observations.
            // Migration creates no inferred performance evidence.
            28 => apply_v28_to_v29(conn)?,
            // 29 -> 30: persist bounded encrypted route-quality observations
            // derived only from native policy evaluation. No quality is inferred.
            29 => apply_v29_to_v30(conn)?,
            // 30 -> 31: bind only policy-accepted mission output to its exact
            // canonical artifact/version. Migration infers no artifacts.
            30 => apply_v30_to_v31(conn)?,
            // 31 -> 32: establish unambiguous legacy thread ownership and bind
            // canonical draft artifacts materialized directly from exact local
            // mission events. Migration infers neither owners nor artifacts when
            // their source facts are ambiguous.
            31 => apply_v31_to_v32(conn)?,
            // 32 -> 33: add empty canonical Routine, migration-evidence, and
            // scheduler-authority stores. No owner or execution authority is
            // inferred from legacy records.
            32 => conn.execute_batch(crate::store::schema::SCHEMA_V32_TO_V33)?,
            // 33 -> 34: add the empty node-local Routine trigger cursor. The
            // selected writer initializes cursor evidence; migration does not
            // invent a last-evaluated instant.
            33 => conn.execute_batch(crate::store::schema::SCHEMA_V33_TO_V34)?,
            // 34 -> 35: add an empty encrypted Mission approval-consumption
            // ledger. Migration creates no approval or execution authority.
            34 => conn.execute_batch(crate::store::schema::SCHEMA_V34_TO_V35)?,
            // 35 -> 36: repair the historical v10 conversation migration's
            // renamed thread foreign key on agent runs. No rows or authority
            // are inferred; the run table is rebuilt only when the dangling
            // `thread_v10` reference is present.
            35 => apply_v35_to_v36(conn)?,
            // 36 -> 37: repair any run-dependent table names rewritten by the
            // original v35 -> v36 parent rebuild. Remaining rows and every
            // child relationship are copied exactly; no authority is inferred.
            36 => apply_v36_to_v37(conn)?,
            // 37 -> 38: retire the orchestration-era mission, routine,
            // scheduler, workflow, artifact, and unused run-state stores.
            37 => {
                conn.execute_batch(crate::store::schema::RETIRED_ORCHESTRATION_STORAGE_CLEANUP)?
            }
            // 38 -> 39: provider credentials are owned by the stable local
            // installation principal, so their metadata must not require an
            // optional hosted-account mirror row. Existing connections and
            // their observation children are copied exactly.
            38 => apply_v38_to_v39(conn)?,
            // 39 -> 40: add empty member-private local schedule and occurrence
            // stores. No retired orchestration data or execution authority is
            // inferred by this migration.
            39 => conn.execute_batch(crate::store::schema::SCHEMA_V39_TO_V40)?,
            // 40 -> 41: add empty member-private shared project rooms and their
            // run-author ledger. Legacy project rows are deliberately ignored.
            40 => conn.execute_batch(crate::store::schema::SCHEMA_V40_TO_V41)?,
            41 => conn.execute_batch(crate::store::schema::SCHEMA_V41_TO_V42)?,
            // 42 -> 43: preserve the linear transcript while recording
            // explicit branch parents and the selected visible head.
            42 => apply_v42_to_v43(conn)?,
            // 43 -> 44: add empty encrypted, account-owned output documents
            // and immutable revision history. No output is inferred from old
            // artifact receipts; outputs are adopted explicitly when opened.
            43 => conn.execute_batch(crate::store::schema::SCHEMA_V43_TO_V44)?,
            44 => conn.execute_batch(crate::store::schema::SCHEMA_V44_TO_V45)?,
            other => {
                return Err(super::StoreError::Invalid(format!(
                    "No migration step registered from schema v{other}."
                )));
            }
        }
        current += 1;
    }
    let _ = (conn, to); // schema step closures land here in future versions
    Ok(())
}

mod capabilities;
mod helpers;
mod ownership;
mod repairs;
#[cfg(test)]
mod tests;

use capabilities::{
    apply_v10_to_v11, apply_v11_to_v12, apply_v12_to_v13, apply_v13_to_v14, apply_v14_to_v15,
    apply_v15_to_v16, apply_v16_to_v17, apply_v17_to_v18, apply_v18_to_v19, apply_v19_to_v20,
    apply_v20_to_v21, apply_v21_to_v22, apply_v22_to_v23, apply_v23_to_v24, apply_v24_to_v25,
    apply_v25_to_v26, apply_v26_to_v27, apply_v27_to_v28, apply_v28_to_v29, apply_v29_to_v30,
    apply_v30_to_v31, apply_v31_to_v32,
};
use ownership::{
    apply_v2_to_v3, apply_v3_to_v4, apply_v4_to_v5, apply_v5_to_v6, apply_v6_to_v7, apply_v7_to_v8,
    apply_v8_to_v9, apply_v9_to_v10,
};
use repairs::{apply_v35_to_v36, apply_v36_to_v37, apply_v38_to_v39, apply_v42_to_v43};
