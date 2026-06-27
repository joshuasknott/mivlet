//! Approval audit log, standing approval rules, and approval resolution.
//!
//! Public Tauri commands (names must stay stable): `list_approval_audit`,
//! `list_approval_rules`, `record_approval_decision`,
//! `resolve_approval_request`.

use std::{collections::HashSet, fs, path::Path};

use crate::models::{
    ApprovalAuditEntry, ApprovalAuditRecordResponse, ApprovalGrant, ApprovalRequest,
    ApprovalResolutionRequest, ApprovalResolutionResponse, APPROVAL_DECISIONS, APPROVAL_MODES,
    APPROVAL_RISK_LEVELS, MAX_APPROVAL_AUDIT_ENTRIES, MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    MAX_APPROVAL_RULES, MAX_MEMORY_TITLE_CHARACTERS, MAX_MEMORY_VALUE_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
};
use crate::paths::{
    approval_audit_path, approval_rules_path, file_slug, normalize_spaces, truncate_characters,
};

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
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read the approval audit log.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<ApprovalAuditEntry>>(&contents)
        .map_err(|_| "Fable could not parse the approval audit log.".to_string())
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
    let encoded = serde_json::to_string_pretty(entries)
        .map_err(|_| "Fable could not encode the approval audit log.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Fable could not save the approval audit log.".to_string())
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
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(path).map_err(|_| "Fable could not read approval rules.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<ApprovalGrant>>(&contents)
        .map_err(|_| "Fable could not parse approval rules.".to_string())?;
    parsed
        .into_iter()
        .map(normalize_approval_grant)
        .collect::<Result<Vec<_>, _>>()
}

fn write_approval_rules(path: &Path, rules: &[ApprovalGrant]) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(rules)
        .map_err(|_| "Fable could not encode approval rules.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Fable could not save approval rules.".to_string())
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

    let approving = matches!(decision.as_str(), "once" | "session" | "rule" | "modify");
    let high_risk = matches!(effective_request.risk_level.as_str(), "high" | "critical")
        || effective_request.mode == "full-access";
    if approving && high_risk {
        let expected = effective_request
            .confirmation_phrase
            .as_deref()
            .ok_or_else(|| "High-risk approvals need a confirmation phrase.".to_string())?;
        let provided = request
            .confirmation_text
            .as_deref()
            .map(normalize_spaces)
            .unwrap_or_default();
        if provided != expected {
            return Err("Confirmation phrase did not match.".to_string());
        }
    }

    let grant = match decision.as_str() {
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

#[tauri::command]
pub fn record_approval_decision(
    app: tauri::AppHandle,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let path = approval_audit_path(&app)?;
    persist_approval_audit_entry(&path, entry)
}

#[tauri::command]
pub fn resolve_approval_request(
    app: tauri::AppHandle,
    request: ApprovalResolutionRequest,
) -> Result<ApprovalResolutionResponse, String> {
    let response = resolve_approval(request)?;
    let audit_path = approval_audit_path(&app)?;
    let audit = persist_approval_audit_entry(&audit_path, response.audit_entry)?;
    let grant = match response.grant {
        Some(grant) if grant.scope == "rule" => {
            let path = approval_rules_path(&app)?;
            Some(persist_approval_rule(&path, grant)?)
        }
        grant => grant,
    };

    Ok(ApprovalResolutionResponse {
        persisted: true,
        audit_entry: audit.entry,
        effective_request: response.effective_request,
        dismissed: response.dismissed,
        grant,
    })
}
