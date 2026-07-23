//! Durable, encrypted application of deterministic legacy Routine plans.
//!
//! The TypeScript planner remains a pure classifier. This repository binds its
//! output to the authenticated native owner, hashes the exact evidence and
//! plan, writes canonical records and decision ledgers atomically, and retains
//! the exact created identities needed for replay verification and rollback.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::routine::{self, RoutineBundleRow};
use crate::store::repos::scope::{normalize_id, DataScope, PrivateDataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBatchSummary {
    pub id: String,
    pub input_hash: String,
    pub plan_hash: String,
    pub status: String,
    pub planned_at: String,
    pub applied_at: Option<String>,
    pub rolled_back_at: Option<String>,
    pub candidate_count: usize,
    pub occurrence_count: usize,
    pub quarantine_count: usize,
}

fn hash(value: &Value) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        StoreError::Invalid("Routine migration evidence could not be encoded.".into())
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn migration_input_hash(evidence: &Value) -> Result<String> {
    let sources = evidence
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Native migration source evidence is required.".into())
        })?;
    let mut sources = sources.clone();
    sources.sort_by(|left, right| {
        source_key(left)
            .unwrap_or_default()
            .cmp(&source_key(right).unwrap_or_default())
    });
    let pinned_route_evidence = evidence
        .get("pinnedRouteEvidence")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    hash(&serde_json::json!({
        "sources":sources,
        "pinnedRouteEvidence":pinned_route_evidence
    }))
}

fn required_text<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 16_384)
        .ok_or_else(|| StoreError::Invalid(format!("{label} is required.")))
}

fn source_key(source: &Value) -> Result<String> {
    let kind = required_text(source, "kind", "Legacy source kind")?;
    let id = required_text(source, "legacyId", "Legacy source id")?;
    let schema = source
        .get("legacySchemaVersion")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1)
        .ok_or_else(|| StoreError::Invalid("Legacy source schema version is invalid.".into()))?;
    let checksum = required_text(source, "checksum", "Legacy source checksum")?;
    if !checksum.starts_with("sha256:") || checksum.len() != 71 {
        return Err(StoreError::Invalid(
            "Legacy source checksum must be an exact SHA-256 reference.".into(),
        ));
    }
    Ok(format!("{kind}\u{0}{id}\u{0}{schema}"))
}

fn candidate_for<'a>(plan: &'a Value, routine_id: &str) -> Option<&'a Value> {
    plan.get("candidates")?
        .as_array()?
        .iter()
        .find(|candidate| {
            candidate.pointer("/routine/id").and_then(Value::as_str) == Some(routine_id)
        })
}

fn owner_matches(
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    value: &Value,
) -> bool {
    value.get("workspaceId").and_then(Value::as_str) == Some(scope.workspace_id())
        && value.get("visibility").and_then(Value::as_str) == Some("member-private")
        && value.get("ownerMemberId").and_then(Value::as_str) == private.owner_member_id()
        && value.get("createdByInternalUserId").and_then(Value::as_str) == Some(internal_user_id)
        && value.get("projectId").and_then(Value::as_str) == scope.project_id()
}

