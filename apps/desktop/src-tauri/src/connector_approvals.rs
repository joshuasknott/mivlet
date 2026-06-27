//! Durable connector action audit records.
//!
//! These are deliberately richer than the general UI approval history: every
//! external action records connector/account identity, target, preview, risk,
//! result, and correlation metadata.

use std::{fs, path::Path};

use crate::models::{ConnectorActionRequest, ConnectorApprovalRecord};
use crate::paths::{normalize_spaces, truncate_characters};
use sha2::{Digest, Sha256};

fn action_fingerprint(action: &ConnectorActionRequest) -> Result<String, String> {
    let encoded = serde_json::to_vec(action)
        .map_err(|_| "Fable could not fingerprint the connector action.".to_string())?;
    Ok(Sha256::digest(encoded)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn read_records(path: &Path) -> Result<Vec<ConnectorApprovalRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read connector approval records.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse connector approval records.".to_string())
}

fn write_records(path: &Path, records: &[ConnectorApprovalRecord]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(records)
        .map_err(|_| "Fable could not encode connector approval records.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save connector approval records.".to_string())?;
    fs::rename(&temporary, path)
        .map_err(|_| "Fable could not commit connector approval records.".to_string())
}

fn first_payload_value(action: &ConnectorActionRequest, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        action
            .payload
            .get(*key)
            .map(|value| truncate_characters(&normalize_spaces(value), 500))
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn record_pending_connector_action(
    path: &Path,
    action: &ConnectorActionRequest,
    account_id: &str,
) -> Result<ConnectorApprovalRecord, String> {
    let target = first_payload_value(
        action,
        &[
            "target",
            "to",
            "channel",
            "repository",
            "deploymentId",
            "calendarId",
            "targetId",
        ],
    )
    .unwrap_or_else(|| "provider-selected target".to_string());
    let subject = first_payload_value(action, &["subject", "title", "summary"]);
    let preview = subject
        .map(|subject| format!("{} — {subject} → {target}", action.action))
        .unwrap_or_else(|| format!("{} → {target}", action.action));
    let record = ConnectorApprovalRecord {
        id: format!("connector-approval-{}", action.id),
        connector_id: action.connector_id.clone(),
        account_id: account_id.to_string(),
        proposed_action: action.action.clone(),
        target,
        preview: truncate_characters(&preview, 1_000),
        risk_level: action.approval.risk_level.clone(),
        result: "pending".to_string(),
        request_id: action.approval.id.clone(),
        requested_at: action.approval.requested_at.clone(),
        decided_at: None,
        executed_at: None,
        actor: "user".to_string(),
        run_id: action.payload.get("runId").cloned(),
        error_code: None,
        action_fingerprint: action_fingerprint(action)?,
    };
    upsert(path, record)
}

pub(crate) fn verify_prepared_connector_action(
    path: &Path,
    action: &ConnectorActionRequest,
) -> Result<ConnectorApprovalRecord, String> {
    let records = read_records(path)?;
    let record = records
        .into_iter()
        .find(|record| record.request_id == action.approval.id)
        .ok_or_else(|| "Connector action was not prepared by Fable.".to_string())?;
    if record.connector_id != action.connector_id
        || record.proposed_action != action.action
        || record.risk_level != action.approval.risk_level
        || record.action_fingerprint != action_fingerprint(action)?
    {
        return Err("Connector action changed after its approval preview.".to_string());
    }
    Ok(record)
}

pub(crate) fn update_connector_action_result(
    path: &Path,
    request_id: &str,
    result: &str,
    at: &str,
    error_code: Option<&str>,
) -> Result<ConnectorApprovalRecord, String> {
    let mut records = read_records(path)?;
    let record = records
        .iter_mut()
        .find(|record| record.request_id == request_id)
        .ok_or_else(|| "Connector action has no prepared approval record.".to_string())?;
    record.result = result.to_string();
    if matches!(result, "approved" | "denied") {
        record.decided_at = Some(at.to_string());
    }
    if matches!(result, "executed" | "failed") {
        record.executed_at = Some(at.to_string());
    }
    record.error_code = error_code.map(str::to_string);
    let updated = record.clone();
    write_records(path, &records)?;
    Ok(updated)
}

fn upsert(path: &Path, record: ConnectorApprovalRecord) -> Result<ConnectorApprovalRecord, String> {
    let mut records = read_records(path)?;
    records.retain(|existing| existing.id != record.id);
    records.insert(0, record.clone());
    records.truncate(500);
    write_records(path, &records)?;
    Ok(record)
}

#[tauri::command]
pub fn list_connector_approval_records(
    app: tauri::AppHandle,
) -> Result<Vec<ConnectorApprovalRecord>, String> {
    read_records(&crate::paths::connector_approval_records_path(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ApprovalRequest;
    use std::collections::BTreeMap;

    fn action(target: &str) -> ConnectorActionRequest {
        ConnectorActionRequest {
            id: "action-1".to_string(),
            connector_id: "gmail".to_string(),
            action: "gmail.send".to_string(),
            payload: BTreeMap::from([
                ("to".to_string(), target.to_string()),
                ("subject".to_string(), "Status update".to_string()),
            ]),
            approval: ApprovalRequest {
                id: "action-1".to_string(),
                service: "Gmail".to_string(),
                action: "Send".to_string(),
                mode: "full-access".to_string(),
                risk_level: "high".to_string(),
                data_used: vec!["subject".to_string(), "to".to_string()],
                consequence: "Sends the selected email to external recipients.".to_string(),
                requested_at: "2026-06-27T12:00:00Z".to_string(),
                decisions: vec!["once".to_string(), "deny".to_string()],
                confirmation_phrase: Some("send email".to_string()),
            },
        }
    }

    #[test]
    fn connector_record_captures_required_audit_fields_and_binds_payload() {
        let path = std::env::temp_dir().join(format!(
            "fable-connector-approval-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let prepared = action("person@example.com");
        let record =
            record_pending_connector_action(&path, &prepared, "account-1").expect("record");
        assert_eq!(record.connector_id, "gmail");
        assert_eq!(record.account_id, "account-1");
        assert_eq!(record.proposed_action, "gmail.send");
        assert_eq!(record.target, "person@example.com");
        assert!(record.preview.contains("Status update"));
        assert_eq!(record.risk_level, "high");
        assert_eq!(record.result, "pending");
        assert!(verify_prepared_connector_action(&path, &prepared).is_ok());
        assert!(verify_prepared_connector_action(&path, &action("attacker@example.com")).is_err());
        let _ = fs::remove_file(path);
    }
}
