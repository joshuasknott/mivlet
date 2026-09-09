//! Member-private local schedules and their fail-closed occurrence ledger.
//!
//! Prompt text, civil-time trigger details, route snapshots, and outcomes are
//! encrypted. Plain columns are limited to scoped identities, enums, UTC
//! timestamps, revisions, and one-way fingerprints needed for due/claim queries.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::scope::PrivateDataScope;
use crate::store::repos::{execution_attempt, open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleRow {
    pub id: String,
    pub agent_id: String,
    pub status: String,
    pub trigger_kind: String,
    pub revision: i64,
    pub prompt_revision: i64,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OccurrenceRow {
    pub id: String,
    pub schedule_id: String,
    pub schedule_revision: i64,
    pub prompt_revision: i64,
    pub state: String,
    pub slot_fingerprint: String,
    pub claim_fingerprint: String,
    pub lease_expires_at: String,
    pub execution_attempt_id: Option<String>,
    pub scheduled_for: String,
    pub claimed_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
    pub payload: Value,
}

fn schedule_aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "local_schedule:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

fn occurrence_aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "local_schedule_occurrence:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

pub fn insert_schedule(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &ScheduleRow,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    let sealed = seal_json(store, &row.payload, &schedule_aad(scope, &row.id))?;
    tx.execute(
        "INSERT INTO local_schedule(
           workspace_id,owner_subject,id,agent_id,status,trigger_kind,
           revision,prompt_revision,next_run_at,created_at,updated_at,payload,payload_nonce
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            row.agent_id,
            row.status,
            row.trigger_kind,
            row.revision,
            row.prompt_revision,
            row.next_run_at,
            row.created_at,
            row.updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(_, Some(message))
            if message.contains("UNIQUE") || message.contains("PRIMARY KEY") =>
        {
            StoreError::Invalid("That local schedule already exists.".into())
        }
        other => StoreError::Sqlite(other.to_string()),
    })?;
    Ok(())
}

pub fn get_schedule(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
) -> Result<Option<ScheduleRow>> {
    scope.ensure_exists(conn)?;
    let partial = conn
        .query_row(
            "SELECT id,agent_id,status,trigger_kind,revision,prompt_revision,
                    next_run_at,created_at,updated_at,payload,payload_nonce
               FROM local_schedule
              WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    Sealed {
                        ciphertext: row.get(9)?,
                        nonce: row.get(10)?,
                    },
                ))
            },
        )
        .optional()?;
    partial
        .map(
            |(
                id,
                agent_id,
                status,
                trigger_kind,
                revision,
                prompt_revision,
                next_run_at,
                created_at,
                updated_at,
                sealed,
            )| {
                let payload = open_json(store, &sealed, &schedule_aad(scope, &id))?;
                Ok(ScheduleRow {
                    id,
                    agent_id,
                    status,
                    trigger_kind,
                    revision,
                    prompt_revision,
                    next_run_at,
                    created_at,
                    updated_at,
                    payload,
                })
            },
        )
        .transpose()
}

pub fn list_schedules(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    limit: usize,
) -> Result<Vec<ScheduleRow>> {
    scope.ensure_exists(conn)?;
    let mut statement = conn.prepare(
        "SELECT id FROM local_schedule
          WHERE workspace_id=?1 AND owner_subject=?2
          ORDER BY updated_at DESC,id ASC LIMIT ?3",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), limit as i64],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            get_schedule(conn, store, scope, &id)?.ok_or_else(|| {
                StoreError::Invalid("A local schedule changed while it was being read.".into())
            })
        })
        .collect()
}

pub fn count_schedules(conn: &Connection, scope: &PrivateDataScope) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM local_schedule WHERE workspace_id=?1 AND owner_subject=?2",
        rusqlite::params![scope.workspace_id(), scope.owner_subject()],
        |row| row.get(0),
    )?)
}

pub fn first_due_schedule(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    now: &str,
) -> Result<Option<ScheduleRow>> {
    let id = conn
        .query_row(
            "SELECT id FROM local_schedule
              WHERE workspace_id=?1 AND owner_subject=?2 AND status='enabled'
                AND next_run_at IS NOT NULL AND next_run_at<=?3
              ORDER BY next_run_at ASC,id ASC LIMIT 1",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), now],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.map(|id| {
        get_schedule(conn, store, scope, &id)?.ok_or_else(|| {
            StoreError::Invalid("A due local schedule changed while it was being claimed.".into())
        })
    })
    .transpose()
}

