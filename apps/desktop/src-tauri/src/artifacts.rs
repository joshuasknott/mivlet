//! Native boundary for the first durable, sourced response artifact.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent_runs::normalize_agent_run;
use crate::models::{PersistedAgentRun, RunContextReceipt};
use crate::store::repos::{
    artifact, run,
    scope::{DataScope, PrivateDataScope},
    workspace_directory,
};

const MAX_INLINE_BYTES: usize = 65_536;

struct ArtifactAuthority {
    scope: PrivateDataScope,
    internal_user_id: String,
}

fn authority() -> Result<ArtifactAuthority, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let data = DataScope::workspace(context.active_workspace.local_workspace_id)?;
            Ok(ArtifactAuthority {
                scope: PrivateDataScope::for_authenticated_user(
                    data,
                    &context.internal_user_id,
                    context.member_id.as_deref(),
                )?,
                internal_user_id: context.internal_user_id,
            })
        })
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    let owner_fields = match scope.owner_member_id() {
        Some(member_id) => json!({"ownerMemberId":member_id}),
        None => json!({"ownerInternalUserId":scope.owner_internal_user_id()}),
    };
    let mut artifact_record = json!({
        "id":input.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local","visibility":"member-private",
        "schemaVersion":1,"revision":1,"createdByInternalUserId":authority.internal_user_id,
        "createdAt":at,"updatedAt":at,"kind":"document","status":"draft","title":title,
        "currentVersionId":input.version_id,"producingRunId":input.run_id,"sourceProvenance":[provenance.clone()],
        "context":{"threadId":input.thread_id},"reviews":[],"retention":{"status":"active"}
    });
    artifact_record
        .as_object_mut()
        .unwrap()
        .extend(owner_fields.as_object().unwrap().clone());
    store
        .transaction(|tx| {
            let run_row = run::get_scoped(tx, store, scope.data(), &input.run_id)?
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
                "media":media,"contentHash":content_hash,"provenance":provenance,"citations":citations,
                "inputs":[],"decisions":[],"lineage":[]
            });
            artifact::create_private(
                tx,
                store,
                &scope,
                &input.artifact_id,
                &input.run_id,
                &input.thread_id,
                &input.message_id,
                "document",
                &format!("{:x}",Sha256::digest(title.as_bytes())),
                &hash,
                bytes.len(),
                &at,
                &artifact_record,
                &version,
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
    fn renderer_supplied_evidence_is_rejected_at_the_native_input() {
        let input = serde_json::from_value::<CreateArtifact>(json!({
            "artifactId":"artifact-a","versionId":"version-a","runId":"run-1",
            "threadId":"thread-1","messageId":"message-1","title":"Answer","content":"Answer",
            "citations":[{"sourceId":"forged-source"}]
        }));
        assert!(input.is_err());
        let append = serde_json::from_value::<AppendArtifactVersion>(json!({
            "artifactId":"artifact-a","expectedRevision":1,"expectedCurrentVersionId":"version-a",
            "content":{"kind":"inline","text":"Edited"},"decisions":[{"id":"forged"}]
        }));
        assert!(append.is_err());
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
        .with_conn(|tx| artifact::get_bundle(tx, store, &scope, &artifact_id))
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppendArtifactVersion {
    artifact_id: String,
    expected_revision: i64,
    expected_current_version_id: String,
    title: Option<String>,
    content: Value,
}

#[tauri::command]
pub fn artifact_append_version(input: AppendArtifactVersion) -> Result<Value, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let authority = authority()?;
    let text = input
        .content
        .get("text")
        .and_then(Value::as_str)
        .filter(|_| input.content.get("kind").and_then(Value::as_str) == Some("inline"))
        .ok_or_else(|| "Artifact edits currently require inline text content.".to_string())?;
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_INLINE_BYTES {
        return Err("Artifact content must be between 1 byte and 64 KiB.".into());
    }
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let hash = format!("{:x}", Sha256::digest(bytes));
    store.transaction(|tx|{
        let bundle=artifact::get_bundle(tx,store,&authority.scope,&input.artifact_id)?
            .ok_or_else(||crate::store::StoreError::Invalid("Artifact is unavailable for this owner.".into()))?;
        let mut artifact_value=bundle.get("artifact").cloned()
            .ok_or_else(||crate::store::StoreError::Invalid("Artifact payload is invalid.".into()))?;
        let current=bundle.get("currentVersion")
            .ok_or_else(||crate::store::StoreError::Invalid("Artifact current version is invalid.".into()))?;
        let current_id=current.get("id").and_then(Value::as_str).unwrap_or_default();
        if current_id!=input.expected_current_version_id{
            return Err(crate::store::StoreError::Invalid("Artifact changed elsewhere. Reload it and try again.".into()))
        }
        let title=input.title.clone().unwrap_or_else(||artifact_value.get("title").and_then(Value::as_str).unwrap_or("Artifact").to_string());
        let title=title.trim().to_string();
        if title.is_empty()||title.chars().count()>256{return Err(crate::store::StoreError::Invalid("Artifact title must be 1-256 characters.".into()))}
        let next=bundle.get("versions").and_then(Value::as_array).map_or(1,|v|v.len()+1);
        let version_id=format!("{}:v{next}",input.artifact_id);
        let media=json!({"mediaType":"text/markdown","byteLength":bytes.len(),"encoding":"utf-8"});
        let content_hash=json!({"algorithm":"sha-256","value":hash});
        let version=json!({
            "id":version_id,"artifactId":input.artifact_id,"version":next,"status":"available",
            "createdAt":at,"createdByInternalUserId":authority.internal_user_id,
            "content":{"kind":"inline","text":text,"media":media,"contentHash":content_hash},
            "media":media,"contentHash":content_hash,
            "provenance":{"kind":"artifact-version","sourceArtifactVersionId":current_id,"observedAt":at},
            "citations":current.get("citations").cloned().unwrap_or_else(||json!([])),
            "inputs":current.get("inputs").cloned().unwrap_or_else(||json!([])),
            "decisions":current.get("decisions").cloned().unwrap_or_else(||json!([])),
            "lineage":[{"relation":"supersedes","artifactId":input.artifact_id,
                "artifactVersionId":current_id,"recordedAt":at}]
        });
        let object=artifact_value.as_object_mut().ok_or_else(||crate::store::StoreError::Invalid("Artifact payload is invalid.".into()))?;
        object.insert("title".into(),Value::String(title.clone()));
        object.insert("revision".into(),json!(input.expected_revision+1));
        object.insert("currentVersionId".into(),Value::String(version_id));
        object.insert("updatedAt".into(),Value::String(at.clone()));
        artifact::append_version(tx,store,&authority.scope,&input.artifact_id,input.expected_revision,
            &input.expected_current_version_id,&format!("{:x}",Sha256::digest(title.as_bytes())),
            &hash,bytes.len(),&at,&artifact_value,&version)
    }).map_err(|error|error.to_string())
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