#[allow(clippy::too_many_arguments)]
pub fn apply(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    batch_id: &str,
    evidence: &Value,
    plan: &Value,
    applied_at: &str,
) -> Result<MigrationBatchSummary> {
    scope.ensure_exists(tx)?;
    let batch_id = normalize_id(batch_id, "Routine migration batch")?;
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let planned_at = required_text(plan, "plannedAt", "Routine migration planned time")?;
    if evidence.get("plannedAt").and_then(Value::as_str) != Some(planned_at) {
        return Err(StoreError::Invalid(
            "Routine migration evidence and deterministic plan use different clocks.".into(),
        ));
    }
    // Capture time is evidence metadata, not source identity. Re-capturing the
    // same encrypted native records must find the original batch rather than
    // manufacture collisions merely because the clock advanced.
    let input_hash = migration_input_hash(evidence)?;
    let plan_hash = hash(plan)?;
    if let Some(existing) = find_by_input_hash(
        tx,
        store,
        scope.workspace_id(),
        private.owner_subject(),
        &input_hash,
    )? {
        if existing.planned_at == planned_at && existing.plan_hash != plan_hash {
            return Err(StoreError::Invalid(
                "The same migration evidence produced a different plan.".into(),
            ));
        }
        return Ok(existing);
    }
    if tx
        .query_row(
            "SELECT input_hash FROM routine_migration_batch
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
            rusqlite::params![scope.workspace_id(), private.owner_subject(), batch_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some()
    {
        return Err(StoreError::Invalid(
            "Routine migration batch identity is already bound to different evidence.".into(),
        ));
    }

    let _candidates = plan
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Routine migration candidates are required.".into()))?;
    let occurrences = plan
        .get("occurrences")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Routine migration occurrences are required.".into()))?;
    let classifications = plan
        .get("classifications")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Routine migration classifications are required.".into())
        })?;
    let evidence_sources = evidence
        .get("sources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Native migration source evidence is required.".into())
        })?;
    let mut captured = BTreeMap::new();
    for source in evidence_sources {
        let key = source_key(source)?;
        let checksum = required_text(source, "checksum", "Legacy source checksum")?;
        let record = source
            .get("record")
            .ok_or_else(|| StoreError::Invalid("Legacy source record is required.".into()))?;
        if hash(record)? != checksum {
            return Err(StoreError::Invalid(
                "Legacy source checksum does not match its encrypted native snapshot.".into(),
            ));
        }
        if source
            .pointer("/repositoryScope/workspaceId")
            .and_then(Value::as_str)
            != Some(scope.workspace_id())
            || source
                .pointer("/repositoryScope/projectId")
                .and_then(Value::as_str)
                != scope.project_id()
            || source.pointer("/ownership/status").and_then(Value::as_str) != Some("proven")
            || source
                .pointer("/ownership/workspaceId")
                .and_then(Value::as_str)
                != Some(scope.workspace_id())
            || source
                .pointer("/ownership/projectId")
                .and_then(Value::as_str)
                != scope.project_id()
            || source
                .pointer("/ownership/visibility")
                .and_then(Value::as_str)
                != Some("member-private")
            || source
                .pointer("/ownership/ownerMemberId")
                .and_then(Value::as_str)
                != private.owner_member_id()
            || source
                .pointer("/ownership/createdByInternalUserId")
                .and_then(Value::as_str)
                != Some(actor.as_str())
        {
            return Err(StoreError::Invalid(
                "Legacy migration evidence does not match the authenticated native scope.".into(),
            ));
        }
        if captured.insert(key, checksum.to_string()).is_some() {
            return Err(StoreError::Invalid(
                "Native migration evidence contains a duplicate source identity.".into(),
            ));
        }
    }
    let mut classified = BTreeSet::new();
    for classification in classifications {
        let source = classification.get("source").ok_or_else(|| {
            StoreError::Invalid("Migration classification source is required.".into())
        })?;
        let key = source_key(source)?;
        let checksum = required_text(source, "checksum", "Legacy source checksum")?;
        if captured.get(&key).map(String::as_str) != Some(checksum) || !classified.insert(key) {
            return Err(StoreError::Invalid(
                "Migration plan is not an exact one-to-one replay of native source evidence."
                    .into(),
            ));
        }
    }
    if classified.len() != captured.len() {
        return Err(StoreError::Invalid(
            "Migration plan omitted native source evidence.".into(),
        ));
    }

    let initial_payload = serde_json::json!({
        "inputHash":input_hash,
        "planHash":plan_hash,
        "authenticatedInternalUserId":actor,
        "evidence":evidence,
        "plan":plan,
        "createdRoutineIds":[],
        "createdOccurrenceIds":[]
    });
    let sealed = seal_json(
        store,
        &initial_payload,
        &batch_aad(scope.workspace_id(), private.owner_subject(), &batch_id),
    )?;
    tx.execute(
        "INSERT INTO routine_migration_batch(workspace_id,owner_subject,id,input_hash,planned_at,status,applied_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,?5,'applying',?6,?7,?8);",
        rusqlite::params![scope.workspace_id(),private.owner_subject(),batch_id,input_hash,planned_at,applied_at,sealed.ciphertext,sealed.nonce],
    )?;

    let mut created_routine_ids = Vec::new();
    for classification in classifications {
        let source = classification.get("source").ok_or_else(|| {
            StoreError::Invalid("Migration classification source is required.".into())
        })?;
        let key = source_key(source)?;
        let checksum = required_text(source, "checksum", "Legacy source checksum")?;
        let mut disposition =
            required_text(classification, "disposition", "Migration disposition")?.to_string();
        let mut reason = classification
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let canonical_id = classification
            .get("canonicalRoutineId")
            .and_then(Value::as_str)
            .map(str::to_string);

        if let Some(routine_id) = canonical_id.as_deref() {
            let candidate = candidate_for(plan, routine_id).ok_or_else(|| {
                StoreError::Invalid(
                    "Migration candidate classification has no exact candidate.".into(),
                )
            })?;
            let routine_value = candidate.get("routine").ok_or_else(|| {
                StoreError::Invalid("Migration candidate Routine is missing.".into())
            })?;
            if !owner_matches(scope, private, &actor, routine_value) {
                return Err(StoreError::Invalid(
                    "Migration candidate does not match authenticated ownership evidence.".into(),
                ));
            }
            let existing = routine::get(tx, store, scope, private, routine_id)?;
            if let Some(existing) = existing {
                if !same_candidate(&existing, candidate) {
                    disposition = "quarantined".into();
                    reason = Some("canonical-id-collision".into());
                }
            } else if disposition == "candidate" {
                let version = candidate.get("version").ok_or_else(|| {
                    StoreError::Invalid("Migration candidate version is missing.".into())
                })?;
                let trigger = candidate.get("trigger").ok_or_else(|| {
                    StoreError::Invalid("Migration candidate trigger is missing.".into())
                })?;
                routine::create(
                    tx,
                    store,
                    scope,
                    private,
                    &actor,
                    routine_value,
                    version,
                    std::slice::from_ref(trigger),
                )?;
                created_routine_ids.push(routine_id.to_string());
            }
        }

        let source_payload = serde_json::json!({
            "source":source,
            "classification":classification,
            "effectiveDisposition":disposition,
            "effectiveReason":reason
        });
        let source_sealed = seal_json(
            store,
            &source_payload,
            &source_aad(
                scope.workspace_id(),
                private.owner_subject(),
                &batch_id,
                &key,
            ),
        )?;
        tx.execute(
            "INSERT INTO routine_migration_source(workspace_id,owner_subject,batch_id,source_key,checksum,disposition,canonical_routine_id,payload,payload_nonce)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9);",
            rusqlite::params![scope.workspace_id(),private.owner_subject(),batch_id,key,checksum,disposition,canonical_id,source_sealed.ciphertext,source_sealed.nonce],
        )?;
        if disposition == "quarantined" {
            let reason = reason.unwrap_or_else(|| "unclassified-ambiguity".into());
            let quarantine_sealed = seal_json(
                store,
                &source_payload,
                &quarantine_aad(
                    scope.workspace_id(),
                    private.owner_subject(),
                    &batch_id,
                    &key,
                ),
            )?;
            tx.execute(
                "INSERT INTO routine_migration_quarantine(workspace_id,owner_subject,batch_id,source_key,reason,decided_at,payload,payload_nonce)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8);",
                rusqlite::params![scope.workspace_id(),private.owner_subject(),batch_id,key,reason,applied_at,quarantine_sealed.ciphertext,quarantine_sealed.nonce],
            )?;
        }
    }

    let mut created_occurrence_ids = Vec::new();
    for occurrence in occurrences {
        let routine_id = required_text(occurrence, "routineId", "Occurrence Routine")?;
        let quarantined: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM routine_migration_source
             WHERE workspace_id=?1 AND owner_subject=?2 AND batch_id=?3
               AND canonical_routine_id=?4 AND disposition='quarantined');",
            rusqlite::params![
                scope.workspace_id(),
                private.owner_subject(),
                batch_id,
                routine_id
            ],
            |row| row.get(0),
        )?;
        if quarantined {
            continue;
        }
        let before: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM routine_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND deduplication_key=?3);",
            rusqlite::params![
                scope.workspace_id(),
                private.owner_subject(),
                required_text(
                    occurrence,
                    "deduplicationKey",
                    "Occurrence deduplication key"
                )?
            ],
            |row| row.get(0),
        )?;
        routine::append_occurrence(tx, store, scope, private, occurrence)?;
        if !before {
            created_occurrence_ids
                .push(required_text(occurrence, "id", "Occurrence id")?.to_string());
        }
    }

    let final_payload = serde_json::json!({
        "inputHash":input_hash,
        "planHash":plan_hash,
        "authenticatedInternalUserId":actor,
        "evidence":evidence,
        "plan":plan,
        "createdRoutineIds":created_routine_ids,
        "createdOccurrenceIds":created_occurrence_ids
    });
    let final_sealed = seal_json(
        store,
        &final_payload,
        &batch_aad(scope.workspace_id(), private.owner_subject(), &batch_id),
    )?;
    tx.execute(
        "UPDATE routine_migration_batch
         SET status='applied',payload=?1,payload_nonce=?2
         WHERE workspace_id=?3 AND owner_subject=?4 AND id=?5 AND status='applying';",
        rusqlite::params![
            final_sealed.ciphertext,
            final_sealed.nonce,
            scope.workspace_id(),
            private.owner_subject(),
            batch_id
        ],
    )?;
    summary(
        tx,
        store,
        scope.workspace_id(),
        private.owner_subject(),
        &batch_id,
    )?
    .ok_or_else(|| StoreError::Invalid("Routine migration batch disappeared.".into()))
}