pub fn replace_schedule(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    expected_revision: i64,
    row: &ScheduleRow,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &schedule_aad(scope, &row.id))?;
    let changed = tx.execute(
        "UPDATE local_schedule SET
           agent_id=?1,status=?2,trigger_kind=?3,revision=?4,
           prompt_revision=?5,next_run_at=?6,updated_at=?7,payload=?8,payload_nonce=?9
         WHERE workspace_id=?10 AND owner_subject=?11 AND id=?12 AND revision=?13",
        rusqlite::params![
            row.agent_id,
            row.status,
            row.trigger_kind,
            row.revision,
            row.prompt_revision,
            row.next_run_at,
            row.updated_at,
            sealed.ciphertext,
            sealed.nonce,
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "The local schedule changed. Refresh it before editing.".into(),
        ));
    }
    Ok(())
}

pub fn insert_claimed_occurrence(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &OccurrenceRow,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &occurrence_aad(scope, &row.id))?;
    tx.execute(
        "INSERT INTO local_schedule_occurrence(
           workspace_id,owner_subject,id,schedule_id,schedule_revision,prompt_revision,state,
           slot_fingerprint,claim_fingerprint,lease_expires_at,execution_attempt_id,scheduled_for,
           claimed_at,started_at,completed_at,updated_at,payload,payload_nonce
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            row.schedule_id,
            row.schedule_revision,
            row.prompt_revision,
            row.state,
            row.slot_fingerprint,
            row.claim_fingerprint,
            row.lease_expires_at,
            row.execution_attempt_id,
            row.scheduled_for,
            row.claimed_at,
            row.started_at,
            row.completed_at,
            row.updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub fn get_occurrence(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
) -> Result<Option<OccurrenceRow>> {
    let partial = conn
        .query_row(
            "SELECT id,schedule_id,schedule_revision,prompt_revision,state,slot_fingerprint,
                    claim_fingerprint,lease_expires_at,execution_attempt_id,scheduled_for,
                    claimed_at,started_at,completed_at,updated_at,payload,payload_nonce
               FROM local_schedule_occurrence
              WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, String>(13)?,
                    Sealed {
                        ciphertext: row.get(14)?,
                        nonce: row.get(15)?,
                    },
                ))
            },
        )
        .optional()?;
    partial
        .map(
            |(
                id,
                schedule_id,
                schedule_revision,
                prompt_revision,
                state,
                slot_fingerprint,
                claim_fingerprint,
                lease_expires_at,
                execution_attempt_id,
                scheduled_for,
                claimed_at,
                started_at,
                completed_at,
                updated_at,
                sealed,
            )| {
                let payload = open_json(store, &sealed, &occurrence_aad(scope, &id))?;
                Ok(OccurrenceRow {
                    id,
                    schedule_id,
                    schedule_revision,
                    prompt_revision,
                    state,
                    slot_fingerprint,
                    claim_fingerprint,
                    lease_expires_at,
                    execution_attempt_id,
                    scheduled_for,
                    claimed_at,
                    started_at,
                    completed_at,
                    updated_at,
                    payload,
                })
            },
        )
        .transpose()
}

pub fn list_occurrences(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    schedule_id: &str,
    limit: usize,
) -> Result<Vec<OccurrenceRow>> {
    scope.ensure_exists(conn)?;
    let mut statement = conn.prepare(
        "SELECT id FROM local_schedule_occurrence
          WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3
          ORDER BY scheduled_for DESC,id ASC LIMIT ?4",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                schedule_id,
                limit as i64
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            get_occurrence(conn, store, scope, &id)?.ok_or_else(|| {
                StoreError::Invalid(
                    "A local schedule occurrence changed while it was being read.".into(),
                )
            })
        })
        .collect()
}

