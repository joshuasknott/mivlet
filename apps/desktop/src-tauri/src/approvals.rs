//! Approval audit log, standing approval rules, and approval resolution.
//!
//! Tauri commands: `list_approval_audit`, `list_approval_rules`, and
//! `resolve_approval_request`. Decisions are persisted through resolution.

use std::{collections::HashSet, fs, path::Path};

use crate::execution_approvals::record_execution_decision;
use crate::models::{
    ApprovalAuditEntry, ApprovalAuditRecordResponse, ApprovalGrant, ApprovalRequest,
    ApprovalResolutionRequest, ApprovalResolutionResponse, APPROVAL_DECISIONS, APPROVAL_MODES,
    APPROVAL_RISK_LEVELS, MAX_APPROVAL_AUDIT_ENTRIES, MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    MAX_APPROVAL_RULES, MAX_MEMORY_TITLE_CHARACTERS, MAX_MEMORY_VALUE_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
};
use crate::paths::{
    approval_audit_path, approval_rules_path, execution_approvals_path, file_slug,
    normalize_spaces, truncate_characters,
};
use crate::store::repos::scope::DataScope;

pub(crate) fn normalize_approval_data(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized_values = Vec::new();

    for value in values {
        let normalized = truncate_characters(
            &normalize_spaces(&value),
            MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
        );
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        normalized_values.push(normalized);
    }

    normalized_values
}

