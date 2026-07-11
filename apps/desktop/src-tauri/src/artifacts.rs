//! Native boundary for the first durable, sourced response artifact.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent_runs::normalize_agent_run;
use crate::models::{PersistedAgentRun, RunContextReceipt};
use crate::store::repos::{artifact, run, scope::DataScope, workspace_directory};

const MAX_INLINE_BYTES: usize = 65_536;

struct ArtifactAuthority {
    scope: DataScope,
    internal_user_id: String,
    member_id: String,
}

fn authority() -> Result<ArtifactAuthority, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member_id = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required to create artifacts.".into(),
                )
            })?;
            Ok(ArtifactAuthority {
                scope: DataScope::workspace(context.active_workspace.local_workspace_id)?,
                internal_user_id: context.internal_user_id,
                member_id,
            })
        })
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtifact {
    artifact_id: String,
    version_id: String,
    run_id: String,
    thread_id: String,
    message_id: String,
    title: String,
    content: String,
}

fn citations_from_receipt(receipt: &RunContextReceipt, artifact_id: &str) -> Vec<Value> {
    receipt
        .citations
        .iter()
        .enumerate()
        .map(|(index, citation)| json!({
            "id": format!("citation-{artifact_id}-{}", index + 1),
            "label": citation.title,
            "source": {"kind":"import","externalReference":citation.source_id,"observedAt":receipt.assembled_at},
            "locator": citation.chunk_id.as_deref().or(citation.source_path.as_deref()),
            "quotedText": citation.snippet,
        }))
        .collect()
}

