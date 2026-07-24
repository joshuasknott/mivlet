//! Encrypted at-most-once consumption for exact approved Mission effects.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::repos::scope::{normalize_id, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionApprovalConsumptionRow {
    pub run_id: String,
    pub wait_key: String,
    pub resolution_event_id: String,
    pub proposal_hash: String,
    pub effect_key: String,
    pub consumed_at: String,
    pub receipt: Value,
}

#[allow(clippy::too_many_arguments)]
pub fn consume(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    wait_key: &str,
    resolution_event_id: &str,
    proposal_hash: &str,
    effect_key: &str,
    receipt: &Value,
    consumed_at: &str,
) -> Result<MissionApprovalConsumptionRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let event_id = normalize_id(resolution_event_id, "Mission approval resolution event")?;
    validate_metadata(wait_key, proposal_hash, effect_key, consumed_at)?;
    validate_receipt(
        receipt,
        scope.workspace_id(),
        &owner,
        &run_id,
        wait_key,
        &event_id,
        proposal_hash,
        effect_key,
        consumed_at,
    )?;

    let event = tx
        .query_row(
            "SELECT payload,payload_nonce FROM mission_run_event
             WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3
               AND id=?4 AND event_type='approval-resolved';",
            rusqlite::params![scope.workspace_id(), owner, run_id, event_id],
            |row| {
                Ok(Sealed {
                    ciphertext: row.get(0)?,
                    nonce: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("Mission approval resolution is unavailable.".into()))?;
    let event = open_json(
        store,
        &event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    if event.get("id").and_then(Value::as_str) != Some(event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        || event
            .pointer("/payload/resolution/waitKey")
            .and_then(Value::as_str)
            != Some(wait_key)
        || event
            .pointer("/payload/resolution/decision")
            .and_then(Value::as_str)
            != Some("approved")
        || event
            .pointer("/payload/resolution/acceptedProposalHash")
            .and_then(Value::as_str)
            != Some(proposal_hash)
        || event
            .pointer("/payload/resolution/effect/effectKey")
            .and_then(Value::as_str)
            != Some(effect_key)
    {
        return Err(StoreError::Invalid(
            "Mission effect consumption does not match its approved proposal.".into(),
        ));
    }
    if get(tx, store, scope, &owner, wait_key)?.is_some() {
        return Err(StoreError::Invalid(
            "This Mission approval was already consumed.".into(),
        ));
    }

    let sealed = seal_json(
        store,
        receipt,
        &aad(scope.workspace_id(), &owner, &run_id, wait_key),
    )?;
    tx.execute(
        "INSERT INTO mission_approval_consumption(
           workspace_id,owner_member_id,run_id,wait_key,resolution_event_id,
           proposal_hash,effect_key,consumed_at,payload,payload_nonce
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10);",
        rusqlite::params![
            scope.workspace_id(),
            owner,
            run_id,
            wait_key,
            event_id,
            proposal_hash,
            effect_key,
            consumed_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    get(tx, store, scope, &owner, wait_key)?
        .ok_or_else(|| StoreError::Invalid("Mission approval consumption was not saved.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    wait_key: &str,
) -> Result<Option<MissionApprovalConsumptionRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let row = tx
        .query_row(
            "SELECT run_id,resolution_event_id,proposal_hash,effect_key,consumed_at,
                    payload,payload_nonce
             FROM mission_approval_consumption
             WHERE workspace_id=?1 AND owner_member_id=?2 AND wait_key=?3;",
            rusqlite::params![scope.workspace_id(), owner, wait_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    Sealed {
                        ciphertext: row.get(5)?,
                        nonce: row.get(6)?,
                    },
                ))
            },
        )
        .optional()?;
    row.map(
        |(run_id, event_id, proposal_hash, effect_key, consumed_at, sealed)| {
            let receipt = open_json(
                store,
                &sealed,
                &aad(scope.workspace_id(), &owner, &run_id, wait_key),
            )?;
            validate_receipt(
                &receipt,
                scope.workspace_id(),
                &owner,
                &run_id,
                wait_key,
                &event_id,
                &proposal_hash,
                &effect_key,
                &consumed_at,
            )?;
            Ok(MissionApprovalConsumptionRow {
                run_id,
                wait_key: wait_key.to_string(),
                resolution_event_id: event_id,
                proposal_hash,
                effect_key,
                consumed_at,
                receipt,
            })
        },
    )
    .transpose()
}

fn validate_metadata(
    wait_key: &str,
    proposal_hash: &str,
    effect_key: &str,
    consumed_at: &str,
) -> Result<()> {
    if !wait_key.starts_with("mission-approval-wait:v1:")
        || wait_key.len() != "mission-approval-wait:v1:".len() + 64
        || proposal_hash.len() != 64
        || !proposal_hash.bytes().all(|value| value.is_ascii_hexdigit())
        || effect_key.trim().is_empty()
        || effect_key.len() > 200
        || effect_key.chars().any(char::is_control)
        || consumed_at.trim().is_empty()
        || consumed_at.len() > 64
    {
        return Err(StoreError::Invalid(
            "Mission approval consumption metadata is invalid.".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_receipt(
    receipt: &Value,
    workspace_id: &str,
    owner_member_id: &str,
    run_id: &str,
    wait_key: &str,
    resolution_event_id: &str,
    proposal_hash: &str,
    effect_key: &str,
    consumed_at: &str,
) -> Result<()> {
    let object = receipt.as_object().ok_or_else(|| {
        StoreError::Invalid("Mission approval consumption receipt is invalid.".into())
    })?;
    if object.len() != 8
        || receipt.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
        || receipt.get("ownerMemberId").and_then(Value::as_str) != Some(owner_member_id)
        || receipt.get("runId").and_then(Value::as_str) != Some(run_id)
        || receipt.get("waitKey").and_then(Value::as_str) != Some(wait_key)
        || receipt.get("resolutionEventId").and_then(Value::as_str) != Some(resolution_event_id)
        || receipt.get("proposalHash").and_then(Value::as_str) != Some(proposal_hash)
        || receipt.get("effectKey").and_then(Value::as_str) != Some(effect_key)
        || receipt.get("consumedAt").and_then(Value::as_str) != Some(consumed_at)
    {
        return Err(StoreError::Invalid(
            "Mission approval consumption receipt does not match its scope.".into(),
        ));
    }
    Ok(())
}

fn aad(workspace: &str, owner: &str, run: &str, wait: &str) -> String {
    format!("mission-approval-consumption:{workspace}:{owner}:{run}:{wait}")
}

fn event_aad(workspace: &str, owner: &str, event: &str) -> String {
    format!("mission-run-event:{workspace}:{owner}:{event}")
}