pub fn verify_replay(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    batch_id: &str,
    evidence: &Value,
    plan: &Value,
) -> Result<MigrationBatchSummary> {
    let batch_id = normalize_id(batch_id, "Routine migration batch")?;
    let batch = summary(
        tx,
        store,
        scope.workspace_id(),
        private.owner_subject(),
        &batch_id,
    )?
    .ok_or_else(|| StoreError::Invalid("Routine migration batch was not found.".into()))?;
    if batch.input_hash != migration_input_hash(evidence)? || batch.plan_hash != hash(plan)? {
        return Err(StoreError::Invalid(
            "Routine migration replay does not match its retained evidence.".into(),
        ));
    }
    Ok(batch)
}

pub fn rollback(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    batch_id: &str,
    rolled_back_at: &str,
) -> Result<MigrationBatchSummary> {
    let batch_id = normalize_id(batch_id, "Routine migration batch")?;
    let authority = routine::scheduler_authority(tx, store, scope.workspace_id(), rolled_back_at)?;
    if authority.writer != "legacy" || !matches!(authority.phase.as_str(), "legacy" | "shadow") {
        return Err(StoreError::Invalid(
            "Routine migration rollback requires the legacy scheduler to remain the fenced writer."
                .into(),
        ));
    }
    let sealed = tx
        .query_row(
            "SELECT payload,payload_nonce FROM routine_migration_batch
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3 AND status='applied';",
            rusqlite::params![scope.workspace_id(), private.owner_subject(), batch_id],
            |row| {
                Ok(Sealed {
                    ciphertext: row.get(0)?,
                    nonce: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::Invalid("Applied Routine migration batch was not found.".into())
        })?;
    let payload = open_json(
        store,
        &sealed,
        &batch_aad(scope.workspace_id(), private.owner_subject(), &batch_id),
    )?;
    let occurrence_ids = payload
        .get("createdOccurrenceIds")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Migration rollback evidence is incomplete.".into()))?;
    for id in occurrence_ids {
        let id = id.as_str().ok_or_else(|| {
            StoreError::Invalid("Migration occurrence evidence is invalid.".into())
        })?;
        let driver_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM routine_driver_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND occurrence_id=?3);",
            rusqlite::params![scope.workspace_id(), private.owner_subject(), id],
            |row| row.get(0),
        )?;
        if driver_exists {
            return Err(StoreError::Invalid(
                "Migration rollback is blocked because a Routine occurrence reached the execution driver.".into(),
            ));
        }
        tx.execute(
            "DELETE FROM routine_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
            rusqlite::params![scope.workspace_id(), private.owner_subject(), id],
        )?;
    }
    let routine_ids = payload
        .get("createdRoutineIds")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Migration rollback evidence is incomplete.".into()))?;
    for id in routine_ids {
        let id = id
            .as_str()
            .ok_or_else(|| StoreError::Invalid("Migration Routine evidence is invalid.".into()))?;
        let changed = tx.execute(
            "DELETE FROM routine_record
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
               AND revision=1 AND current_version=1
               AND NOT EXISTS(
                 SELECT 1 FROM routine_occurrence o
                 WHERE o.workspace_id=routine_record.workspace_id
                   AND o.owner_subject=routine_record.owner_subject
                   AND o.routine_id=routine_record.id
               );",
            rusqlite::params![scope.workspace_id(), private.owner_subject(), id],
        )?;
        if changed != 1 {
            return Err(StoreError::Invalid(
                "Migration rollback is blocked because a migrated Routine changed or gained history.".into(),
            ));
        }
    }
    tx.execute(
        "UPDATE routine_migration_batch SET status='rolled-back',rolled_back_at=?1
         WHERE workspace_id=?2 AND owner_subject=?3 AND id=?4 AND status='applied';",
        rusqlite::params![
            rolled_back_at,
            scope.workspace_id(),
            private.owner_subject(),
            batch_id
        ],
    )?;
    summary(
        tx,
        store,
        scope.workspace_id(),
        private.owner_subject(),
        &batch_id,
    )?
    .ok_or_else(|| StoreError::Invalid("Routine migration batch disappeared.".into()))
}