pub(crate) fn normalize_approval_audit_entry(
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditEntry, String> {
    let id = normalize_spaces(&entry.id);
    let request_id = normalize_spaces(&entry.request_id);
    let decision = normalize_spaces(&entry.decision).to_ascii_lowercase();
    let decided_at = normalize_spaces(&entry.decided_at);
    let note = truncate_characters(
        &normalize_spaces(&entry.note),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );

    if id.is_empty() || request_id.is_empty() {
        return Err("Approval audit entries need stable request identifiers.".to_string());
    }

    if !APPROVAL_DECISIONS.contains(&decision.as_str()) {
        return Err("Approval decision is not recognized.".to_string());
    }

    if decided_at.is_empty() {
        return Err("Approval audit entries need a decision time.".to_string());
    }

    if note.is_empty() {
        return Err("Approval audit entries need a short note.".to_string());
    }

    Ok(ApprovalAuditEntry {
        id,
        request_id,
        decision,
        decided_at,
        note,
    })
}

pub(crate) fn read_approval_audit_entries(path: &Path) -> Result<Vec<ApprovalAuditEntry>, String> {
    if let Some(entries) = crate::store::read_document(path)? {
        return Ok(entries);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Mivlet could not read the approval audit log.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<ApprovalAuditEntry>>(&contents)
        .map_err(|_| "Mivlet could not parse the approval audit log.".to_string())
}

fn append_approval_audit_entry(
    mut entries: Vec<ApprovalAuditEntry>,
    entry: ApprovalAuditEntry,
) -> Vec<ApprovalAuditEntry> {
    entries.retain(|existing| existing.id != entry.id);
    entries.insert(0, entry);
    entries.truncate(MAX_APPROVAL_AUDIT_ENTRIES);
    entries
}

fn write_approval_audit_entries(path: &Path, entries: &[ApprovalAuditEntry]) -> Result<(), String> {
    if crate::store::write_document(path, &entries)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(entries)
        .map_err(|_| "Mivlet could not encode the approval audit log.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Mivlet could not save the approval audit log.".to_string())
}

pub(crate) fn persist_approval_audit_entry(
    path: &Path,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let entry = normalize_approval_audit_entry(entry)?;
    let entries = read_approval_audit_entries(path)?;
    let entries = append_approval_audit_entry(entries, entry.clone());
    write_approval_audit_entries(path, &entries)?;

    Ok(ApprovalAuditRecordResponse {
        persisted: true,
        entry,
        audit_len: entries.len(),
    })
}

/// Persist an approval decision in the exact authorized data scope. This is
/// intentionally narrow: project Memory promotion must not leak its audit
/// trail into the workspace-wide legacy approval document.
pub(crate) fn persist_approval_audit_entry_scoped(
    path: &Path,
    scope: &DataScope,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let entry = normalize_approval_audit_entry(entry)?;
    let entries: Vec<ApprovalAuditEntry> =
        crate::store::read_workspace_document(path, scope)?.unwrap_or_default();
    let entries = append_approval_audit_entry(entries, entry.clone());
    if !crate::store::write_workspace_document(path, scope, &entries)? {
        return Err("Mivlet's encrypted store is not initialized.".to_string());
    }
    Ok(ApprovalAuditRecordResponse {
        persisted: true,
        entry,
        audit_len: entries.len(),
    })
}

pub(crate) fn normalize_approval_request(
    request: ApprovalRequest,
) -> Result<ApprovalRequest, String> {
    let id = truncate_characters(
        &normalize_spaces(&request.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let service = truncate_characters(
        &normalize_spaces(&request.service),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let action = truncate_characters(
        &normalize_spaces(&request.action),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );
    let mode = normalize_spaces(&request.mode).to_ascii_lowercase();
    let risk_level = normalize_spaces(&request.risk_level).to_ascii_lowercase();
    let consequence = truncate_characters(
        &normalize_spaces(&request.consequence),
        MAX_MEMORY_VALUE_CHARACTERS,
    );
    let requested_at = normalize_spaces(&request.requested_at);
    let decisions = request
        .decisions
        .into_iter()
        .map(|decision| normalize_spaces(&decision).to_ascii_lowercase())
        .filter(|decision| APPROVAL_DECISIONS.contains(&decision.as_str()))
        .collect::<Vec<_>>();
    let confirmation_phrase = request
        .confirmation_phrase
        .map(|phrase| truncate_characters(&normalize_spaces(&phrase), 120))
        .filter(|phrase| !phrase.is_empty());

    if id.is_empty()
        || service.is_empty()
        || action.is_empty()
        || consequence.is_empty()
        || requested_at.is_empty()
    {
        return Err(
            "Approval requests need identity, service, action, consequence, and time.".to_string(),
        );
    }
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err("Approval mode is not recognized.".to_string());
    }
    if !APPROVAL_RISK_LEVELS.contains(&risk_level.as_str()) {
        return Err("Approval risk level is not recognized.".to_string());
    }
    if decisions.is_empty() {
        return Err("Approval requests need at least one available decision.".to_string());
    }

    Ok(ApprovalRequest {
        id,
        service,
        action,
        mode,
        risk_level,
        data_used: normalize_approval_data(request.data_used),
        consequence,
        requested_at,
        decisions,
        confirmation_phrase,
    })
}

pub(crate) fn normalize_approval_grant(grant: ApprovalGrant) -> Result<ApprovalGrant, String> {
    let id = truncate_characters(
        &normalize_spaces(&grant.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let request_id = truncate_characters(
        &normalize_spaces(&grant.request_id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let scope = normalize_spaces(&grant.scope).to_ascii_lowercase();
    let service = truncate_characters(
        &normalize_spaces(&grant.service),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let action = truncate_characters(
        &normalize_spaces(&grant.action),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );
    let mode = normalize_spaces(&grant.mode).to_ascii_lowercase();
    let created_at = normalize_spaces(&grant.created_at);

    if id.is_empty()
        || request_id.is_empty()
        || service.is_empty()
        || action.is_empty()
        || created_at.is_empty()
    {
        return Err("Approval grants need stable request and scope metadata.".to_string());
    }
    if scope != "session" && scope != "rule" {
        return Err("Approval grant scope is not recognized.".to_string());
    }
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err("Approval grant mode is not recognized.".to_string());
    }

    Ok(ApprovalGrant {
        id,
        request_id,
        scope,
        service,
        action,
        mode,
        data_used: normalize_approval_data(grant.data_used),
        created_at,
    })
}

pub(crate) fn read_approval_rules(path: &Path) -> Result<Vec<ApprovalGrant>, String> {
    if let Some(rules) = crate::store::read_document(path)? {
        return Ok(rules);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Mivlet could not read approval rules.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<ApprovalGrant>>(&contents)
        .map_err(|_| "Mivlet could not parse approval rules.".to_string())?;
    parsed
        .into_iter()
        .map(normalize_approval_grant)
        .collect::<Result<Vec<_>, _>>()
}

fn write_approval_rules(path: &Path, rules: &[ApprovalGrant]) -> Result<(), String> {
    if crate::store::write_document(path, &rules)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(rules)
        .map_err(|_| "Mivlet could not encode approval rules.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Mivlet could not save approval rules.".to_string())
}

pub(crate) fn persist_approval_rule(
    path: &Path,
    grant: ApprovalGrant,
) -> Result<ApprovalGrant, String> {
    let grant = normalize_approval_grant(grant)?;
    if grant.scope != "rule" {
        return Err("Only standing rule grants can be persisted.".to_string());
    }

    let mut rules = read_approval_rules(path)?;
    rules.retain(|existing| {
        !(existing.service == grant.service
            && existing.action == grant.action
            && existing.mode == grant.mode)
    });
    rules.insert(0, grant.clone());
    rules.truncate(MAX_APPROVAL_RULES);
    write_approval_rules(path, &rules)?;
    Ok(grant)
}

pub(crate) fn resolve_approval(
    request: ApprovalResolutionRequest,
) -> Result<ApprovalResolutionResponse, String> {
    // Validate and shorten display/audit fields below, but retain the exact
    // request for execution permits. Truncated command/file content cannot
    // fingerprint the original request (or distinguish changes past the cut).
    let exact_request = request.request.clone();
    let original = normalize_approval_request(request.request)?;
    let decision = normalize_spaces(&request.decision).to_ascii_lowercase();
    let decided_at = normalize_spaces(&request.decided_at);

    if !APPROVAL_DECISIONS.contains(&decision.as_str()) || !original.decisions.contains(&decision) {
        return Err("Approval decision is not available for this request.".to_string());
    }
    if decided_at.is_empty() {
        return Err("Approval decisions need a decision time.".to_string());
    }

    let effective_request = if decision == "modify" {
        let modification = request
            .modification
            .ok_or_else(|| "Modified approvals need a narrowed permission scope.".to_string())?;
        let mode = normalize_spaces(&modification.mode).to_ascii_lowercase();
        if !APPROVAL_MODES.contains(&mode.as_str()) {
            return Err("Modified approval mode is not recognized.".to_string());
        }

        ApprovalRequest {
            mode,
            data_used: normalize_approval_data(modification.data_used),
            consequence: truncate_characters(
                &normalize_spaces(&modification.consequence),
                MAX_MEMORY_VALUE_CHARACTERS,
            ),
            ..original.clone()
        }
    } else {
        original.clone()
    };

    if effective_request.consequence.is_empty() {
        return Err("Modified approvals need a consequence explanation.".to_string());
    }

    // confirmation_text is not consume authority. Minting rejects WebView echo
    // in `resolve_approval_for_mint` and requires a native OS confirm instead.

    let grant = match decision.as_str() {
        // Session/rule grants are display records. They do not mint reusable
        // execution authority; the one-time permit for this request is recorded
        // separately by `resolve_approval_request`.
        "session" | "rule" => Some(normalize_approval_grant(ApprovalGrant {
            id: format!(
                "approval-{}-{}",
                decision,
                file_slug(&format!(
                    "{}-{}",
                    effective_request.service, effective_request.action
                ))
            ),
            request_id: effective_request.id.clone(),
            scope: decision.clone(),
            service: effective_request.service.clone(),
            action: effective_request.action.clone(),
            mode: effective_request.mode.clone(),
            data_used: effective_request.data_used.clone(),
            created_at: decided_at.clone(),
        })?),
        _ => None,
    };
    let note = if decision == "modify" {
        format!(
            "{} {} modified to {} using {}",
            effective_request.service,
            effective_request.action,
            effective_request.mode,
            effective_request.data_used.join(", ")
        )
    } else {
        format!("{} {}", effective_request.service, effective_request.action)
    };
    let audit_entry = normalize_approval_audit_entry(ApprovalAuditEntry {
        id: format!(
            "{}-{}-{}",
            effective_request.id,
            decision,
            file_slug(&decided_at)
        ),
        request_id: effective_request.id.clone(),
        decision,
        decided_at,
        note,
    })?;

    let effective_request = if audit_entry.decision == "modify" {
        effective_request
    } else {
        exact_request
    };
    Ok(ApprovalResolutionResponse {
        persisted: false,
        audit_entry,
        effective_request,
        dismissed: true,
        grant,
    })
}

#[tauri::command]
pub fn list_approval_audit(app: tauri::AppHandle) -> Result<Vec<ApprovalAuditEntry>, String> {
    let path = approval_audit_path(&app)?;
    read_approval_audit_entries(&path)
}

#[tauri::command]
pub fn list_approval_rules(app: tauri::AppHandle) -> Result<Vec<ApprovalGrant>, String> {
    let path = approval_rules_path(&app)?;
    read_approval_rules(&path)
}

/// True when WebView copied the request's own confirmation phrase into
/// `confirmationText`. That equality cannot distinguish typing from XSS or
/// Full Access auto-mint, so minting treats it as untrusted echo.
pub(crate) fn webview_echoed_confirmation(
    confirmation_text: Option<&str>,
    confirmation_phrase: Option<&str>,
) -> bool {
    let expected = confirmation_phrase
        .map(normalize_spaces)
        .filter(|phrase| !phrase.is_empty());
    let Some(expected) = expected else {
        return false;
    };
    let provided = confirmation_text.map(normalize_spaces).unwrap_or_default();
    !provided.is_empty() && provided == expected
}

fn approval_is_high_risk(request: &ApprovalRequest) -> bool {
    matches!(request.risk_level.as_str(), "high" | "critical") || request.mode == "full-access"
}

fn decision_approves(decision: &str) -> bool {
    matches!(decision, "once" | "session" | "rule" | "modify")
}

/// Fail closed on echoed WebView phrases even if `native_confirm` would pass.
/// High-risk mint requires a native OS dialog, not renderer-supplied text.
pub(crate) fn ensure_permit_mint_confirmation(
    confirmation_text: Option<&str>,
    decision: &str,
    effective_request: &ApprovalRequest,
    native_confirm: impl FnOnce(&ApprovalRequest) -> Result<bool, String>,
) -> Result<(), String> {
    if !decision_approves(decision) || !approval_is_high_risk(effective_request) {
        return Ok(());
    }
    let phrase = effective_request
        .confirmation_phrase
        .as_deref()
        .ok_or_else(|| "High-risk approvals need a confirmation phrase.".to_string())?;
    if webview_echoed_confirmation(confirmation_text, Some(phrase)) {
        return Err(
            "WebView cannot mint a high-risk permit by echoing the confirmation phrase."
                .to_string(),
        );
    }
    if !native_confirm(effective_request)? {
        return Err("High-risk approval was not confirmed in the native dialog.".to_string());
    }
    Ok(())
}

pub(crate) fn resolve_approval_for_mint(
    request: ApprovalResolutionRequest,
    native_confirm: impl FnOnce(&ApprovalRequest) -> Result<bool, String>,
) -> Result<ApprovalResolutionResponse, String> {
    let confirmation_text = request.confirmation_text.clone();
    let response = resolve_approval(request)?;
    ensure_permit_mint_confirmation(
        confirmation_text.as_deref(),
        &response.audit_entry.decision,
        &response.effective_request,
        native_confirm,
    )?;
    Ok(response)
}

fn high_risk_permit_dialog_copy(request: &ApprovalRequest) -> String {
    format!(
        "{}\n\n{} — {}\n\nConfirm in this system dialog. Repeating the phrase from the app window cannot mint this permit.",
        request.consequence, request.service, request.action
    )
}

fn native_high_risk_permit_confirmed(request: &ApprovalRequest) -> Result<bool, String> {
    Ok(matches!(
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title("Approve this action?")
            .set_description(high_risk_permit_dialog_copy(request))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show(),
        rfd::MessageDialogResult::Ok
    ))
}

#[tauri::command]
pub fn resolve_approval_request(
    app: tauri::AppHandle,
    request: ApprovalResolutionRequest,
) -> Result<ApprovalResolutionResponse, String> {
    let req = request.request.clone();
    let decision = request.decision.clone();
    let response = resolve_approval_for_mint(request, native_high_risk_permit_confirmed)?;
    let audit_path = approval_audit_path(&app)?;
    let audit = persist_approval_audit_entry(&audit_path, response.audit_entry)?;
    let grant = match response.grant {
        Some(grant) if grant.scope == "rule" => {
            let path = approval_rules_path(&app)?;
            Some(persist_approval_rule(&path, grant)?)
        }
        grant => grant,
    };

    // Capture the audit-note + decision time before they are moved into the
    // persisted response, so the unified action-history recorder can observe the
    // resolution (observation only; the typed approval table + execution permit
    // remain the authority).
    let audit_note = audit.entry.note.clone();
    let audit_decided_at = audit.entry.decided_at.clone();

    let persisted_response = ApprovalResolutionResponse {
        persisted: true,
        audit_entry: audit.entry,
        effective_request: response.effective_request,
        dismissed: response.dismissed,
        grant,
    };
    record_execution_decision(&execution_approvals_path(&app)?, &persisted_response)?;
    crate::action_history::Recorder::new(
        crate::action_history::categories::APPROVAL,
        &req.service,
        &req.action,
        &decision,
    )
    .actor("user")
    .mode(&req.mode)
    .risk(&req.risk_level)
    .correlation(&req.id)
    .summary(&audit_note)
    .detail(serde_json::json!({
        "requestId": req.id,
        "dataUsed": req.data_used,
        "consequence": req.consequence,
        "decidedAt": audit_decided_at,
    }))
    .record();
    Ok(persisted_response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ApprovalRequest, ApprovalResolutionRequest};

    fn high_risk_request() -> ApprovalRequest {
        ApprovalRequest {
            id: "approval-1".into(),
            service: "Mivlet tools".into(),
            action: "write-file a.txt".into(),
            mode: "full-access".into(),
            risk_level: "high".into(),
            data_used: vec!["path".into(), "content".into()],
            consequence: "Writes a workspace file.".into(),
            requested_at: "2026-06-27T12:00:00Z".into(),
            decisions: vec!["once".into(), "deny".into()],
            confirmation_phrase: Some("write file".into()),
        }
    }

    fn resolution(
        request: ApprovalRequest,
        confirmation_text: Option<&str>,
    ) -> ApprovalResolutionRequest {
        ApprovalResolutionRequest {
            request,
            decision: "once".into(),
            decided_at: "2026-06-27T12:00:01Z".into(),
            confirmation_text: confirmation_text.map(str::to_string),
            modification: None,
        }
    }

    #[test]
    fn echoed_confirmation_matches_normalized_phrase() {
        assert!(webview_echoed_confirmation(
            Some("  write file  "),
            Some("write file")
        ));
        assert!(!webview_echoed_confirmation(None, Some("write file")));
        assert!(!webview_echoed_confirmation(
            Some("other"),
            Some("write file")
        ));
        assert!(!webview_echoed_confirmation(Some("write file"), None));
    }

    #[test]
    fn resolve_approval_does_not_treat_echo_as_consume_authority() {
        resolve_approval(resolution(high_risk_request(), Some("write file")))
            .expect("shape-only resolve ignores echoed confirmation text");
        resolve_approval(resolution(high_risk_request(), None))
            .expect("shape-only resolve does not require confirmation text");
    }

    #[test]
    fn echoed_phrase_cannot_mint_even_when_native_confirm_would_pass() {
        let mut native_called = false;
        let error =
            resolve_approval_for_mint(resolution(high_risk_request(), Some("write file")), |_| {
                native_called = true;
                Ok(true)
            })
            .expect_err("echoed confirmation text cannot mint");
        assert!(error.contains("echoing the confirmation phrase"), "{error}");
        assert!(
            !native_called,
            "echo reject must not fall through to native confirm"
        );
    }

    #[test]
    fn omitted_confirmation_text_mints_only_after_native_confirm() {
        resolve_approval_for_mint(resolution(high_risk_request(), None), |_| Ok(true))
            .expect("native confirm mints without WebView phrase replay");

        let error = resolve_approval_for_mint(resolution(high_risk_request(), None), |_| Ok(false))
            .expect_err("declined native dialog cannot mint");
        assert!(error.contains("native dialog"), "{error}");
    }

    #[test]
    fn deny_does_not_require_native_confirm() {
        let mut request = resolution(high_risk_request(), None);
        request.decision = "deny".into();
        resolve_approval_for_mint(request, |_| {
            panic!("deny must not open a native confirm dialog")
        })
        .expect("deny is not a high-risk mint");
    }
}
