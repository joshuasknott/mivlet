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
    if let Some(records) = crate::store::read_document(path)? {
        return Ok(records);
    }
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
    if crate::store::write_document(path, &records)? {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(records)
        .map_err(|_| "Fable could not encode connector approval records.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save connector approval records.".to_string())?;
    fs::rename(&temporary, path)
        .map_err(|_| "Fable could not commit connector approval records.".to_string())
}

fn is_sensitive_payload_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("authorization")
        || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("token")
        || lower == "value"
        || lower == "privatekey"
}

fn payload_field(action: &ConnectorActionRequest, key: &str) -> Option<String> {
    action
        .payload
        .get(key)
        .map(|value| truncate_characters(&normalize_spaces(value), 300))
        .filter(|value| !value.is_empty())
        .map(|value| {
            if is_sensitive_payload_key(key) {
                format!("{key}=[redacted]")
            } else {
                format!("{key}={value}")
            }
        })
}

fn selected_payload_fields(action: &ConnectorActionRequest, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .filter_map(|key| payload_field(action, key))
        .collect()
}

fn all_safe_payload_fields(action: &ConnectorActionRequest) -> Vec<String> {
    action
        .payload
        .iter()
        .filter(|(key, _)| key.as_str() != "runId")
        .map(|(key, value)| {
            if is_sensitive_payload_key(key) {
                format!("{key}=[redacted]")
            } else {
                format!(
                    "{key}={}",
                    truncate_characters(&normalize_spaces(value), 300)
                )
            }
        })
        .collect()
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

fn connector_target_summary(action: &ConnectorActionRequest, account_id: &str) -> String {
    let keys: &[&str] = match action.connector_id.as_str() {
        "github" => &[
            "repository",
            "targetId",
            "issue",
            "pullRequest",
            "path",
            "branch",
            "workflowId",
            "ref",
        ],
        "vercel" => &[
            "teamId",
            "project",
            "deploymentId",
            "targetId",
            "environment",
            "domain",
        ],
        "linear" => &[
            "workspace",
            "team",
            "teamId",
            "issueId",
            "targetId",
            "statusId",
            "projectId",
            "cycleId",
            "assigneeId",
        ],
        "google-drive" => &[
            "fileId",
            "name",
            "destinationFolderId",
            "parents",
            "recipient",
            "targetId",
        ],
        "gmail" => &["to", "draftId", "subject", "targetId"],
        "google-calendar" => &["calendarId", "eventId", "title", "start", "end", "targetId"],
        "slack" => &[
            "workspace",
            "channelName",
            "channelId",
            "timestamp",
            "threadTimestamp",
            "targetId",
        ],
        "notion" => &[
            "workspace",
            "targetId",
            "destination",
            "title",
            "subject",
            "body",
        ],
        _ => &[
            "target",
            "to",
            "channel",
            "repository",
            "deploymentId",
            "calendarId",
            "targetId",
        ],
    };
    let mut fields = vec![format!("account={account_id}")];
    fields.extend(selected_payload_fields(action, keys));
    if fields.len() == 1 {
        fields.push("target=provider-selected target".to_string());
    }
    truncate_characters(&fields.join("; "), 1_000)
}

fn connector_preview(action: &ConnectorActionRequest, account_id: &str, target: &str) -> String {
    let provider_label = match action.connector_id.as_str() {
        "github" => "GitHub",
        "vercel" => "Vercel",
        "linear" => "Linear",
        "google-drive" => "Google Drive",
        "gmail" => "Gmail",
        "google-calendar" => "Google Calendar",
        "slack" => "Slack",
        "notion" => "Notion",
        _ => action.approval.service.as_str(),
    };
    let proposed = all_safe_payload_fields(action);
    let proposed = if proposed.is_empty() {
        "no provider payload fields".to_string()
    } else {
        proposed.join("; ")
    };
    truncate_characters(
        &format!(
            "{provider_label} action={}; account={account_id}; target=({target}); proposed=({proposed})",
            action.action
        ),
        1_000,
    )
}

pub(crate) fn record_pending_connector_action(
    path: &Path,
    action: &ConnectorActionRequest,
    account_id: &str,
    account_label: &str,
) -> Result<ConnectorApprovalRecord, String> {
    let target = connector_target_summary(action, account_id);
    let default_preview = connector_preview(action, account_id, &target);
    let value = |keys: &[&str], fallback: &str| {
        first_payload_value(action, keys).unwrap_or_else(|| fallback.to_string())
    };
    let preview = match action.connector_id.as_str() {
        "gmail" => format!(
            "Account: {account_label}\nTo: {}\nCC: {}\nBCC: {}\nSubject: {}\nBody: {}\nAttachments: {}\nAction: {}",
            value(&["to"], "(none)"),
            value(&["cc"], "(none)"),
            value(&["bcc"], "(none)"),
            value(&["subject"], "(no subject)"),
            value(&["body"], "(existing approved draft body)"),
            value(&["attachments"], "(none)"),
            action.action,
        ),
        "google-calendar" => format!(
            "Account: {account_label}\nCalendar: {}\nTitle: {}\nDate/time: {} to {}\nTimezone: {}\nLocation: {}\nAttendees: {}\nRecurrence: {}\nChanged fields: {}\nAction: {}",
            value(&["calendarId"], "primary"),
            value(&["title"], "(existing event)"),
            value(&["start"], "(unchanged)"),
            value(&["end"], "(unchanged)"),
            value(&["timezone"], "(unchanged)"),
            value(&["location"], "(none)"),
            value(&["attendees"], "(none)"),
            value(&["recurrence"], "(none)"),
            action.payload.keys().cloned().collect::<Vec<_>>().join(", "),
            action.action,
        ),
        "google-drive" => format!(
            "Account: {account_label}\nFile/folder: {}\nDestination: {}\nRecipients: {}\nProposed change: {}\nName/content preview: {}",
            value(&["fileId", "name"], "new file"),
            value(&["destinationFolderId", "parents"], "(unchanged)"),
            value(&["recipient"], "(none)"),
            action.action,
            value(&["name", "content"], "(metadata only)"),
        ),
        "notion" | "slack" => {
            let detail_keys = [
                "workspace",
                "account",
                "channelName",
                "threadTimestamp",
                "timestamp",
                "destination",
                "text",
                "subject",
                "title",
                "changedProperties",
                "body",
                "reaction",
            ];
            let details = detail_keys
                .iter()
                .filter_map(|key| {
                    first_payload_value(action, &[*key]).map(|value| format!("{key}: {value}"))
                })
                .collect::<Vec<_>>()
                .join(" | ");
            if details.is_empty() {
                default_preview
            } else {
                format!("{} -> {target} | {details}", action.action)
            }
        }
        _ => default_preview,
    };
    let preview = truncate_characters(&preview, 1_000);
    let record = ConnectorApprovalRecord {
        id: format!("connector-approval-{}", action.id),
        connector_id: action.connector_id.clone(),
        account_id: account_id.to_string(),
        proposed_action: action.action.clone(),
        target,
        preview,
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
            record_pending_connector_action(&path, &prepared, "account-1", "person@example.com")
                .expect("record");
        assert_eq!(record.connector_id, "gmail");
        assert_eq!(record.account_id, "account-1");
        assert_eq!(record.proposed_action, "gmail.send");
        assert!(record.target.contains("account=account-1"));
        assert!(record.target.contains("to=person@example.com"));
        assert!(record.preview.contains("Account: person@example.com"));
        assert!(record.preview.contains("To: person@example.com"));
        assert!(record.preview.contains("Subject: Status update"));
        assert_eq!(record.risk_level, "high");
        assert_eq!(record.result, "pending");
        assert!(verify_prepared_connector_action(&path, &prepared).is_ok());
        assert!(verify_prepared_connector_action(&path, &action("attacker@example.com")).is_err());
        let _ = fs::remove_file(path);
    }

    /// The Gmail send approval preview must surface every field a user needs to
    /// make a per-message decision: the sending account, To, CC, BCC, subject,
    /// a body preview, and attachments. A regression dropping any of these
    /// would let a send be approved without full visibility.
    #[test]
    fn gmail_send_preview_shows_account_recipients_body_and_attachments() {
        let path = std::env::temp_dir().join(format!(
            "fable-connector-approval-preview-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let prepared = ConnectorActionRequest {
            id: "action-preview".to_string(),
            connector_id: "gmail".to_string(),
            action: "gmail.send".to_string(),
            payload: BTreeMap::from([
                ("to".to_string(), "alice@example.com".to_string()),
                ("cc".to_string(), "bob@example.com".to_string()),
                ("bcc".to_string(), "carol@example.com".to_string()),
                ("subject".to_string(), "Quarterly review".to_string()),
                (
                    "body".to_string(),
                    "Please review the attached.".to_string(),
                ),
                ("attachments".to_string(), "report.pdf".to_string()),
            ]),
            approval: ApprovalRequest {
                id: "action-preview".to_string(),
                service: "Gmail".to_string(),
                action: "Send".to_string(),
                mode: "full-access".to_string(),
                risk_level: "high".to_string(),
                data_used: vec![
                    "to".to_string(),
                    "cc".to_string(),
                    "bcc".to_string(),
                    "subject".to_string(),
                    "body".to_string(),
                    "attachments".to_string(),
                ],
                consequence: "Sends the selected email to external recipients.".to_string(),
                requested_at: "2026-06-27T12:00:00Z".to_string(),
                decisions: vec!["once".to_string(), "deny".to_string()],
                confirmation_phrase: Some("send email".to_string()),
            },
        };
        let record =
            record_pending_connector_action(&path, &prepared, "account-1", "sender@example.com")
                .expect("record");
        assert!(record.preview.contains("Account: sender@example.com"));
        assert!(record.preview.contains("To: alice@example.com"));
        assert!(record.preview.contains("CC: bob@example.com"));
        assert!(record.preview.contains("BCC: carol@example.com"));
        assert!(record.preview.contains("Subject: Quarterly review"));
        assert!(record.preview.contains("Body: Please review the attached."));
        assert!(record.preview.contains("Attachments: report.pdf"));
        let _ = fs::remove_file(path);
    }
}
