//! Native execution permits issued only after the approval command persists a
//! user decision. Side-effecting commands verify these records immediately
//! before dispatch, so model-produced approval JSON is never authority.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::{ApprovalRequest, ApprovalResolutionResponse};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionApproval {
    request_id: String,
    request_fingerprint: String,
    decision: String,
    decided_at: String,
    consumed_at: Option<String>,
}

fn request_fingerprint(request: &ApprovalRequest) -> Result<String, String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|_| "Fable could not fingerprint the approval request.".to_string())?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn read_records(path: &Path) -> Result<Vec<ExecutionApproval>, String> {
    if let Some(records) = crate::store::read_document(path)? {
        return Ok(records);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read execution approvals.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse execution approvals.".to_string())
}

fn write_records(path: &Path, records: &[ExecutionApproval]) -> Result<(), String> {
    if crate::store::write_document(path, &records)? {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(records)
        .map_err(|_| "Fable could not encode execution approvals.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save execution approvals.".to_string())?;
    fs::rename(&temporary, path)
        .map_err(|_| "Fable could not commit execution approvals.".to_string())
}

pub(crate) fn record_execution_decision(
    path: &Path,
    response: &ApprovalResolutionResponse,
) -> Result<(), String> {
    let mut records = read_records(path)?;
    records.retain(|record| record.request_id != response.effective_request.id);
    records.insert(
        0,
        ExecutionApproval {
            request_id: response.effective_request.id.clone(),
            request_fingerprint: request_fingerprint(&response.effective_request)?,
            decision: response.audit_entry.decision.clone(),
            decided_at: response.audit_entry.decided_at.clone(),
            consumed_at: None,
        },
    );
    records.truncate(500);
    write_records(path, &records)
}

pub(crate) fn verify_and_consume_execution_approval(
    path: &Path,
    request: &ApprovalRequest,
    consumed_at: &str,
) -> Result<(), String> {
    let expected = request_fingerprint(request)?;
    let mut records = read_records(path)?;
    let record = records
        .iter_mut()
        .find(|record| record.request_id == request.id)
        .ok_or_else(|| {
            "Execution blocked: no persisted user approval matches this request.".to_string()
        })?;
    if record.request_fingerprint != expected {
        return Err(
            "Execution blocked: approval metadata changed after the user decision.".to_string(),
        );
    }
    if !matches!(
        record.decision.as_str(),
        "once" | "session" | "rule" | "modify"
    ) {
        return Err("Execution blocked: the user did not approve this request.".to_string());
    }
    if record.consumed_at.is_some() {
        return Err("Execution blocked: this approval was already consumed.".to_string());
    }
    record.consumed_at = Some(consumed_at.to_string());
    write_records(path, &records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ApprovalAuditEntry, ApprovalRequest, ApprovalResolutionResponse};

    fn request() -> ApprovalRequest {
        ApprovalRequest {
            id: "approval-1".to_string(),
            service: "Fable tools".to_string(),
            action: "write-file a.txt".to_string(),
            mode: "full-access".to_string(),
            risk_level: "high".to_string(),
            data_used: vec!["path".to_string(), "content".to_string()],
            consequence: "Writes a workspace file.".to_string(),
            requested_at: "2026-06-27T12:00:00Z".to_string(),
            decisions: vec!["once".to_string(), "deny".to_string()],
            confirmation_phrase: Some("write file".to_string()),
        }
    }

    fn response(request: ApprovalRequest) -> ApprovalResolutionResponse {
        ApprovalResolutionResponse {
            persisted: true,
            audit_entry: ApprovalAuditEntry {
                id: "audit-1".to_string(),
                request_id: request.id.clone(),
                decision: "once".to_string(),
                decided_at: "2026-06-27T12:00:01Z".to_string(),
                note: "approved".to_string(),
            },
            effective_request: request,
            dismissed: true,
            grant: None,
        }
    }

    #[test]
    fn persisted_permit_is_exact_and_one_time() {
        let path = std::env::temp_dir().join(format!(
            "fable-execution-approval-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let approved = request();
        record_execution_decision(&path, &response(approved.clone())).expect("record");
        let mut reshaped = approved.clone();
        reshaped.action = "run-shell destructive-command".to_string();
        assert!(verify_and_consume_execution_approval(&path, &reshaped, "now").is_err());
        verify_and_consume_execution_approval(&path, &approved, "now").expect("consume");
        assert!(verify_and_consume_execution_approval(&path, &approved, "later").is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unpersisted_model_claim_cannot_authorize_execution() {
        let path = std::env::temp_dir().join("fable-missing-execution-approval.json");
        let _ = fs::remove_file(&path);
        let error = verify_and_consume_execution_approval(&path, &request(), "now")
            .expect_err("missing user decision must fail closed");
        assert!(error.contains("no persisted user approval"));
    }
}
