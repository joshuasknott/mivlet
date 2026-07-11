//! Authenticated, secret-free semantic capability implementation evidence.
//!
//! Evidence is observational cache, never authority. Reads join the exact
//! canonical Connection revision; lifecycle, scope, grants, and approvals are
//! still re-evaluated by the resolver before every operation.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde::Serialize;

use crate::authorized_scope::{AuthorizedCommandScope, ScopeAccess};
use crate::store::{Result, StoreError};

const MAX_ADAPTER_REFERENCE: usize = 160;

#[derive(Clone, Copy, Debug)]
pub struct NativeCapabilityObservation<'a> {
    pub capability_key: &'a str,
    pub availability: &'a str,
    pub adapter_reference: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityImplementationEvidence {
    pub workspace_id: String,
    pub capability_key: String,
    pub connection_id: String,
    pub availability: String,
    pub consequence_class: String,
    pub evidence_kind: String,
    pub adapter_reference: String,
    pub connection_revision: i64,
    pub revision: i64,
    pub observed_at: String,
}

pub fn replace_native_observations(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
    expected_connection_revision: i64,
    observed_at: &str,
    observations: &[NativeCapabilityObservation<'_>],
) -> Result<Vec<CapabilityImplementationEvidence>> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, ScopeAccess::Write)?;
    let connection_id = crate::store::repos::scope::normalize_id(connection_id, "Connection")?;
    let current_revision = tx.query_row(
        "SELECT revision FROM connection_record
         WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL;",
        rusqlite::params![scope.data.workspace_id(), connection_id],
        |row| row.get::<_, i64>(0),
    )?;
    if current_revision != expected_connection_revision {
        return Err(StoreError::Invalid(
            "Connection changed before capability evidence was saved.".into(),
        ));
    }
    let observed_at = bounded(observed_at, "Observation time", 64)?;
    let mut wanted = BTreeSet::new();
    for observation in observations {
        let capability_key =
            crate::store::repos::scope::normalize_id(observation.capability_key, "Capability")?;
        if !wanted.insert(capability_key.clone()) {
            return Err(StoreError::Invalid(
                "Capability evidence contains a duplicate observation.".into(),
            ));
        }
        if !matches!(observation.availability, "available" | "degraded") {
            return Err(StoreError::Invalid(
                "Capability evidence availability is invalid.".into(),
            ));
        }
        let adapter_reference = bounded(
            observation.adapter_reference,
            "Adapter reference",
            MAX_ADAPTER_REFERENCE,
        )?;
        tx.execute(
            "INSERT INTO capability_implementation_evidence(
               workspace_id,capability_key,connection_id,availability,consequence_class,
               evidence_kind,adapter_reference,connection_revision,revision,
               observed_by_internal_user_id,observed_at)
             VALUES(?1,?2,?3,?4,'read','adapter-validated',?5,?6,1,?7,?8)
             ON CONFLICT(workspace_id,capability_key,connection_id) DO UPDATE SET
               availability=excluded.availability,
               adapter_reference=excluded.adapter_reference,
               connection_revision=excluded.connection_revision,
               revision=capability_implementation_evidence.revision+1,
               observed_by_internal_user_id=excluded.observed_by_internal_user_id,
               observed_at=excluded.observed_at
             WHERE capability_implementation_evidence.availability<>excluded.availability
                OR capability_implementation_evidence.adapter_reference<>excluded.adapter_reference
                OR capability_implementation_evidence.connection_revision<>excluded.connection_revision
                OR capability_implementation_evidence.observed_at<>excluded.observed_at;",
            rusqlite::params![
                scope.data.workspace_id(),
                capability_key,
                connection_id,
                observation.availability,
                adapter_reference,
                expected_connection_revision,
                scope.internal_user_id,
                observed_at,
            ],
        )?;
    }

    let mut existing = tx.prepare(
        "SELECT capability_key FROM capability_implementation_evidence
         WHERE workspace_id=?1 AND connection_id=?2;",
    )?;
    let existing = existing
        .query_map(
            rusqlite::params![scope.data.workspace_id(), connection_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for capability_key in existing {
        if !wanted.contains(&capability_key) {
            tx.execute(
                "DELETE FROM capability_implementation_evidence
                 WHERE workspace_id=?1 AND connection_id=?2 AND capability_key=?3;",
                rusqlite::params![scope.data.workspace_id(), connection_id, capability_key],
            )?;
        }
    }
    list_current_for_connection(tx, scope, &connection_id)
}

pub fn list_current_for_connection(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
) -> Result<Vec<CapabilityImplementationEvidence>> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, ScopeAccess::Read)?;
    let connection_id = crate::store::repos::scope::normalize_id(connection_id, "Connection")?;
    let mut stmt = tx.prepare(
        "SELECT e.workspace_id,e.capability_key,e.connection_id,e.availability,
                e.consequence_class,e.evidence_kind,e.adapter_reference,
                e.connection_revision,e.revision,e.observed_at
         FROM capability_implementation_evidence e
         JOIN connection_record c
           ON c.workspace_id=e.workspace_id AND c.id=e.connection_id
         WHERE e.workspace_id=?1 AND e.connection_id=?2
           AND e.connection_revision=c.revision AND c.deleted_at IS NULL
           AND c.lifecycle='authorized' AND c.authorization_state='authorized'
           AND c.credential_state='available'
         ORDER BY e.capability_key;",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.data.workspace_id(), connection_id],
        |row| {
            Ok(CapabilityImplementationEvidence {
                workspace_id: row.get(0)?,
                capability_key: row.get(1)?,
                connection_id: row.get(2)?,
                availability: row.get(3)?,
                consequence_class: row.get(4)?,
                evidence_kind: row.get(5)?,
                adapter_reference: row.get(6)?,
                connection_revision: row.get(7)?,
                revision: row.get(8)?,
                observed_at: row.get(9)?,
            })
        },
    )?;
    let evidence = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(evidence)
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "{label} must be between 1 and {max} characters."
        )));
    }
    Ok(value.to_string())
}
