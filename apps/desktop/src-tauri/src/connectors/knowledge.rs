//! Connector knowledge normalization, private persistence and account reconciliation.

use super::*;

pub(super) fn bind_search_result_to_connection(
    mut result: ConnectorSearchResult,
    connection_id: &str,
) -> ConnectorSearchResult {
    for item in &mut result.items {
        item.connection_id = Some(connection_id.to_string());
    }
    result
}

pub(super) fn bind_source_to_private_connection(
    mut result: ConnectorImportResult,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connection_id: &str,
) -> ConnectorImportResult {
    result.source.workspace_id = Some(scope.data.workspace_id().to_string());
    result.source.authority_scope = Some(crate::models::ContextRecordAuthorityScope {
        authority: "local".to_string(),
        visibility: "member-private".to_string(),
        owner_member_id: scope.private.owner_member_id().map(str::to_string),
        owner_internal_user_id: scope.private.owner_internal_user_id().map(str::to_string),
    });
    result.source.scope = Some(serde_json::json!({"level":"global"}));
    result.source.connection_id = Some(connection_id.to_string());
    result
}

pub(super) const MAX_CONNECTOR_KNOWLEDGE_SOURCES: usize = 200;
pub(super) const MAX_CONNECTOR_SOURCE_ID_CHARACTERS: usize = 240;
pub(super) const MAX_CONNECTOR_SOURCE_TITLE_CHARACTERS: usize = 300;
pub(super) const MAX_CONNECTOR_SOURCE_PREVIEW_CHARACTERS: usize = 40_000;
pub(super) const MAX_CONNECTOR_SOURCE_PROVENANCE_CHARACTERS: usize = 1_000;
pub(super) const MAX_CONNECTOR_SOURCE_METADATA_FIELDS: usize = 40;
pub(super) const MAX_CONNECTOR_SOURCE_METADATA_CHARACTERS: usize = 1_000;

pub(super) fn normalize_connector_knowledge_source(
    mut source: ConnectorKnowledgeSource,
    scope: &crate::store::repos::scope::PrivateDataScope,
) -> Result<ConnectorKnowledgeSource, String> {
    source.id = normalize_spaces(&source.id);
    source.connector_id = normalize_spaces(&source.connector_id);
    source.connection_id = source.connection_id.map(|value| normalize_spaces(&value));
    source.title = truncate_characters(
        &normalize_spaces(&source.title),
        MAX_CONNECTOR_SOURCE_TITLE_CHARACTERS,
    );
    source.provenance = truncate_characters(
        &normalize_spaces(&source.provenance),
        MAX_CONNECTOR_SOURCE_PROVENANCE_CHARACTERS,
    );
    source.freshness = truncate_characters(&normalize_spaces(&source.freshness), 240);
    source.content_preview = source
        .content_preview
        .map(|value| truncate_characters(value.trim(), MAX_CONNECTOR_SOURCE_PREVIEW_CHARACTERS));
    source.imported_at = normalize_spaces(&source.imported_at);
    source.provider_metadata = source
        .provider_metadata
        .into_iter()
        .take(MAX_CONNECTOR_SOURCE_METADATA_FIELDS)
        .map(|(key, value)| {
            (
                truncate_characters(&normalize_spaces(&key), 120),
                truncate_characters(
                    &normalize_spaces(&value),
                    MAX_CONNECTOR_SOURCE_METADATA_CHARACTERS,
                ),
            )
        })
        .filter(|(key, _)| !key.is_empty())
        .collect();
    let connection_id = source
        .connection_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Connector knowledge requires exact Connection provenance.".to_string())?
        .to_string();
    if source.id.is_empty()
        || source.id.chars().count() > MAX_CONNECTOR_SOURCE_ID_CHARACTERS
        || source.title.is_empty()
        || source.connector_id.is_empty()
        || source.kind.trim().is_empty()
        || source.trust != "untrusted"
        || source.origin != "connector-import"
        || source.imported_at.is_empty()
    {
        return Err("Connector knowledge metadata is invalid.".to_string());
    }
    let value = serde_json::to_value(source)
        .map_err(|_| "Mivlet could not encode connector knowledge.".to_string())?;
    let safe = crate::store::repos::connector_cache::redact_value(&value);
    let mut source: ConnectorKnowledgeSource = serde_json::from_value(safe)
        .map_err(|_| "Mivlet could not normalize connector knowledge.".to_string())?;
    source.workspace_id = Some(scope.workspace_id().to_string());
    source.authority_scope = Some(crate::models::ContextRecordAuthorityScope {
        authority: "local".to_string(),
        visibility: "member-private".to_string(),
        owner_member_id: scope.owner_member_id().map(str::to_string),
        owner_internal_user_id: scope.owner_internal_user_id().map(str::to_string),
    });
    source.scope = Some(match scope.project_id() {
        Some(project_id) => serde_json::json!({"level":"project","projectId":project_id}),
        None => serde_json::json!({"level":"global"}),
    });
    source.connection_id = Some(connection_id);
    Ok(source)
}

pub(super) fn read_connector_knowledge_sources(
    app: &tauri::AppHandle,
    scope: &crate::store::repos::scope::PrivateDataScope,
) -> Result<Vec<ConnectorKnowledgeSource>, String> {
    let path = connector_knowledge_path(app)?;
    let sources: Vec<ConnectorKnowledgeSource> =
        crate::store::read_private_workspace_document(&path, scope)?.unwrap_or_default();
    sources
        .into_iter()
        .map(|source| normalize_connector_knowledge_source(source, scope))
        .collect()
}