fn same_candidate(existing: &RoutineBundleRow, candidate: &Value) -> bool {
    candidate.get("routine") == Some(&existing.routine)
        && candidate.get("version") == Some(&existing.current_version)
        && candidate
            .get("trigger")
            .is_some_and(|trigger| existing.triggers == [trigger.clone()])
}

fn find_by_input_hash(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    owner_subject: &str,
    input_hash: &str,
) -> Result<Option<MigrationBatchSummary>> {
    let id = tx
        .query_row(
            "SELECT id FROM routine_migration_batch
             WHERE workspace_id=?1 AND owner_subject=?2 AND input_hash=?3;",
            rusqlite::params![workspace_id, owner_subject, input_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.map(|id| summary(tx, store, workspace_id, owner_subject, &id))
        .transpose()
        .map(Option::flatten)
}

fn summary(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    owner_subject: &str,
    batch_id: &str,
) -> Result<Option<MigrationBatchSummary>> {
    let row = tx
        .query_row(
            "SELECT input_hash,planned_at,status,applied_at,rolled_back_at,payload,payload_nonce
             FROM routine_migration_batch
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
            rusqlite::params![workspace_id, owner_subject, batch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    Sealed {
                        ciphertext: row.get(5)?,
                        nonce: row.get(6)?,
                    },
                ))
            },
        )
        .optional()?;
    let Some((input_hash, planned_at, status, applied_at, rolled_back_at, sealed)) = row else {
        return Ok(None);
    };
    let payload = open_json(
        store,
        &sealed,
        &batch_aad(workspace_id, owner_subject, batch_id),
    )?;
    let candidate_count: i64 = tx.query_row(
        "SELECT COUNT(DISTINCT canonical_routine_id) FROM routine_migration_source
         WHERE workspace_id=?1 AND owner_subject=?2 AND batch_id=?3
           AND disposition='candidate' AND canonical_routine_id IS NOT NULL;",
        rusqlite::params![workspace_id, owner_subject, batch_id],
        |row| row.get(0),
    )?;
    let quarantine_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM routine_migration_quarantine
         WHERE workspace_id=?1 AND owner_subject=?2 AND batch_id=?3;",
        rusqlite::params![workspace_id, owner_subject, batch_id],
        |row| row.get(0),
    )?;
    Ok(Some(MigrationBatchSummary {
        id: batch_id.to_string(),
        input_hash,
        plan_hash: required_text(&payload, "planHash", "Migration plan hash")?.to_string(),
        status,
        planned_at,
        applied_at,
        rolled_back_at,
        candidate_count: candidate_count as usize,
        occurrence_count: payload
            .get("createdOccurrenceIds")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        quarantine_count: quarantine_count as usize,
    }))
}