pub fn occurrence_thread_id(
    conn: &Connection,
    scope: &PrivateDataScope,
    attempt_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(attempt_id) = attempt_id else {
        return Ok(None);
    };
    Ok(conn
        .query_row(
            "SELECT thread_id FROM run WHERE workspace_id=?1 AND id=?2",
            rusqlite::params![scope.workspace_id(), attempt_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Expired claims are evidence of an interrupted boundary. They never become
/// queued again and can only be followed by an explicit, separately keyed retry.
pub fn interrupt_expired(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    now: &str,
) -> Result<usize> {
    let mut statement = tx.prepare(
        "SELECT id FROM local_schedule_occurrence
          WHERE workspace_id=?1 AND owner_subject=?2
            AND state IN ('claimed','running') AND lease_expires_at<=?3",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), now],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for id in &ids {
        let mut occurrence = get_occurrence(tx, store, scope, id)?.ok_or_else(|| {
            StoreError::Invalid("An expired local schedule occurrence disappeared.".into())
        })?;
        occurrence.state = "interrupted".into();
        occurrence.completed_at = Some(now.into());
        occurrence.updated_at = now.into();
        if let Some(object) = occurrence.payload.as_object_mut() {
            object.insert("outcome".into(), Value::String("lease-expired".into()));
        }
        replace_occurrence(tx, store, scope, &occurrence, Some("claimed|running"))?;
    }
    Ok(ids.len())
}

/// Bind a claimed occurrence to an already-durable queued attempt before any
/// provider egress. The claim fingerprint and attempt ownership are checked in
/// the same SQLite transaction as the state transition.
pub fn bind_pending_attempt(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_fingerprint: &str,
    attempt_id: &str,
    now: &str,
    lease_expires_at: &str,
) -> Result<OccurrenceRow> {
    let mut occurrence = get_occurrence(tx, store, scope, occurrence_id)?.ok_or_else(|| {
        StoreError::Invalid("The local schedule occurrence was not found.".into())
    })?;
    if occurrence.state != "claimed" || occurrence.claim_fingerprint != claim_fingerprint {
        return Err(StoreError::Invalid(
            "The local schedule claim is stale or belongs to another dispatcher.".into(),
        ));
    }
    if occurrence.lease_expires_at.as_str() <= now {
        return Err(StoreError::Invalid(
            "The local schedule claim expired before execution could start.".into(),
        ));
    }
    let schedule = get_schedule(tx, store, scope, &occurrence.schedule_id)?
        .ok_or_else(|| StoreError::Invalid("The local schedule was not found.".into()))?;
    if schedule.status != "enabled" {
        return Err(StoreError::Invalid(
            "The local schedule was paused or cancelled before execution could start.".into(),
        ));
    }
    let expected_attempt_id = format!("schedule-run-{occurrence_id}");
    if attempt_id != expected_attempt_id {
        return Err(StoreError::Invalid(
            "The execution attempt does not belong to this schedule occurrence.".into(),
        ));
    }
    let attempt = execution_attempt::get_scoped(tx, store, scope.data(), attempt_id)?;
    let Some(attempt) = attempt else {
        return Err(StoreError::Invalid(
            "The schedule occurrence requires an exact durable queued execution attempt.".into(),
        ));
    };
    if attempt.status != "queued" {
        return Err(StoreError::Invalid(
            "The schedule occurrence requires an exact durable queued execution attempt.".into(),
        ));
    }
    let expected_provider = occurrence.payload.get("providerId").and_then(Value::as_str);
    let expected_model = occurrence.payload.get("model").and_then(Value::as_str);
    let expected_prompt = occurrence.payload.get("prompt").and_then(Value::as_str);
    let last_user_prompt = attempt
        .payload
        .get("exchanges")
        .and_then(Value::as_array)
        .and_then(|exchanges| {
            exchanges.iter().rev().find_map(|exchange| {
                (exchange.get("role").and_then(Value::as_str) == Some("user"))
                    .then(|| exchange.get("content").and_then(Value::as_str))
                    .flatten()
            })
        });
    if expected_provider != Some(attempt.provider_id.as_str())
        || expected_model != Some(attempt.model.as_str())
        || expected_prompt.is_none()
        || last_user_prompt != expected_prompt
    {
        return Err(StoreError::Invalid(
            "The queued execution attempt does not match the frozen schedule request.".into(),
        ));
    }
    let thread_owned: bool = if let Some(thread_id) = attempt.thread_id.as_deref() {
        tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM thread
                 WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL
                   AND owner_member_id IS ?3
            )",
            rusqlite::params![scope.workspace_id(), thread_id, scope.owner_member_id()],
            |row| row.get(0),
        )?
    } else {
        false
    };
    if !thread_owned {
        return Err(StoreError::Invalid(
            "The queued execution attempt is not owned by this private schedule scope.".into(),
        ));
    }
    occurrence.state = "running".into();
    occurrence.execution_attempt_id = Some(attempt_id.into());
    occurrence.started_at = Some(now.into());
    occurrence.updated_at = now.into();
    occurrence.lease_expires_at = lease_expires_at.into();
    replace_occurrence(tx, store, scope, &occurrence, Some("claimed"))?;
    Ok(occurrence)
}

pub fn renew_running_lease(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_fingerprint: &str,
    attempt_id: &str,
    now: &str,
    lease_expires_at: &str,
) -> Result<OccurrenceRow> {
    let mut occurrence = get_occurrence(tx, store, scope, occurrence_id)?.ok_or_else(|| {
        StoreError::Invalid("The local schedule occurrence was not found.".into())
    })?;
    if occurrence.state != "running"
        || occurrence.claim_fingerprint != claim_fingerprint
        || occurrence.execution_attempt_id.as_deref() != Some(attempt_id)
        || occurrence.lease_expires_at.as_str() <= now
    {
        return Err(StoreError::Invalid(
            "The local schedule execution lease is stale or expired.".into(),
        ));
    }
    let schedule = get_schedule(tx, store, scope, &occurrence.schedule_id)?
        .ok_or_else(|| StoreError::Invalid("The local schedule was not found.".into()))?;
    if schedule.status != "enabled" {
        return Err(StoreError::Invalid(
            "The local schedule was paused or cancelled while it was running.".into(),
        ));
    }
    occurrence.lease_expires_at = lease_expires_at.into();
    occurrence.updated_at = now.into();
    replace_occurrence(tx, store, scope, &occurrence, Some("running"))?;
    Ok(occurrence)
}

pub fn interrupt_claimed(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_fingerprint: &str,
    detail: &str,
    now: &str,
) -> Result<OccurrenceRow> {
    let mut occurrence = get_occurrence(tx, store, scope, occurrence_id)?.ok_or_else(|| {
        StoreError::Invalid("The local schedule occurrence was not found.".into())
    })?;
    if occurrence.state != "claimed" || occurrence.claim_fingerprint != claim_fingerprint {
        return Err(StoreError::Invalid(
            "The local schedule claim cannot be interrupted from its current state.".into(),
        ));
    }
    occurrence.state = "interrupted".into();
    occurrence.completed_at = Some(now.into());
    occurrence.updated_at = now.into();
    if let Some(object) = occurrence.payload.as_object_mut() {
        object.insert("outcome".into(), Value::String("interrupted".into()));
        object.insert("detail".into(), Value::String(detail.into()));
    }
    replace_occurrence(tx, store, scope, &occurrence, Some("claimed"))?;
    Ok(occurrence)
}

pub fn finish_occurrence(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_fingerprint: &str,
    attempt_id: &str,
    outcome: &str,
    detail: Option<&str>,
    now: &str,
) -> Result<OccurrenceRow> {
    if !matches!(outcome, "completed" | "failed" | "interrupted") {
        return Err(StoreError::Invalid(
            "Unsupported schedule occurrence outcome.".into(),
        ));
    }
    let mut occurrence = get_occurrence(tx, store, scope, occurrence_id)?.ok_or_else(|| {
        StoreError::Invalid("The local schedule occurrence was not found.".into())
    })?;
    if occurrence.state != "running"
        || occurrence.claim_fingerprint != claim_fingerprint
        || occurrence.execution_attempt_id.as_deref() != Some(attempt_id)
    {
        return Err(StoreError::Invalid(
            "The local schedule completion does not match its running attempt.".into(),
        ));
    }
    if occurrence.lease_expires_at.as_str() <= now {
        return Err(StoreError::Invalid(
            "The local schedule execution lease expired before completion was recorded.".into(),
        ));
    }
    let attempt_status = tx
        .query_row(
            "SELECT status FROM run WHERE id=?1 AND workspace_id=?2",
            rusqlite::params![attempt_id, scope.workspace_id()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let matches_attempt = match outcome {
        "completed" => attempt_status.as_deref() == Some("completed"),
        "failed" => attempt_status.as_deref() == Some("failed"),
        "interrupted" => matches!(attempt_status.as_deref(), Some("cancelled" | "interrupted")),
        _ => false,
    };
    if !matches_attempt {
        return Err(StoreError::Invalid(
            "The schedule outcome does not match the durable execution attempt.".into(),
        ));
    }
    occurrence.state = outcome.into();
    occurrence.completed_at = Some(now.into());
    occurrence.updated_at = now.into();
    if let Some(object) = occurrence.payload.as_object_mut() {
        object.insert("outcome".into(), Value::String(outcome.into()));
        if let Some(detail) = detail {
            object.insert("detail".into(), Value::String(detail.into()));
        }
    }
    replace_occurrence(tx, store, scope, &occurrence, Some("running"))?;
    Ok(occurrence)
}

fn replace_occurrence(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &OccurrenceRow,
    expected_state: Option<&str>,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &occurrence_aad(scope, &row.id))?;
    let (state_a, state_b) = expected_state
        .and_then(|value| value.split_once('|'))
        .map(|(a, b)| (a, b))
        .unwrap_or_else(|| {
            (
                expected_state.unwrap_or(&row.state),
                expected_state.unwrap_or(&row.state),
            )
        });
    let changed = tx.execute(
        "UPDATE local_schedule_occurrence SET
           state=?1,lease_expires_at=?2,execution_attempt_id=?3,started_at=?4,
           completed_at=?5,updated_at=?6,payload=?7,payload_nonce=?8
         WHERE workspace_id=?9 AND owner_subject=?10 AND id=?11 AND state IN (?12,?13)",
        rusqlite::params![
            row.state,
            row.lease_expires_at,
            row.execution_attempt_id,
            row.started_at,
            row.completed_at,
            row.updated_at,
            sealed.ciphertext,
            sealed.nonce,
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            state_a,
            state_b
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "The local schedule occurrence changed before this transition.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn count_occurrences(
    conn: &Connection,
    scope: &PrivateDataScope,
    schedule_id: &str,
) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM local_schedule_occurrence
          WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3",
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), schedule_id],
        |row| row.get(0),
    )?)
}