pub(super) fn persist_connector_knowledge_source(
    app: &tauri::AppHandle,
    scope: &crate::store::repos::scope::PrivateDataScope,
    source: ConnectorKnowledgeSource,
) -> Result<ConnectorKnowledgeSource, String> {
    let source = normalize_connector_knowledge_source(source, scope)?;
    let path = connector_knowledge_path(app)?;
    crate::store::update_private_workspace_document(
        &path,
        scope,
        move |current: Option<Vec<ConnectorKnowledgeSource>>| {
            let sources =
                merge_connector_knowledge_source(current.unwrap_or_default(), source.clone())?;
            Ok((Some(sources), source))
        },
    )
}

pub(super) fn merge_connector_knowledge_source(
    mut sources: Vec<ConnectorKnowledgeSource>,
    source: ConnectorKnowledgeSource,
) -> Result<Vec<ConnectorKnowledgeSource>, String> {
    if sources
        .iter()
        .any(|existing| existing.id == source.id && existing.deleted_at.is_some())
    {
        return Err(
            "Deleted connector knowledge cannot be restored by a later import.".to_string(),
        );
    }
    sources.retain(|existing| existing.id != source.id);
    sources.insert(0, source);
    sources.truncate(MAX_CONNECTOR_KNOWLEDGE_SOURCES);
    Ok(sources)
}

pub(super) fn update_connector_knowledge_source(
    app: &tauri::AppHandle,
    scope: &crate::store::repos::scope::PrivateDataScope,
    source_id: &str,
    disabled: Option<bool>,
    deleted_at: Option<String>,
) -> Result<ConnectorKnowledgeSource, String> {
    let source_id = normalize_spaces(source_id);
    if source_id.is_empty() || source_id.chars().count() > MAX_CONNECTOR_SOURCE_ID_CHARACTERS {
        return Err("Connector knowledge source id is invalid.".to_string());
    }
    let path = connector_knowledge_path(app)?;
    crate::store::update_private_workspace_document(
        &path,
        scope,
        move |current: Option<Vec<ConnectorKnowledgeSource>>| {
            let mut sources = current.unwrap_or_default();
            let source = sources
                .iter_mut()
                .find(|source| source.id == source_id)
                .ok_or_else(|| "That connector knowledge source is unavailable.".to_string())?;
            if source.deleted_at.is_some() {
                return Err("Deleted connector knowledge cannot be changed.".to_string());
            }
            if let Some(disabled) = disabled {
                source.disabled = disabled;
            }
            if let Some(deleted_at) = deleted_at {
                source.disabled = true;
                source.pinned = false;
                source.deleted_at = Some(deleted_at);
            }
            let updated = source.clone();
            Ok((Some(sources), updated))
        },
    )
}

pub(super) fn reconcile_canonical_connector_accounts(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    connections: &[ConnectorConnection],
) -> Result<Vec<crate::store::repos::connection_record::SafeConnectionRecord>, ConnectorCommandError>
{
    store
        .transaction(|tx| {
            for connection in connections
                .iter()
                .filter(|connection| connection.connector_id == connector_id)
            {
                let id = crate::connector_auth::derive_native_connection_id(
                    scope.data.workspace_id(),
                    connector_id,
                    &connection.account.id,
                );
                let existing = crate::store::repos::connection_record::get(tx, store, scope, &id)?;
                let expected_revision = existing.as_ref().map(|record| record.revision);
                let (lifecycle, authorization_state, credential_state) =
                    match connection.status.as_str() {
                        "connected" => ("authorized", "authorized", "available"),
                        "expired" => ("refresh-required", "expired", "refresh-required"),
                        _ => ("pending-authorization", "pending", "unknown"),
                    };
                let saved = crate::store::repos::connection_record::upsert_native_connector(
                    tx,
                    store,
                    scope,
                    crate::store::repos::connection_record::NativeConnectorConnectionWrite {
                        connector_definition_key: connector_id,
                        external_account_id: &connection.account.id,
                        display_name: &connection.account.display_name,
                        lifecycle,
                        authorization_state,
                        health_state: existing
                            .as_ref()
                            .map(|record| record.health_state.as_str())
                            .unwrap_or("unknown"),
                        credential_state,
                        expected_revision,
                        updated_at: &connection.updated_at,
                    },
                )?;
                crate::capability_registry::persist_native_discovery_evidence(
                    tx,
                    scope,
                    connection,
                    &saved,
                    &connection.updated_at,
                )?;
            }
            let selection =
                crate::store::repos::connection_selection::get(tx, scope, connector_id)?;
            let selection_is_present = selection.as_ref().is_some_and(|selection| {
                connections.iter().any(|connection| {
                    connection.connector_id == connector_id
                        && crate::connector_auth::derive_native_connection_id(
                            scope.data.workspace_id(),
                            connector_id,
                            &connection.account.id,
                        ) == selection.connection_id
                })
            });
            if !selection_is_present {
                let active = connections
                    .iter()
                    .find(|connection| {
                        connection.connector_id == connector_id
                            && connection.is_active
                            && connection.status == "connected"
                    })
                    .or_else(|| {
                        connections.iter().find(|connection| {
                            connection.connector_id == connector_id
                                && connection.status == "connected"
                        })
                    });
                if let Some(active) = active {
                    let id = crate::connector_auth::derive_native_connection_id(
                        scope.data.workspace_id(),
                        connector_id,
                        &active.account.id,
                    );
                    crate::store::repos::connection_selection::select(
                        tx,
                        store,
                        scope,
                        connector_id,
                        &id,
                        selection.as_ref().map(|value| value.revision),
                        &active.updated_at,
                    )?;
                } else if let Some(selection) = selection {
                    crate::store::repos::connection_selection::clear(
                        tx,
                        scope,
                        connector_id,
                        selection.revision,
                    )?;
                }
            }
            crate::store::repos::connection_record::list(tx, store, scope)
        })
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))
}