#[tauri::command]
pub fn artifact_create_from_response(input: CreateArtifact) -> Result<Value, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let authority = authority()?;
    let scope = &authority.scope;
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 256 {
        return Err("Artifact title must be 1-256 characters.".into());
    }
    let bytes = input.content.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_INLINE_BYTES {
        return Err("Artifact content must be between 1 byte and 64 KiB.".into());
    }
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let hash = format!("{:x}", Sha256::digest(bytes));
    let provenance = json!({"kind":"run","runId":input.run_id,"externalReference":format!("message:{}", input.message_id),"observedAt":at});
    let media = json!({"mediaType":"text/markdown","byteLength":bytes.len(),"encoding":"utf-8"});
    let content_hash = json!({"algorithm":"sha-256","value":hash});
    let artifact_record = json!({
        "id":input.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local","visibility":"member-private",
        "ownerMemberId":authority.member_id,"schemaVersion":1,"revision":0,"createdByInternalUserId":authority.internal_user_id,
        "createdAt":at,"updatedAt":at,"kind":"document","status":"draft","title":title,
        "currentVersionId":input.version_id,"producingRunId":input.run_id,"sourceProvenance":[provenance.clone()],
        "context":{"threadId":input.thread_id},"reviews":[],"retention":{"status":"active"}
    });
    store
        .transaction(|tx| {
            let run_row = run::get_scoped(tx, store, scope, &input.run_id)?
                .ok_or_else(|| crate::store::StoreError::Invalid("Artifact run is unavailable.".into()))?;
            if run_row.status != "completed" || run_row.thread_id.as_deref() != Some(&input.thread_id) {
                return Err(crate::store::StoreError::Invalid(
                    "Only the matching completed run can provide artifact context.".into(),
                ));
            }
            let persisted: PersistedAgentRun = serde_json::from_value(run_row.payload)
                .map_err(|_| crate::store::StoreError::Invalid("Agent run payload is invalid.".into()))?;
            let persisted = normalize_agent_run(persisted).map_err(crate::store::StoreError::Invalid)?;
            let citations = persisted
                .context_receipt
                .as_ref()
                .map(|receipt| citations_from_receipt(receipt, &input.artifact_id))
                .unwrap_or_default();
            let version = json!({
                "id":input.version_id,"artifactId":input.artifact_id,"version":1,"status":"available","createdAt":at,
                "createdByInternalUserId":authority.internal_user_id,"content":{"kind":"inline","text":input.content,"media":media,"contentHash":content_hash},
                "media":media,"contentHash":content_hash,"provenance":provenance,"citations":citations,"lineage":[]
            });
            let payload = json!({"artifact":artifact_record,"version":version,"sourceMessageId":input.message_id});
            artifact::create(
                tx,
                store,
                &scope,
                &input.artifact_id,
                &input.run_id,
                &input.thread_id,
                &input.message_id,
                "document",
                &hash,
                bytes.len(),
                &at,
                &payload,
            )
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persisted(source_id: &str, title: &str) -> PersistedAgentRun {
        serde_json::from_value(json!({
            "id":"run-1","providerId":"openai","model":"gpt-5","status":"completed",
            "transcript":"Answer","threadId":"thread-1","exchanges":[],"turn":1,
            "pendingApprovalIds":[],"recoverable":false,"retryCount":0,
            "createdAt":"2026-07-11T10:00:00Z","updatedAt":"2026-07-11T10:01:00Z",
            "contextReceipt":{
                "version":1,"runId":"run-1","assembledAt":"2026-07-11T09:59:00Z",
                "scope":{"level":"thread","threadId":"thread-1"},
                "citations":[{
                    "sourceId":source_id,"title":title,"snippet":"Historical excerpt",
                    "provenance":"Local file","freshness":"Before refresh","trust":"untrusted",
                    "pinned":false,"score":0.8,"chunkId":"source#0","sourcePath":"docs/source.md",
                    "ranking":{"relevance":0.8,"recency":0.1,"authority":0.2,"pin":0.0,"feedback":0.0}
                }],
                "contributions":[{"id":source_id,"kind":"source","reason":"retrieved","citationId":"source#0"}]
            }
        })).unwrap()
    }

    #[test]
    fn artifact_citations_use_only_the_immutable_run_snapshot() {
        let run_a = normalize_agent_run(persisted("source-a", "Original A")).unwrap();
        let run_b = normalize_agent_run(persisted("source-b", "Other run B")).unwrap();
        let citations =
            citations_from_receipt(run_a.context_receipt.as_ref().unwrap(), "artifact-a");
        assert_eq!(citations[0]["source"]["externalReference"], "source-a");
        assert_eq!(citations[0]["label"], "Original A");
        assert_eq!(citations[0]["quotedText"], "Historical excerpt");
        assert_ne!(
            citations[0]["source"]["externalReference"],
            run_b.context_receipt.unwrap().citations[0].source_id
        );
    }

    #[test]
    fn renderer_supplied_citations_are_not_part_of_the_native_input() {
        let input: CreateArtifact = serde_json::from_value(json!({
            "artifactId":"artifact-a","versionId":"version-a","runId":"run-1",
            "threadId":"thread-1","messageId":"message-1","title":"Answer","content":"Answer",
            "citations":[{"sourceId":"forged-source"}]
        }))
        .unwrap();
        assert_eq!(input.run_id, "run-1");
        let encoded = serde_json::to_value(&json!({"runId":input.run_id})).unwrap();
        assert!(encoded.get("citations").is_none());
    }

    #[test]
    fn legacy_completed_run_without_receipt_produces_no_citations() {
        let mut legacy = persisted("source-a", "A");
        legacy.context_receipt = None;
        let normalized = normalize_agent_run(legacy).unwrap();
        let citations = normalized
            .context_receipt
            .as_ref()
            .map(|receipt| citations_from_receipt(receipt, "artifact-a"))
            .unwrap_or_default();
        assert!(citations.is_empty());
    }
}

#[tauri::command]
pub fn artifact_get(artifact_id: String) -> Result<Option<Value>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = authority()?.scope;
    store
        .with_conn(|tx| artifact::get(tx, store, &scope, &artifact_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn artifact_list_for_thread(thread_id: String) -> Result<Vec<Value>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = authority()?.scope;
    store
        .with_conn(|tx| artifact::list_for_thread(tx, store, &scope, &thread_id))
        .map_err(|e| e.to_string())
}
