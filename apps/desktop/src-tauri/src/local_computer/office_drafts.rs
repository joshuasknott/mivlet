//! Native, encrypted Office working drafts.
//!
//! The renderer never receives the source package.  It submits a bounded edit
//! manifest against an exact artifact receipt and revision; the native store
//! keeps the cumulative package bytes and immutable revisions behind the
//! account boundary.  Export is still an explicit native Save As operation.

use super::{artifacts, office_editing, LocalComputerState};
use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::outputs;
use crate::store::repos::conversation_ui;
use crate::store::StoreError;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const MAX_PACKAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_REVISIONS: usize = 64;
const MAX_EDITS_PER_REVISION: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeDraftEdit {
    pub kind: String,
    pub entry: String,
    pub selector: String,
    pub replacement: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeDraftRevision {
    number: i64,
    package: String,
    edits: Vec<OfficeDraftEdit>,
    #[serde(default = "legacy_author")]
    author: String,
    #[serde(default = "legacy_time")]
    created_at: String,
    #[serde(default = "legacy_provenance")]
    provenance: String,
}

fn legacy_author() -> String {
    "unknown".into()
}

fn legacy_time() -> String {
    "unknown".into()
}

fn legacy_provenance() -> String {
    "restored legacy Office draft".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeDraft {
    pub artifact_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub title: String,
    pub extension: String,
    pub current_revision_number: i64,
    pub revisions: Vec<OfficeDraftRevisionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<serde_json::Value>,
    pub preview_truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeDraftRevisionSummary {
    pub number: i64,
    pub edit_count: usize,
    pub edits: Vec<OfficeDraftEdit>,
    pub author: String,
    pub created_at: String,
    pub provenance: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftTarget {
    pub workspace_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub artifact_id: String,
    pub expected_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDraftRequest {
    #[serde(flatten)]
    pub target: DraftTarget,
    pub expected_revision_number: i64,
    pub kind: String,
    pub entry: String,
    pub selector: String,
    pub replacement: String,
    #[serde(default)]
    pub proposal_output_id: Option<String>,
    #[serde(default)]
    pub proposal_revision_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadDraftRequest {
    pub workspace_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub artifact_id: String,
    #[serde(default)]
    pub revision_number: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionRequest {
    #[serde(flatten)]
    pub target: DraftTarget,
    pub expected_revision_number: i64,
    pub kind: String,
    pub entry: String,
    pub selector: String,
    pub section_index: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionResponse {
    pub selection: String,
    pub reference: String,
    pub revision_number: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreDraftRequest {
    #[serde(flatten)]
    pub target: DraftTarget,
    pub revision_number: i64,
    pub expected_revision_number: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportDraftRequest {
    #[serde(flatten)]
    pub target: DraftTarget,
    pub revision_number: i64,
    pub expected_revision_number: i64,
}

fn key(artifact_id: &str) -> String {
    format!("office-draft:{artifact_id}")
}

fn decode_package(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "The saved Office draft is invalid.".to_string())?;
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("This Office draft is too large to reopen safely.".into());
    }
    Ok(bytes)
}

fn encode_package(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("This Office file is too large to edit as a working draft.".into());
    }
    Ok(STANDARD.encode(bytes))
}

fn package_fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn preview_for(
    record: &StoredDraft,
    revision_number: i64,
) -> Result<(Option<serde_json::Value>, bool), String> {
    let revision = record
        .revisions
        .iter()
        .find(|revision| revision.number == revision_number)
        .ok_or_else(|| "That Office revision is unavailable.".to_string())?;
    let bytes = decode_package(&revision.package)?;
    let Some((preview, truncated)) = super::office_preview::preview(&bytes, &record.extension)
    else {
        return Ok((None, false));
    };
    let (preview, images_omitted) = preview.without_images();
    let value = serde_json::to_value(preview)
        .map_err(|_| "The Office draft preview could not be serialized.".to_string())?;
    Ok((Some(value), truncated || images_omitted))
}

fn summary(record: &StoredDraft, revision_number: Option<i64>) -> Result<OfficeDraft, String> {
    let (preview, preview_truncated) = match revision_number {
        Some(number) => preview_for(record, number)?,
        None => (None, false),
    };
    Ok(OfficeDraft {
        artifact_id: record.artifact_id.clone(),
        conversation_id: record.conversation_id.clone(),
        agent_id: record.agent_id.clone(),
        title: record.title.clone(),
        extension: record.extension.clone(),
        current_revision_number: record.current_revision_number,
        revisions: record
            .revisions
            .iter()
            .map(|revision| OfficeDraftRevisionSummary {
                number: revision.number,
                edit_count: revision.edits.len(),
                edits: revision.edits.clone(),
                author: revision.author.clone(),
                created_at: revision.created_at.clone(),
                provenance: revision.provenance.clone(),
            })
            .collect(),
        preview,
        preview_truncated,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDraft {
    artifact_id: String,
    conversation_id: String,
    agent_id: String,
    title: String,
    extension: String,
    current_revision_number: i64,
    revisions: Vec<OfficeDraftRevision>,
}

fn load(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    conversation_id: &str,
    artifact_id: &str,
) -> Result<Option<StoredDraft>, String> {
    conversation_ui::get(
        conn,
        store,
        &scope.private,
        conversation_id,
        &key(artifact_id),
    )
    .map_err(|error| error.to_string())
}

fn ensure_identity(record: &StoredDraft, target: &DraftTarget) -> Result<(), String> {
    ensure_record_identity(
        record,
        &target.conversation_id,
        &target.agent_id,
        &target.artifact_id,
    )
}

fn ensure_record_identity(
    record: &StoredDraft,
    conversation_id: &str,
    agent_id: &str,
    artifact_id: &str,
) -> Result<(), String> {
    if record.artifact_id != artifact_id
        || record.conversation_id != conversation_id
        || record.agent_id != agent_id
    {
        return Err("This Office draft belongs to another conversation or agent.".into());
    }
    Ok(())
}

fn ensure_history_bound(record: &StoredDraft) -> Result<(), String> {
    let total = record
        .revisions
        .iter()
        .try_fold(0usize, |total, revision| {
            decode_package(&revision.package).map(|bytes| total.saturating_add(bytes.len()))
        })?;
    if total > MAX_HISTORY_BYTES {
        return Err("This Office draft has reached its history size limit. Export it and start a new draft.".into());
    }
    Ok(())
}

fn cell_coordinates(selector: &str) -> Option<(usize, usize)> {
    let split = selector
        .char_indices()
        .find(|(_, value)| value.is_ascii_digit())
        .map(|(index, _)| index)?;
    let (letters, digits) = selector.split_at(split);
    if letters.is_empty()
        || digits.is_empty()
        || !letters.chars().all(|value| value.is_ascii_alphabetic())
    {
        return None;
    }
    let column = letters.chars().try_fold(0usize, |value, character| {
        value.checked_mul(26).and_then(|value| {
            value.checked_add(character.to_ascii_uppercase() as usize - 'A' as usize + 1)
        })
    })?;
    let row = digits.parse::<usize>().ok()?.checked_sub(1)?;
    Some((row, column.checked_sub(1)?))
}

fn selection_from_preview(
    preview: &serde_json::Value,
    request: &SelectionRequest,
    revision_number: i64,
    fingerprint: &str,
) -> Result<SelectionResponse, String> {
    let section_index = request.section_index.unwrap_or(0);
    let section = preview
        .get("sections")
        .and_then(|value| value.get(section_index))
        .ok_or_else(|| "The selected Office section is unavailable.".to_string())?;
    if section
        .get("sourceEntry")
        .and_then(serde_json::Value::as_str)
        != Some(request.entry.as_str())
    {
        return Err("The selected Office source entry is stale or unavailable.".into());
    }
    let blocks = section
        .get("blocks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "The selected Office section has no editable content.".to_string())?;
    let selection = if request.kind.eq_ignore_ascii_case("paragraph") {
        let wanted = request
            .selector
            .parse::<usize>()
            .map_err(|_| "The selected paragraph is invalid.".to_string())?;
        blocks
            .iter()
            .filter(|block| {
                block.get("type").and_then(serde_json::Value::as_str) == Some("paragraph")
            })
            .nth(wanted)
            .and_then(|block| block.get("text").and_then(serde_json::Value::as_str))
            .ok_or_else(|| "The selected paragraph is stale or unavailable.".to_string())?
            .to_string()
    } else if request.kind.eq_ignore_ascii_case("cell") {
        let (row, column) = cell_coordinates(&request.selector)
            .ok_or_else(|| "The selected spreadsheet cell is invalid.".to_string())?;
        blocks
            .iter()
            .filter(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("table"))
            .find_map(|block| {
                block
                    .get("rows")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|rows| rows.get(row))
                    .and_then(serde_json::Value::as_array)
                    .and_then(|values| values.get(column))
                    .and_then(serde_json::Value::as_str)
            })
            .ok_or_else(|| "The selected spreadsheet cell is stale or unavailable.".to_string())?
            .to_string()
    } else {
        return Err("Choose a supported Office paragraph or cell target.".into());
    };
    Ok(SelectionResponse {
        selection,
        reference: format!(
            "Office artifact {} · workspace {} · conversation {} · agent {} · revision {revision_number} · content {fingerprint} · {}:{}",
            request.target.artifact_id,
            request.target.workspace_id,
            request.target.conversation_id,
            request.target.agent_id,
            request.entry,
            request.selector,
        ),
        revision_number,
    })
}

fn ensure_revision_capacity(record: &StoredDraft) -> Result<(), String> {
    if record.revisions.len() >= MAX_REVISIONS {
        return Err(
            "This Office draft has reached its revision limit. Export it and start a new draft."
                .into(),
        );
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn verify_agent_proposal(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    request: &SaveDraftRequest,
) -> Result<(), String> {
    let Some(output_id) = request.proposal_output_id.as_deref() else {
        if request.proposal_revision_id.is_some() {
            return Err("The Office agent proposal identity is incomplete.".into());
        }
        return Ok(());
    };
    let Some(proposal_revision_id) = request.proposal_revision_id.as_deref() else {
        return Err("The Office agent proposal identity is incomplete.".into());
    };
    let output = outputs::read_row(conn, store, scope, output_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The Office agent proposal is no longer available.".to_string())?;
    let source = &output.source;
    if source.conversation_id != request.target.conversation_id
        || source.artifact_id.as_deref() != Some(request.target.artifact_id.as_str())
        || source.agent_id.as_deref() != Some(request.target.agent_id.as_str())
    {
        return Err("The Office agent proposal belongs to another source.".into());
    }
    if output.current_revision_id != proposal_revision_id {
        return Err("This Office agent proposal changed. Reload it before applying.".into());
    }
    let revision = output
        .revisions
        .iter()
        .find(|revision| revision.id == proposal_revision_id)
        .ok_or_else(|| "The Office agent proposal revision is unavailable.".to_string())?;
    if revision.author != "agent" || revision.provenance.reason != "agent-revision" {
        return Err("Only a completed agent revision proposal can be applied.".into());
    }
    let value: serde_json::Value = serde_json::from_str(&revision.content)
        .map_err(|_| "The Office agent proposal is not valid JSON.".to_string())?;
    let original: serde_json::Value = output
        .revisions
        .first()
        .and_then(|revision| serde_json::from_str(&revision.content).ok())
        .ok_or("The original Office edit target is unavailable.")?;
    if ["kind", "entry", "selector", "baseRevision"]
        .iter()
        .any(|key| value.get(*key) != original.get(*key))
    {
        return Err("The agent changed the requested Office target. Request a new proposal for that target.".into());
    }
    let matches = value.get("kind").and_then(serde_json::Value::as_str)
        == Some(request.kind.as_str())
        && value.get("entry").and_then(serde_json::Value::as_str) == Some(request.entry.as_str())
        && value.get("selector").and_then(serde_json::Value::as_str)
            == Some(request.selector.as_str())
        && value.get("replacement").and_then(serde_json::Value::as_str)
            == Some(request.replacement.as_str())
        && value
            .get("baseRevision")
            .and_then(serde_json::Value::as_i64)
            == Some(request.expected_revision_number);
    if !matches {
        return Err(
            "The Office agent proposal no longer matches the selected Office target.".into(),
        );
    }
    Ok(())
}

fn validate_request(request: &SaveDraftRequest) -> Result<(), String> {
    if request.expected_revision_number < 0
        || request.replacement.len() > 32_000
        || request.kind.len() > 32
        || request.entry.len() > 256
        || request.selector.len() > 256
        || request.entry.contains(['\\', ':'])
        || request
            .entry
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("The Office edit target is invalid or too large.".into());
    }
    Ok(())
}

fn apply_save(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    request: SaveDraftRequest,
    state: &Arc<LocalComputerState>,
) -> Result<OfficeDraft, String> {
    validate_request(&request)?;
    outputs::validate_conversation_agent(
        conn,
        store,
        &request.target.conversation_id,
        &request.target.agent_id,
        scope,
    )
    .map_err(|error| error.to_string())?;
    let authority = state.authority_for(&request.target.workspace_id, &request.target.agent_id)?;
    let ticket = authority.begin_viewer(request.target.expected_generation)?;
    let verified = artifacts::verified_artifact(
        state,
        &artifacts::OpenArtifactRequest {
            workspace_id: request.target.workspace_id.clone(),
            agent_id: request.target.agent_id.clone(),
            artifact_id: request.target.artifact_id.clone(),
            expected_generation: request.target.expected_generation,
        },
    )?;
    ticket.check()?;
    let (receipt, base_bytes) = verified;
    let extension = receipt
        .artifact
        .relative_path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or_else(|| "The Office artifact extension is unavailable.".to_string())?;
    if !matches!(extension.as_str(), "docx" | "xlsx") {
        return Err("Working drafts support DOCX and XLSX files only.".into());
    }
    let mut record = load(
        conn,
        store,
        scope,
        &request.target.conversation_id,
        &request.target.artifact_id,
    )?
    .unwrap_or_else(|| StoredDraft {
        artifact_id: request.target.artifact_id.clone(),
        conversation_id: request.target.conversation_id.clone(),
        agent_id: request.target.agent_id.clone(),
        title: receipt.artifact.title.clone(),
        extension: extension.clone(),
        current_revision_number: 0,
        revisions: vec![OfficeDraftRevision {
            number: 0,
            package: STANDARD.encode(&base_bytes),
            edits: Vec::new(),
            author: "system".into(),
            created_at: now(),
            provenance: "generated artifact".into(),
        }],
    });
    ensure_identity(&record, &request.target)?;
    verify_agent_proposal(conn, store, scope, &request)?;
    if record.extension != extension {
        return Err("The Office draft format changed and must be reopened.".into());
    }
    ensure_history_bound(&record)?;
    if record.current_revision_number != request.expected_revision_number {
        return Err("This Office draft changed in another pane. Reload it before saving.".into());
    }
    ensure_revision_capacity(&record)?;
    let current = record
        .revisions
        .iter()
        .find(|revision| revision.number == record.current_revision_number)
        .ok_or_else(|| "The current Office draft revision is unavailable.".to_string())?;
    let package = decode_package(&current.package)?;
    let kind = if request.kind.eq_ignore_ascii_case("paragraph") {
        office_editing::OfficeEditKind::DocxParagraph
    } else if request.kind.eq_ignore_ascii_case("cell") {
        office_editing::OfficeEditKind::XlsxCell
    } else {
        return Err("Choose a supported Office paragraph or cell target.".into());
    };
    if (extension == "docx" && kind != office_editing::OfficeEditKind::DocxParagraph)
        || (extension == "xlsx" && kind != office_editing::OfficeEditKind::XlsxCell)
    {
        return Err("The Office edit kind does not match this file.".into());
    }
    let edited = office_editing::edit_package(
        &package,
        &office_editing::OfficeEdit {
            kind,
            entry: request.entry.clone(),
            selector: request.selector.clone(),
            replacement: request.replacement.clone(),
        },
    )?;
    let next_number = record.current_revision_number + 1;
    let provenance = match (&request.proposal_output_id, &request.proposal_revision_id) {
        (Some(output), Some(revision)) => format!(
            "{} {} {}; proposal {} revision {}",
            request.kind, request.entry, request.selector, output, revision
        ),
        _ => format!("{} {} {}", request.kind, request.entry, request.selector),
    };
    let mut edits = current.edits.clone();
    edits.push(OfficeDraftEdit {
        kind: request.kind.clone(),
        entry: request.entry.clone(),
        selector: request.selector.clone(),
        replacement: request.replacement.clone(),
    });
    if edits.len() > MAX_EDITS_PER_REVISION {
        return Err(
            "This Office draft has reached its edit limit. Export it and start a new draft.".into(),
        );
    }
    record.current_revision_number = next_number;
    record.revisions.push(OfficeDraftRevision {
        number: next_number,
        package: encode_package(&edited)?,
        edits,
        author: if request.proposal_output_id.is_some() {
            "agent"
        } else {
            "user"
        }
        .into(),
        created_at: now(),
        provenance,
    });
    ensure_history_bound(&record)?;
    conversation_ui::put(
        conn,
        store,
        &scope.private,
        &request.target.conversation_id,
        &key(&request.target.artifact_id),
        &record,
    )
    .map_err(|error| error.to_string())?;
    summary(&record, Some(next_number))
}

#[tauri::command]
pub fn office_draft_save(
    window: tauri::WebviewWindow,
    request: SaveDraftRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<OfficeDraft, String> {
    if window.label() != "main" {
        return Err("Edit the Office draft from its Mivlet conversation.".into());
    }
    let scope = command_scope(
        Some(request.target.workspace_id.clone()),
        None,
        ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let state = computers.inner().clone();
    store
        .transaction(|conn| {
            apply_save(conn, store, &scope, request, &state).map_err(StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn office_draft_get(
    window: tauri::WebviewWindow,
    request: LoadDraftRequest,
) -> Result<Option<OfficeDraft>, String> {
    if window.label() != "main" {
        return Err("Open the Office draft from its Mivlet conversation.".into());
    }
    let scope = command_scope(Some(request.workspace_id), None, ScopeAccess::Read)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            outputs::validate_conversation_agent(
                conn,
                store,
                &request.conversation_id,
                &request.agent_id,
                &scope,
            )?;
            let record = load(
                conn,
                store,
                &scope,
                &request.conversation_id,
                &request.artifact_id,
            )
            .map_err(StoreError::Invalid)?;
            let Some(record) = record else {
                return Ok(None);
            };
            ensure_record_identity(
                &record,
                &request.conversation_id,
                &request.agent_id,
                &request.artifact_id,
            )
            .map_err(StoreError::Invalid)?;
            summary(
                &record,
                Some(
                    request
                        .revision_number
                        .unwrap_or(record.current_revision_number),
                ),
            )
            .map(Some)
            .map_err(StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn office_draft_selection(
    window: tauri::WebviewWindow,
    request: SelectionRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<SelectionResponse, String> {
    if window.label() != "main" {
        return Err("Inspect the Office selection from its Mivlet conversation.".into());
    }
    let scope = command_scope(
        Some(request.target.workspace_id.clone()),
        None,
        ScopeAccess::Read,
    )?;
    let state = computers.inner().clone();
    let authority = state.authority_for(&request.target.workspace_id, &request.target.agent_id)?;
    let ticket = authority.begin_viewer(request.target.expected_generation)?;
    let (receipt, original_bytes) = artifacts::verified_artifact(
        &state,
        &artifacts::OpenArtifactRequest {
            workspace_id: request.target.workspace_id.clone(),
            agent_id: request.target.agent_id.clone(),
            artifact_id: request.target.artifact_id.clone(),
            expected_generation: request.target.expected_generation,
        },
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            outputs::validate_conversation_agent(
                conn,
                store,
                &request.target.conversation_id,
                &request.target.agent_id,
                &scope,
            )?;
            let record = load(
                conn,
                store,
                &scope,
                &request.target.conversation_id,
                &request.target.artifact_id,
            )
            .map_err(StoreError::Invalid)?;
            let (preview, fingerprint, extension, revision_number) = if let Some(record) = record {
                ensure_identity(&record, &request.target).map_err(StoreError::Invalid)?;
                if record.current_revision_number != request.expected_revision_number {
                    return Err(StoreError::Invalid(
                        "This Office draft changed in another pane. Reload it before selecting text.".into(),
                    ));
                }
                let revision = record
                    .revisions
                    .iter()
                    .find(|revision| revision.number == request.expected_revision_number)
                    .ok_or_else(|| StoreError::Invalid("The Office draft revision is unavailable.".into()))?;
                let bytes = decode_package(&revision.package).map_err(StoreError::Invalid)?;
                let (preview, _) = super::office_preview::preview(&bytes, &record.extension)
                    .ok_or_else(|| StoreError::Invalid("This Office draft has no selectable preview.".into()))?;
                let (preview, _) = preview.without_images();
                (
                    serde_json::to_value(preview).map_err(|_| StoreError::Invalid("The Office draft preview could not be serialized.".into()))?,
                    package_fingerprint(&bytes),
                    record.extension,
                    request.expected_revision_number,
                )
            } else {
                if request.expected_revision_number != 0 {
                    return Err(StoreError::Invalid("The original Office artifact has revision 0; reload before selecting text.".into()));
                }
                let extension = receipt
                    .artifact
                    .relative_path
                    .rsplit_once('.')
                    .map(|(_, extension)| extension.to_ascii_lowercase())
                    .ok_or_else(|| StoreError::Invalid("The Office artifact extension is unavailable.".into()))?;
                let (preview, _) = super::office_preview::preview(&original_bytes, &extension)
                    .ok_or_else(|| StoreError::Invalid("This Office artifact has no selectable preview.".into()))?;
                let (preview, _) = preview.without_images();
                (
                    serde_json::to_value(preview).map_err(|_| StoreError::Invalid("The Office artifact preview could not be serialized.".into()))?,
                    receipt.sha256.clone(),
                    extension,
                    0,
                )
            };
            if (request.kind.eq_ignore_ascii_case("paragraph") && extension != "docx")
                || (request.kind.eq_ignore_ascii_case("cell") && extension != "xlsx")
            {
                return Err(StoreError::Invalid(
                    "The Office selection kind does not match this file.".into(),
                ));
            }
            let response = selection_from_preview(&preview, &request, revision_number, &fingerprint)
                .map_err(StoreError::Invalid)?;
            ticket.check().map_err(StoreError::Invalid)?;
            Ok(response)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn office_draft_restore(
    window: tauri::WebviewWindow,
    request: RestoreDraftRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<OfficeDraft, String> {
    if window.label() != "main" {
        return Err("Restore the Office draft from its Mivlet conversation.".into());
    }
    let scope = command_scope(
        Some(request.target.workspace_id.clone()),
        None,
        ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let authority = computers
        .inner()
        .authority_for(&request.target.workspace_id, &request.target.agent_id)?;
    let ticket = authority.begin_viewer(request.target.expected_generation)?;
    ticket.check()?;
    store
        .transaction(|conn| {
            outputs::validate_conversation_agent(
                conn,
                store,
                &request.target.conversation_id,
                &request.target.agent_id,
                &scope,
            )?;
            let mut record = load(
                conn,
                store,
                &scope,
                &request.target.conversation_id,
                &request.target.artifact_id,
            )
            .map_err(StoreError::Invalid)?
            .ok_or_else(|| StoreError::Invalid("The Office draft is unavailable.".into()))?;
            ensure_identity(&record, &request.target).map_err(StoreError::Invalid)?;
            if record.current_revision_number != request.expected_revision_number {
                return Err(StoreError::Invalid(
                    "This Office draft changed in another pane. Reload it before restoring.".into(),
                ));
            }
            let selected = record
                .revisions
                .iter()
                .find(|revision| revision.number == request.revision_number)
                .cloned()
                .ok_or_else(|| StoreError::Invalid("That Office revision is unavailable.".into()))?;
            ensure_revision_capacity(&record).map_err(StoreError::Invalid)?;
            let number = record.current_revision_number + 1;
            record.current_revision_number = number;
            let mut edits = selected.edits.clone();
            edits.push(OfficeDraftEdit {
                kind: "restore".into(),
                entry: String::new(),
                selector: request.revision_number.to_string(),
                replacement: String::new(),
            });
            if edits.len() > MAX_EDITS_PER_REVISION {
                return Err(StoreError::Invalid(
                    "This Office draft has reached its edit limit. Export it and start a new draft.".into(),
                ));
            }
            record.revisions.push(OfficeDraftRevision {
                number,
                package: selected.package,
                edits,
                author: "user".into(),
                created_at: now(),
                provenance: format!("restored revision {}", request.revision_number),
            });
            ensure_history_bound(&record).map_err(StoreError::Invalid)?;
            conversation_ui::put(
                conn,
                store,
                &scope.private,
                &request.target.conversation_id,
                &key(&request.target.artifact_id),
                &record,
            )?;
            summary(&record, Some(number)).map_err(StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn office_draft_export(
    window: tauri::WebviewWindow,
    request: ExportDraftRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Export the Office draft from its Mivlet conversation.".into());
    }
    let scope = command_scope(
        Some(request.target.workspace_id.clone()),
        None,
        ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let state = computers.inner().clone();
    let authority = state.authority_for(&request.target.workspace_id, &request.target.agent_id)?;
    let ticket = authority.begin_viewer(request.target.expected_generation)?;
    let (title, extension, bytes) = store
        .with_conn(|conn| {
            outputs::validate_conversation_agent(
                conn,
                store,
                &request.target.conversation_id,
                &request.target.agent_id,
                &scope,
            )?;
            let record = load(
                conn,
                store,
                &scope,
                &request.target.conversation_id,
                &request.target.artifact_id,
            )
            .map_err(StoreError::Invalid)?
            .ok_or_else(|| StoreError::Invalid("The Office draft is unavailable.".into()))?;
            ensure_identity(&record, &request.target).map_err(StoreError::Invalid)?;
            if record.current_revision_number != request.expected_revision_number {
                return Err(StoreError::Invalid(
                    "This Office draft changed in another pane. Reload it before exporting.".into(),
                ));
            }
            let revision = record
                .revisions
                .iter()
                .find(|revision| revision.number == request.revision_number)
                .ok_or_else(|| {
                    StoreError::Invalid("That Office revision is unavailable.".into())
                })?;
            Ok((
                record.title.clone(),
                record.extension.clone(),
                decode_package(&revision.package).map_err(StoreError::Invalid)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    ticket.check()?;
    let file_name = format!(
        "{}-revision-{}.{}",
        title, request.revision_number, extension
    );
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Export Office draft")
        .set_file_name(&file_name)
        .add_filter("Office document", &[extension.as_str()])
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(false);
    };
    ticket.check()?;
    let post_scope = command_scope(
        Some(request.target.workspace_id.clone()),
        None,
        ScopeAccess::Read,
    )?;
    if post_scope.private.workspace_id() != scope.private.workspace_id()
        || post_scope.private.owner_subject() != scope.private.owner_subject()
    {
        return Err(
            "Your account changed while the Office export dialog was open. Export again.".into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let staged = artifacts::stage_export(selected.path(), &extension, &bytes)?;
        ticket.commit(|| artifacts::commit_export(staged, selected.path()))
    })
    .await
    .map_err(|_| "Mivlet could not export the Office draft.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_request_accepts_the_flat_renderer_contract() {
        let request: SaveDraftRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace-local","conversationId":"conversation","agentId":"agent","artifactId":"artifact","expectedGeneration":1,
            "expectedRevisionNumber":0,"kind":"cell","entry":"xl/worksheets/sheet1.xml","selector":"A1","replacement":"12"
        })).unwrap();
        assert_eq!(request.target.artifact_id, "artifact");
        assert_eq!(request.expected_revision_number, 0);
    }

    #[test]
    fn save_request_allows_empty_text_replacements() {
        let request: SaveDraftRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace-local","conversationId":"conversation","agentId":"agent","artifactId":"artifact","expectedGeneration":1,
            "expectedRevisionNumber":0,"kind":"paragraph","entry":"word/document.xml","selector":"0","replacement":""
        })).unwrap();
        assert!(validate_request(&request).is_ok());
    }

    fn record(revisions: usize) -> StoredDraft {
        StoredDraft {
            artifact_id: "artifact".into(),
            conversation_id: "conversation".into(),
            agent_id: "agent".into(),
            title: "Draft".into(),
            extension: "docx".into(),
            current_revision_number: revisions.saturating_sub(1) as i64,
            revisions: (0..revisions)
                .map(|number| OfficeDraftRevision {
                    number: number as i64,
                    package: STANDARD.encode(b"package"),
                    edits: Vec::new(),
                    author: "user".into(),
                    created_at: now(),
                    provenance: "test".into(),
                })
                .collect(),
        }
    }

    #[test]
    fn revision_capacity_is_rejected_without_dropping_history() {
        let draft = record(MAX_REVISIONS);
        assert!(ensure_revision_capacity(&draft).is_err());
        assert_eq!(
            draft.revisions.first().map(|revision| revision.number),
            Some(0)
        );
        assert_eq!(draft.revisions.len(), MAX_REVISIONS);
    }

    #[test]
    fn identity_requires_conversation_agent_and_artifact_match() {
        let draft = record(1);
        assert!(ensure_record_identity(&draft, "conversation", "agent", "artifact").is_ok());
        assert!(ensure_record_identity(&draft, "other", "agent", "artifact").is_err());
        assert!(ensure_record_identity(&draft, "conversation", "other", "artifact").is_err());
        assert!(ensure_record_identity(&draft, "conversation", "agent", "other").is_err());
    }

    #[test]
    fn legacy_revision_metadata_deserializes_with_explicit_provenance() {
        let value = serde_json::json!({
            "number": 0,
            "package": STANDARD.encode(b"package"),
            "edits": []
        });
        let revision: OfficeDraftRevision = serde_json::from_value(value).unwrap();
        assert_eq!(revision.author, "unknown");
        assert_eq!(revision.provenance, "restored legacy Office draft");
    }

    #[test]
    fn selection_reference_keeps_exact_source_identity_and_fingerprint() {
        let request: SelectionRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace",
            "conversationId":"conversation",
            "agentId":"agent",
            "artifactId":"artifact",
            "expectedGeneration":4,
            "expectedRevisionNumber":0,
            "kind":"paragraph",
            "entry":"word/document.xml",
            "selector":"0"
        }))
        .unwrap();
        let preview = serde_json::json!({
            "sections":[{
                "name":"Document",
                "sourceEntry":"word/document.xml",
                "blocks":[{"type":"paragraph","text":"Exact source text"}]
            }]
        });
        let response = selection_from_preview(&preview, &request, 0, "abc123").unwrap();
        assert_eq!(response.selection, "Exact source text");
        assert!(response.reference.contains("artifact"));
        assert!(response.reference.contains("workspace"));
        assert!(response.reference.contains("conversation"));
        assert!(response.reference.contains("agent"));
        assert!(response.reference.contains("content abc123"));
        assert!(response.reference.contains("word/document.xml:0"));
    }

    #[test]
    fn selection_from_preview_rejects_stale_entry_and_cell() {
        let request: SelectionRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace",
            "conversationId":"conversation",
            "agentId":"agent",
            "artifactId":"artifact",
            "expectedGeneration":4,
            "expectedRevisionNumber":0,
            "kind":"cell",
            "entry":"xl/worksheets/sheet1.xml",
            "selector":"B2"
        }))
        .unwrap();
        let preview = serde_json::json!({
            "sections":[{
                "name":"Sheet",
                "sourceEntry":"xl/worksheets/sheet2.xml",
                "blocks":[{"type":"table","rows":[["A1"]]}]
            }]
        });
        assert!(selection_from_preview(&preview, &request, 0, "fingerprint").is_err());
    }
}
