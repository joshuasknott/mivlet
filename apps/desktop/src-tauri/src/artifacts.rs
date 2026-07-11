//! Native boundary for the first durable, sourced response artifact.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::repos::{artifact, knowledge_source, scope::DataScope, workspace_directory};

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
pub struct SourceCitation {
    source_id: String,
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
    #[serde(default)]
    citations: Vec<SourceCitation>,
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
    if input.citations.len() > 100 {
        return Err("An artifact can preserve at most 100 sources.".into());
    }
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let hash = format!("{:x}", Sha256::digest(bytes));
    let provenance = json!({"kind":"run","runId":input.run_id,"externalReference":format!("message:{}", input.message_id),"observedAt":at});
    let citations = store
        .with_conn(|tx| {
            let sources = knowledge_source::list_scoped(tx, store, scope)?;
            input
                .citations
                .iter()
                .enumerate()
                .map(|(index, citation)| {
                    let source = sources
                        .iter()
                        .find(|source| source.id == citation.source_id)
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "An artifact source is unavailable in this workspace.".into(),
                            )
                        })?;
                    let title = source
                        .payload
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|title| !title.trim().is_empty())
                        .unwrap_or(&source.id);
                    let quoted_text = source
                        .payload
                        .get("contentPreview")
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty())
                        .or_else(|| source.payload.get("provenance").and_then(Value::as_str))
                        .unwrap_or("");
                    let locator = (!source.external_id.is_empty())
                        .then_some(source.external_id.as_str())
                        .or_else(|| (!source.origin.is_empty()).then_some(source.origin.as_str()));
                    Ok(json!({
                        "id": format!("citation-{}-{}", input.artifact_id, index + 1),
                        "label": title,
                        "source": {"kind":"import","externalReference":source.id,"observedAt":at},
                        "locator": locator,
                        "quotedText": quoted_text,
                    }))
                })
                .collect::<crate::store::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())?;
    let media = json!({"mediaType":"text/markdown","byteLength":bytes.len(),"encoding":"utf-8"});
    let content_hash = json!({"algorithm":"sha-256","value":hash});
    let artifact_record = json!({
        "id":input.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local","visibility":"member-private",
        "ownerMemberId":authority.member_id,"schemaVersion":1,"revision":0,"createdByInternalUserId":authority.internal_user_id,
        "createdAt":at,"updatedAt":at,"kind":"document","status":"draft","title":title,
        "currentVersionId":input.version_id,"producingRunId":input.run_id,"sourceProvenance":[provenance.clone()],
        "context":{"threadId":input.thread_id},"reviews":[],"retention":{"status":"active"}
    });
    let version = json!({
        "id":input.version_id,"artifactId":input.artifact_id,"version":1,"status":"available","createdAt":at,
        "createdByInternalUserId":authority.internal_user_id,"content":{"kind":"inline","text":input.content,"media":media,"contentHash":content_hash},
        "media":media,"contentHash":content_hash,"provenance":provenance,"citations":citations,"lineage":[]
    });
    let payload =
        json!({"artifact":artifact_record,"version":version,"sourceMessageId":input.message_id});
    store
        .transaction(|tx| {
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