fn batch_aad(workspace: &str, owner: &str, batch: &str) -> String {
    format!("routine_migration_batch:{workspace}:{owner}:{batch}")
}
fn source_aad(workspace: &str, owner: &str, batch: &str, source: &str) -> String {
    format!("routine_migration_source:{workspace}:{owner}:{batch}:{source}")
}
fn quarantine_aad(workspace: &str, owner: &str, batch: &str, source: &str) -> String {
    format!("routine_migration_quarantine:{workspace}:{owner}:{batch}:{source}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::workspace;
    use crate::store::vault::{MasterKey, Vault};

    fn fixture() -> (Store, DataScope, PrivateDataScope) {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store
            .transaction(|tx| {
                workspace::upsert(tx, "w1", "One", "2026-01-01T00:00:00Z")?;
                Ok(())
            })
            .unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-1", Some("member-1"))
                .unwrap();
        (store, scope, private)
    }

    fn evidence() -> Value {
        let record = serde_json::json!({"id":"job-1"});
        let checksum = hash(&record).unwrap();
        serde_json::json!({
            "plannedAt":"2026-01-01T12:00:00Z",
            "sources":[{
                "kind":"scheduled-job","legacyId":"job-1","legacySchemaVersion":1,
                "checksum":checksum,
                "repositoryScope":{"workspaceId":"w1"},
                "ownership":{"status":"proven","workspaceId":"w1","visibility":"member-private",
                    "ownerMemberId":"member-1","createdByInternalUserId":"user-1",
                    "evidenceReference":"native:snapshot:job-1"},
                "record":record
            }]
        })
    }

    fn plan() -> Value {
        let checksum = hash(&serde_json::json!({"id":"job-1"})).unwrap();
        let metadata = serde_json::json!({
            "workspaceId":"w1","authority":"local","schemaVersion":1,"revision":1,
            "visibility":"member-private","ownerMemberId":"member-1",
            "createdByInternalUserId":"user-1","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z"
        });
        let mut routine = serde_json::json!({
            "id":"routine-1","status":"active","title":"Daily",
            "currentVersion":1,"scope":{},"authorityPolicy":"no-expansion"
        });
        routine
            .as_object_mut()
            .unwrap()
            .extend(metadata.as_object().unwrap().clone());
        let mut trigger = serde_json::json!({
            "id":"trigger-1","routineId":"routine-1","status":"active",
            "spec":{"kind":"time-once","at":"2026-01-02T09:00:00Z","timezone":"UTC"},
            "deduplication":{"strategy":"per-trigger-event"}
        });
        trigger
            .as_object_mut()
            .unwrap()
            .extend(metadata.as_object().unwrap().clone());
        serde_json::json!({
            "plannedAt":"2026-01-01T12:00:00Z",
            "candidates":[{
                "routine":routine,
                "version":{
                    "routineId":"routine-1","version":1,"createdAt":"2026-01-01T00:00:00Z",
                    "createdByInternalUserId":"user-1",
                    "action":{"kind":"workflow-compatibility","title":"Daily","instruction":"Run."},
                    "scope":{},"routePolicy":{"kind":"resolve-at-run"},
                    "placementPolicy":{"kind":"resolve-at-run"},
                    "budgets":{"capabilityGrantIds":[]},"triggerIds":["trigger-1"]
                },
                "trigger":trigger
            }],
            "occurrences":[{
                "id":"occ-1","routineId":"routine-1","triggerId":"trigger-1",
                "routineVersion":1,"status":"completed",
                "observedAt":"2026-01-01T10:00:00Z","deduplicationKey":"legacy:job-1:one"
            }],
            "classifications":[{
                "source":{"kind":"scheduled-job","legacyId":"job-1","legacySchemaVersion":1,
                    "checksum":checksum},
                "disposition":"candidate","canonicalRoutineId":"routine-1"
            }]
        })
    }

    #[test]
    fn apply_is_atomic_encrypted_idempotent_and_exactly_replayable() {
        let (store, scope, private) = fixture();
        let evidence = evidence();
        let plan = plan();
        let first = store
            .transaction(|tx| {
                apply(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "user-1",
                    "batch-1",
                    &evidence,
                    &plan,
                    "2026-01-01T12:01:00Z",
                )
            })
            .unwrap();
        assert_eq!(first.candidate_count, 1);
        assert_eq!(first.occurrence_count, 1);
        let replay = store
            .transaction(|tx| {
                apply(
                    tx, &store, &scope, &private, "user-1", "batch-2", &evidence, &plan, "later",
                )
            })
            .unwrap();
        assert_eq!(replay.id, "batch-1");
        let mut recaptured_evidence = evidence.clone();
        recaptured_evidence["plannedAt"] = Value::String("2026-01-01T12:05:00Z".into());
        let mut recaptured_plan = plan.clone();
        recaptured_plan["plannedAt"] = Value::String("2026-01-01T12:05:00Z".into());
        let recaptured = store
            .transaction(|tx| {
                apply(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "user-1",
                    "batch-3",
                    &recaptured_evidence,
                    &recaptured_plan,
                    "later-still",
                )
            })
            .unwrap();
        assert_eq!(recaptured.id, "batch-1");
        store
            .with_conn(|tx| {
                let raw: Vec<u8> = tx.query_row(
                    "SELECT payload FROM routine_migration_batch WHERE id='batch-1'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(!String::from_utf8_lossy(&raw).contains("job-1"));
                Ok(())
            })
            .unwrap();
        assert!(store
            .with_conn(|tx| verify_replay(
                tx, &store, &scope, &private, "batch-1", &evidence, &plan
            ))
            .is_ok());
        let mut changed = plan.clone();
        changed["plannedAt"] = Value::String("2026-01-01T12:00:01Z".into());
        assert!(store
            .with_conn(|tx| {
                verify_replay(tx, &store, &scope, &private, "batch-1", &evidence, &changed)
            })
            .is_err());
    }

    #[test]
    fn rollback_removes_only_unchanged_batch_created_records() {
        let (store, scope, private) = fixture();
        let evidence = evidence();
        let plan = plan();
        store
            .transaction(|tx| {
                apply(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "user-1",
                    "batch-1",
                    &evidence,
                    &plan,
                    "2026-01-01T12:01:00Z",
                )
            })
            .unwrap();
        let result = store
            .transaction(|tx| {
                rollback(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "batch-1",
                    "2026-01-01T12:02:00Z",
                )
            })
            .unwrap();
        assert_eq!(result.status, "rolled-back");
        assert!(store
            .with_conn(|tx| routine::get(tx, &store, &scope, &private, "routine-1"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn ownership_mismatch_fails_without_partial_ledger() {
        let (store, scope, private) = fixture();
        let evidence = evidence();
        let mut plan = plan();
        plan["candidates"][0]["routine"]["ownerMemberId"] = Value::String("member-2".into());
        assert!(store
            .transaction(|tx| {
                apply(
                    tx, &store, &scope, &private, "user-1", "batch-1", &evidence, &plan, "now",
                )
            })
            .is_err());
        store
            .with_conn(|tx| {
                let count: i64 =
                    tx.query_row("SELECT COUNT(*) FROM routine_migration_batch", [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, 0);
                Ok(())
            })
            .unwrap();
    }
}
