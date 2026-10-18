//! Supported connector runtime boundary.
//!
//! Provider adapters plug into this shared command surface. OAuth/token work is
//! delegated to `connector_auth`; secrets never enter this module or JavaScript.

use std::collections::{BTreeMap, BTreeSet};
mod catalog;
mod drive_artifacts;
mod knowledge;
pub(crate) use catalog::*;
pub(super) use knowledge::*;

use crate::approvals::resolve_approval;
use crate::collaboration_connectors;
use crate::connector_api;
use crate::connector_approvals::{
    record_pending_connector_action, require_prepared_connector_account,
    update_connector_action_result, verify_prepared_connector_action,
};
use crate::connector_auth::{
    account_options_from_connections, connection_for, connection_for_scope, disconnect,
    read_connections, refresh_connection, safe_account_projection, usable_connection_for_scope,
    ConnectorConnection,
};
use crate::execution_approvals::verify_and_consume_execution_approval;
use crate::models::{
    ConnectorActionExecutionRequest, ConnectorActionRequest, ConnectorActionResult,
    ConnectorAuthRequest, ConnectorAuthResult, ConnectorCapabilityRequest,
    ConnectorCapabilityResult, ConnectorCommandError, ConnectorHealth, ConnectorImportRequest,
    ConnectorImportResult, ConnectorKnowledgeSource, ConnectorManifest, ConnectorPermission,
    ConnectorSearchRequest, ConnectorSearchResult, CONNECTOR_ACTIONS, CONNECTOR_AUTH_STATES,
    MAX_CONNECTOR_PAYLOAD_FIELDS, MAX_CONNECTOR_QUERY_CHARACTERS, MAX_CONNECTOR_RESULT_LIMIT,
    SUPPORTED_CONNECTOR_IDS,
};
use crate::oauth_loopback;
use crate::paths::{
    connector_approval_records_path, connector_connections_path, connector_knowledge_path,
    execution_approvals_path, normalize_spaces, truncate_characters,
};

/// Connector writes offer a fresh one-time permit. Session/rule shortcuts cannot
/// authorize a later mutation.
const CONNECTOR_ACTION_DECISIONS: [&str; 3] = ["once", "modify", "deny"];

pub(crate) trait ConnectorCredentialBoundary {
    fn connection(&self, connector_id: &str) -> Option<ConnectorConnection>;
    fn workspace_id(&self) -> Option<&str>;
    fn health(
        &self,
        _connector_id: &str,
        _connection: &ConnectorConnection,
    ) -> Option<ConnectorHealth> {
        None
    }
}

struct UnavailableCredentialBoundary;

impl ConnectorCredentialBoundary for UnavailableCredentialBoundary {
    fn connection(&self, _connector_id: &str) -> Option<ConnectorConnection> {
        None
    }

    fn workspace_id(&self) -> Option<&str> {
        None
    }
}

struct NativeCredentialBoundary<'scope> {
    connections_path: std::path::PathBuf,
    scope: &'scope crate::authorized_scope::AuthorizedCommandScope,
}

impl ConnectorCredentialBoundary for NativeCredentialBoundary<'_> {
    fn connection(&self, connector_id: &str) -> Option<ConnectorConnection> {
        usable_connection_for_scope(&self.connections_path, connector_id, self.scope)
    }

    fn workspace_id(&self) -> Option<&str> {
        Some(self.scope.data.workspace_id())
    }

    fn health(
        &self,
        connector_id: &str,
        connection: &ConnectorConnection,
    ) -> Option<ConnectorHealth> {
        let store = crate::store::try_global()?;
        let id = crate::connector_auth::derive_native_connection_id(
            self.scope.data.workspace_id(),
            connector_id,
            &connection.account.id,
        );
        let record = store
            .with_conn(|tx| crate::store::repos::connection_record::get(tx, store, self.scope, &id))
            .ok()??;
        let (state, summary) = match record.health_state.as_str() {
            "healthy" => ("healthy", "Account connected."),
            "degraded" => (
                "degraded",
                "Access needs attention. Reconnect to restore access.",
            ),
            "unhealthy" => (
                "error",
                "The connection could not be reached. Try connecting again.",
            ),
            _ => return None,
        };
        Some(ConnectorHealth {
            state: state.into(),
            summary: summary.into(),
            checked_at: record.updated_at,
            retry_after: None,
        })
    }
}

pub(crate) fn validate_connector_execution_request(
    request: ConnectorActionExecutionRequest,
) -> Result<
    (
        ConnectorActionRequest,
        crate::models::ApprovalResolutionResponse,
    ),
    ConnectorCommandError,
> {
    let action = validate_connector_action(request.action)?;
    if matches!(request.approval.decision.as_str(), "session" | "rule") {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "External connector writes require a fresh per-action approval.",
            false,
        ));
    }
    if request.approval.request != action.approval {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "The approval does not match this connector action.",
            false,
        ));
    }
    let route_mode = action
        .permission_mode
        .as_deref()
        .unwrap_or(action.approval.mode.as_str());
    crate::permission_policy::ensure_permission_allowed(
        route_mode,
        action.permission_profile.as_deref(),
        crate::permission_policy::effect_for_connector_action(&action.action),
        &action.approval.risk_level,
    )
    .map_err(|message| command_error("approval-required", &action.connector_id, &message, false))?;
    let resolution = resolve_approval(request.approval).map_err(|_| {
        command_error(
            "approval-required",
            &action.connector_id,
            "The connector action approval is invalid or incomplete.",
            false,
        )
    })?;
    Ok((action, resolution))
}

pub(crate) fn validate_connector_action(
    request: ConnectorActionRequest,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let policy = action_policy(&request.action);
    if !CONNECTOR_ACTIONS.contains(&request.action.as_str())
        || !entry.actions.contains(&request.action.as_str())
        || policy.is_none()
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "This action is not supported by the selected connector.",
            false,
        ));
    }
    let policy = policy.expect("supported connector action has a policy");
    let expected_fields = request
        .payload
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let approval_fields = request
        .approval
        .data_used
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let approval_decisions = request
        .approval
        .decisions
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if request.id.trim().is_empty()
        || request.approval.id != request.id
        || request.approval.service != entry.name
        || request.approval.action != policy.label
        || request.approval.mode != policy.mode
        || request.approval.risk_level != policy.risk_level
        || request.approval.consequence != policy.consequence
        || request.approval.confirmation_phrase.as_deref() != policy.confirmation_phrase
        || request.approval.requested_at.trim().is_empty()
        || approval_decisions != CONNECTOR_ACTION_DECISIONS
        || request.approval.data_used.len() != expected_fields.len()
        || approval_fields != expected_fields
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector action approval metadata does not match the request.",
            false,
        ));
    }
    if request.payload.len() > MAX_CONNECTOR_PAYLOAD_FIELDS {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector action payload has too many fields.",
            false,
        ));
    }
    let route_mode = request
        .permission_mode
        .as_deref()
        .unwrap_or(request.approval.mode.as_str());
    crate::permission_policy::ensure_permission_allowed(
        route_mode,
        request.permission_profile.as_deref(),
        crate::permission_policy::effect_for_connector_action(&request.action),
        request.approval.risk_level.as_str(),
    )
    .map_err(|message| command_error("approval-required", entry.id, &message, false))?;
    Ok(request)
}

pub(crate) fn redact_connector_text(value: &str) -> String {
    let normalized = normalize_spaces(value);
    const CONNECTOR_SECRET_EXTRAS: &[&str] = &["email body", "message body", "raw payload"];
    if crate::secret_redaction::looks_secret_with(&normalized, CONNECTOR_SECRET_EXTRAS) {
        return "[redacted connector data]".to_string();
    }

    truncate_characters(&normalized, 240)
}

/// Record a connector action into the unified action-history store (observation
/// only). The connector-approval-records store remains the rich per-action
/// audit; this mirrors the terminal states into the inspectable history surface.
/// Best-effort: never blocks execution.
fn audit_connector_action(
    action: &ConnectorActionRequest,
    status: &str,
    error_code: &str,
    message: &str,
) {
    let approval = &action.approval;
    crate::action_history::Recorder::new(
        crate::action_history::categories::CONNECTOR_ACTION,
        &action.connector_id,
        &action.action,
        status,
    )
    .actor("system")
    .mode(&approval.mode)
    .risk(&approval.risk_level)
    .correlation(&approval.id)
    .error(error_code)
    .summary(message)
    // Payload keys are non-secret identifiers (target/preview); values are
    // redacted by the recorder before sealing. Never include tokens/keys.
    .detail(serde_json::json!({
        "connectorId": action.connector_id,
        "proposedAction": action.action,
        "target": action.payload.get("target").cloned().unwrap_or_default(),
        "preview": action.payload.get("preview").cloned().unwrap_or_default(),
    }))
    .record();
}

fn require_connector_workspace(workspace_id: Option<String>) -> Result<(), ConnectorCommandError> {
    crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map(|_| ())
    .map_err(|message| command_error("invalid-request", "workspace", &message, false))
}

fn connector_authorization_context(
    workspace_id: Option<String>,
    connector_id: &str,
) -> Result<crate::authorized_scope::AuthorizedCommandScope, ConnectorCommandError> {
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| command_error("invalid-request", connector_id, &message, false))?;
    Ok(scope)
}

#[tauri::command]
pub fn list_connector_statuses(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
) -> Result<Vec<ConnectorManifest>, ConnectorCommandError> {
    let scope = match crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Read,
    ) {
        Ok(scope) => scope,
        Err(_) => return Ok(list_unconfigured_workspace_connector_statuses()),
    };
    let boundary =
        connector_connections_path(&app).map(|connections_path| NativeCredentialBoundary {
            connections_path,
            scope: &scope,
        });
    Ok(match boundary {
        Ok(boundary) => list_connector_statuses_with(&boundary),
        Err(_) => list_connector_statuses_with(&UnavailableCredentialBoundary),
    })
}

/// Begin a loopback OAuth flow end-to-end: bind an exact desktop redirect,
/// start the transaction, open the browser, accept one callback, and complete
/// token exchange inside the credential boundary. Confidential providers route
/// exchange through the configured auth broker and fail closed when it is
/// unavailable; public Google clients call Google directly.
#[tauri::command]
pub async fn begin_connector_oauth(
    app: tauri::AppHandle,
    request: ConnectorAuthRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let scopes = selected_auth_scopes(entry, request.requested_scopes.as_deref())?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    oauth_loopback::run_loopback_oauth(&app, entry.id, entry.auth_mode, scopes, request, scope)
        .await
}

#[tauri::command]
pub async fn clear_connector_auth(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    disconnect(&app, entry.id, &scope).await?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    Ok(build_manifest(
        entry,
        &NativeCredentialBoundary {
            connections_path: path,
            scope: &scope,
        },
    ))
}

/// List every connected account for a connector (active first), so the UI can
/// render an account switcher. Token secrets never leave the credential
/// boundary; only non-secret account summaries are returned. Multi-account
/// support lets a user keep several Google accounts connected and switch the
/// one reads/actions resolve against.
#[tauri::command]
pub fn list_connector_accounts(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<Vec<crate::models::ConnectorAccountOption>, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| command_error("invalid-request", entry.id, &message, false))?;
    let workspace_id = scope.data.workspace_id().to_string();
    let connections = read_connections(&path)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    let store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            entry.id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    let canonical = reconcile_canonical_connector_accounts(store, &scope, entry.id, &connections)?;
    let selection = store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, entry.id))
        .map_err(|error| command_error("unknown", entry.id, &error.to_string(), false))?;
    project_canonical_account_options(
        account_options_from_connections(&connections, entry.id, &workspace_id),
        &canonical,
        entry.id,
        selection.as_ref().map(|value| value.connection_id.as_str()),
    )
}

fn project_canonical_account_options(
    options: Vec<crate::models::ConnectorAccountOption>,
    canonical: &[crate::store::repos::connection_record::SafeConnectionRecord],
    connector_id: &str,
    selected_connection_id: Option<&str>,
) -> Result<Vec<crate::models::ConnectorAccountOption>, ConnectorCommandError> {
    let records: BTreeMap<&str, &crate::store::repos::connection_record::SafeConnectionRecord> =
        canonical
            .iter()
            .filter(|record| record.connector_definition_key == connector_id)
            .map(|record| (record.id.as_str(), record))
            .collect();
    options
        .into_iter()
        .map(|mut option| {
            let record = records.get(option.connection_id.as_str()).ok_or_else(|| {
                command_error(
                    "unknown",
                    connector_id,
                    "Connection metadata is unavailable; refresh and try again.",
                    false,
                )
            })?;
            option.lifecycle = record.lifecycle.clone();
            option.authorization_state = record.authorization_state.clone();
            option.health_state = record.health_state.clone();
            option.credential_custody = record.credential_custody.clone();
            option.credential_state = record.credential_state.clone();
            option.active = selected_connection_id == Some(option.connection_id.as_str());
            Ok(option)
        })
        .collect()
}

fn require_selectable_canonical_connection(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    connection_id: &str,
) -> Result<crate::store::repos::connection_record::SafeConnectionRecord, ConnectorCommandError> {
    let record = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::get(tx, store, scope, connection_id)
        })
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?
        .ok_or_else(|| {
            command_error(
                "not-found",
                connector_id,
                "The selected Connection is unavailable.",
                false,
            )
        })?;
    if record.connector_definition_key != connector_id
        || record.lifecycle != "authorized"
        || record.authorization_state != "authorized"
        || record.credential_state != "available"
    {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "The selected Connection must be reauthorized before it can be used.",
            false,
        ));
    }
    Ok(record)
}

pub(crate) fn selected_connection_evidence(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
) -> Result<crate::store::repos::connection_selection::ConnectionSelection, ConnectorCommandError> {
    let selection = store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, scope, connector_id))
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Choose an authorized Connection before searching or importing.",
                false,
            )
        })?;
    require_selectable_canonical_connection(store, scope, connector_id, &selection.connection_id)?;
    Ok(selection)
}

pub(crate) fn require_unchanged_connection_evidence(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    expected: &crate::store::repos::connection_selection::ConnectionSelection,
) -> Result<(), ConnectorCommandError> {
    let current = selected_connection_evidence(store, scope, connector_id)?;
    if current.connection_id != expected.connection_id || current.revision != expected.revision {
        return Err(command_error(
            "conflict",
            connector_id,
            "The active Connection changed during this request. Search again before importing.",
            true,
        ));
    }
    Ok(())
}

fn require_workspace_connection_target(
    connector_id: &str,
    project_id: Option<String>,
    requested_connection_id: Option<String>,
    selected_connection_id: &str,
) -> Result<(), ConnectorCommandError> {
    if project_id.is_some() {
        return Err(command_error(
            "invalid-request",
            connector_id,
            "Project-scoped connector access is no longer supported.",
            false,
        ));
    }
    if let Some(connection_id) = requested_connection_id {
        if connection_id.trim() != selected_connection_id {
            return Err(command_error(
                "conflict",
                connector_id,
                "This request belongs to a different active Connection.",
                true,
            ));
        }
    }
    Ok(())
}

/// Make the workspace-bound Mivlet Connection active for a connector. Other
/// accounts are deactivated but their credentials remain available, so the
/// user can switch back. Provider account ids are never selection authority.
#[tauri::command]
pub fn switch_connector_account(
    app: tauri::AppHandle,
    connector_id: String,
    connection_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    let workspace_id = scope.data.workspace_id().to_string();
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            entry.id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    require_selectable_canonical_connection(durable_store, &scope, entry.id, &connection_id)?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    let previous_connections = read_connections(&path)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    let previous_selection = durable_store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, entry.id))
        .map_err(|error| command_error("unknown", entry.id, &error.to_string(), false))?;
    crate::connector_auth::switch_active_connection(
        &path,
        entry.id,
        &workspace_id,
        &connection_id,
    )?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    if let Err(error) = durable_store.transaction(|tx| {
        crate::store::repos::connection_selection::select(
            tx,
            durable_store,
            &scope,
            entry.id,
            &connection_id,
            previous_selection.as_ref().map(|value| value.revision),
            &updated_at,
        )?;
        Ok(())
    }) {
        let restored =
            crate::connector_auth::write_connections(&path, &previous_connections).is_ok();
        return Err(if restored {
            command_error("unknown", entry.id, &error.to_string(), false)
        } else {
            command_error(
                "unknown",
                entry.id,
                "Mivlet could not save or fully restore the active Connection.",
                false,
            )
        });
    }
    Ok(build_manifest(
        entry,
        &NativeCredentialBoundary {
            connections_path: path,
            scope: &scope,
        },
    ))
}

#[tauri::command]
pub async fn refresh_connector_health(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    // Refresh first: this rotates expiring tokens and fails closed when the
    // connection is missing or the refresh is rejected. A failed refresh is a
    // real provider error, not a fixture fallback.
    let expected_connection = refresh_connection(&app, entry.id).await?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    // Probe live provider health through the authenticated token boundary. A
    // probe failure is surfaced as a degraded/error health state, never as a
    // fixture or a fake "connected" claim.
    let health = probe_connector_health(&app, entry.id).await;
    if let Some(health) = health.as_ref() {
        let current_connection = connection_for(&connections_path, entry.id).ok_or_else(|| {
            command_error(
                "conflict",
                entry.id,
                "Connector selection changed before health could be saved.",
                true,
            )
        })?;
        if current_connection.account.id != expected_connection.account.id
            || current_connection.credential_ref != expected_connection.credential_ref
        {
            return Err(command_error(
                "conflict",
                entry.id,
                "Connector selection changed before health could be saved.",
                true,
            ));
        }
        let durable_store = crate::store::try_global().ok_or_else(|| {
            command_error(
                "unknown",
                entry.id,
                "Mivlet's encrypted store is not initialized.",
                false,
            )
        })?;
        persist_connector_health_state(
            durable_store,
            &scope,
            entry.id,
            &expected_connection.account.id,
            health,
        )
        .map_err(|error| command_error("unknown", entry.id, &error.to_string(), false))?;
    }
    Ok(build_manifest_with_health(
        entry,
        &NativeCredentialBoundary {
            connections_path,
            scope: &scope,
        },
        health,
    ))
}

#[tauri::command]
pub async fn search_connector(
    app: tauri::AppHandle,
    request: ConnectorSearchRequest,
    workspace_id: Option<String>,
    project_id: Option<String>,
    connection_id: Option<String>,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            entry.id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    let connection = selected_connection_evidence(durable_store, &scope, entry.id)?;
    require_workspace_connection_target(
        entry.id,
        project_id,
        connection_id,
        &connection.connection_id,
    )?;
    if request.query.chars().count() > MAX_CONNECTOR_QUERY_CHARACTERS
        || !(1..=MAX_CONNECTOR_RESULT_LIMIT).contains(&request.limit.unwrap_or(20))
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector search request exceeds the supported limits.",
            false,
        ));
    }
    let result = if matches!(entry.id, "google-drive" | "gmail" | "google-calendar") {
        crate::google::search(&app, request).await
    } else if matches!(entry.id, "github" | "vercel" | "linear") {
        connector_api::search(&app, request).await
    } else if matches!(entry.id, "notion" | "slack") {
        collaboration_connectors::search(&app, request).await
    } else {
        Err(configuration_required(entry.id))
    }?;
    require_unchanged_connection_evidence(durable_store, &scope, entry.id, &connection)?;
    Ok(bind_search_result_to_connection(
        result,
        &connection.connection_id,
    ))
}

#[tauri::command]
pub async fn read_connector_capability(
    app: tauri::AppHandle,
    request: ConnectorCapabilityRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorCapabilityResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    if !matches!(entry.id, "github" | "vercel" | "linear") {
        return Err(configuration_required(entry.id));
    }
    connector_api::read_capability(&app, request).await
}

#[tauri::command]
pub fn list_connector_knowledge_sources(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<ConnectorKnowledgeSource>, ConnectorCommandError> {
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        project_id,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map_err(|message| command_error("invalid-request", "knowledge", &message, false))?;
    let sources = read_connector_knowledge_sources(&app, &scope.private)
        .map_err(|message| command_error("unknown", "knowledge", &message, false))?;
    Ok(sources
        .into_iter()
        .filter(|source| source.deleted_at.is_none())
        .collect())
}

#[tauri::command]
pub fn set_connector_knowledge_source_disabled(
    app: tauri::AppHandle,
    source_id: String,
    disabled: bool,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<ConnectorKnowledgeSource, ConnectorCommandError> {
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        project_id,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| command_error("invalid-request", "knowledge", &message, false))?;
    update_connector_knowledge_source(&app, &scope.private, &source_id, Some(disabled), None)
        .map_err(|message| command_error("unknown", "knowledge", &message, false))
}

#[tauri::command]
pub fn delete_connector_knowledge_source(
    app: tauri::AppHandle,
    source_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<ConnectorKnowledgeSource, ConnectorCommandError> {
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        project_id,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| command_error("invalid-request", "knowledge", &message, false))?;
    update_connector_knowledge_source(
        &app,
        &scope.private,
        &source_id,
        None,
        Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    )
    .map_err(|message| command_error("unknown", "knowledge", &message, false))
}

#[tauri::command]
pub async fn import_connector_item(
    app: tauri::AppHandle,
    request: ConnectorImportRequest,
    workspace_id: Option<String>,
    project_id: Option<String>,
    connection_id: Option<String>,
) -> Result<ConnectorImportResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let scope = connector_authorization_context(workspace_id, entry.id)?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            entry.id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    let connection = selected_connection_evidence(durable_store, &scope, entry.id)?;
    require_workspace_connection_target(
        entry.id,
        project_id,
        connection_id,
        &connection.connection_id,
    )?;
    if request.item.connector_id != entry.id || request.imported_at.trim().is_empty() {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector import metadata does not match the selected provider.",
            false,
        ));
    }
    if request.item.connection_id.as_deref() != Some(connection.connection_id.as_str()) {
        return Err(command_error(
            "conflict",
            entry.id,
            "This result belongs to a different or expired Connection. Search again before importing.",
            true,
        ));
    }
    let result = if matches!(entry.id, "google-drive" | "gmail" | "google-calendar") {
        crate::google::import(&app, request).await
    } else if !matches!(
        entry.id,
        "github" | "vercel" | "linear" | "notion" | "slack"
    ) {
        Err(configuration_required(entry.id))
    } else {
        let kind = match request.item.kind.as_str() {
            "repository" | "branch" | "project" | "database" | "conversation" | "calendar" => {
                "folder"
            }
            "deployment" => "web",
            _ => "document",
        };
        Ok(ConnectorImportResult {
            source: ConnectorKnowledgeSource {
                workspace_id: None,
                authority_scope: None,
                scope: None,
                id: format!("connector-{}-{}", entry.id, request.item.id),
                title: request.item.title,
                kind: kind.to_string(),
                connector_id: entry.id.to_string(),
                connection_id: None,
                provenance: request.item.provenance,
                freshness: request.item.freshness,
                pinned: false,
                trust: "untrusted".to_string(),
                content_preview: request.item.content_preview.or(Some(request.item.summary)),
                imported_at: request.imported_at,
                origin: "connector-import".to_string(),
                provider_metadata: request.item.provider_metadata,
                disabled: false,
                deleted_at: None,
                status: Some("ok".to_string()),
                status_message: None,
            },
            imported: true,
        })
    }?;
    require_unchanged_connection_evidence(durable_store, &scope, entry.id, &connection)?;
    let bound = bind_source_to_private_connection(result, &scope, &connection.connection_id);
    let source = persist_connector_knowledge_source(&app, &scope.private, bound.source)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    Ok(ConnectorImportResult {
        source,
        imported: true,
    })
}

#[tauri::command]
pub fn prepare_connector_tool_action(
    app: tauri::AppHandle,
    connector_id: String,
    action: String,
    payload: BTreeMap<String, String>,
    workspace_id: String,
    artifact_source: Option<drive_artifacts::ArtifactSource>,
    local_computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
) -> Result<serde_json::Value, ConnectorCommandError> {
    require_connector_workspace(Some(workspace_id.clone()))?;
    let payload = if action == drive_artifacts::ACTION && connector_id == "google-drive" {
        drive_artifacts::prepare(&local_computers, &workspace_id, artifact_source, payload)?
    } else {
        payload
    };
    let request = connector_tool_action_request(connector_id, action, payload)?;
    let action = prepare_connector_action(app.clone(), request, Some(workspace_id.clone()))?;
    let record = verify_prepared_connector_action(
        &connector_approval_records_path(&app)
            .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?,
        &action,
    )
    .map_err(|message| command_error("approval-required", &action.connector_id, &message, false))?;
    let connection_id =
        prepared_connection_id(&workspace_id, &action.connector_id, &record.account_id);
    Ok(serde_json::json!({
        "action": action,
        "preview": record.preview,
        "connectionId": connection_id,
    }))
}

fn connector_tool_action_request(
    connector_id: String,
    action: String,
    payload: BTreeMap<String, String>,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let policy = action_policy(&action).ok_or_else(|| {
        command_error(
            "invalid-request",
            &connector_id,
            "Unsupported connector action.",
            false,
        )
    })?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| {
        command_error(
            "unknown",
            &connector_id,
            "Could not prepare this connector action.",
            true,
        )
    })?;
    let id = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let request = ConnectorActionRequest {
        id: id.clone(),
        connector_id,
        action,
        permission_mode: None,
        permission_profile: None,
        approval: crate::models::ApprovalRequest {
            id,
            service: entry.name.into(),
            action: policy.label.into(),
            mode: policy.mode.into(),
            risk_level: policy.risk_level.into(),
            consequence: policy.consequence.into(),
            requested_at: chrono::Utc::now().to_rfc3339(),
            decisions: CONNECTOR_ACTION_DECISIONS
                .iter()
                .map(|value| (*value).into())
                .collect(),
            confirmation_phrase: policy.confirmation_phrase.map(String::from),
            data_used: payload.keys().cloned().collect(),
        },
        payload,
    };
    validate_connector_action(request)
}

fn prepare_connector_action(
    app: tauri::AppHandle,
    request: ConnectorActionRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let action = validate_connector_action(request)?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    let connection = connection_for(&connections_path, &action.connector_id);
    let account_id = connection
        .as_ref()
        .map(|connection| connection.account.id.clone())
        .unwrap_or_else(|| "unconnected".to_string());
    let account_label = connection
        .as_ref()
        .and_then(|connection| connection.account.email.clone())
        .or_else(|| {
            connection
                .as_ref()
                .map(|connection| connection.account.display_name.clone())
        })
        .unwrap_or_else(|| "unconnected account".to_string());
    record_pending_connector_action(
        &connector_approval_records_path(&app)
            .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?,
        &action,
        &account_id,
        &account_label,
    )
    .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    Ok(action)
}

fn prepared_connection_id(
    workspace_id: &str,
    connector_id: &str,
    account_id: &str,
) -> Option<String> {
    let account_id = account_id.trim();
    if account_id.is_empty() || account_id == "unconnected" {
        return None;
    }
    Some(crate::connector_auth::derive_native_connection_id(
        workspace_id,
        connector_id,
        account_id,
    ))
}

fn bound_prepared_connection_id(
    workspace_id: &str,
    connector_id: &str,
    record: &crate::models::ConnectorApprovalRecord,
    current_account_id: Option<&str>,
) -> Result<String, ConnectorCommandError> {
    require_prepared_connector_account(record, current_account_id)
        .map_err(|message| command_error("conflict", connector_id, &message, true))?;
    prepared_connection_id(workspace_id, connector_id, &record.account_id).ok_or_else(|| {
        command_error(
            "conflict",
            connector_id,
            "Connector action was prepared without a connected account.",
            true,
        )
    })
}

#[tauri::command]
pub async fn execute_approved_connector_action(
    app: tauri::AppHandle,
    request: ConnectorActionExecutionRequest,
    workspace_id: Option<String>,
    local_computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id.clone())?;
    let (action, resolution) = validate_connector_execution_request(request)?;
    let records_path = connector_approval_records_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    let record = verify_prepared_connector_action(&records_path, &action).map_err(|message| {
        command_error("approval-required", &action.connector_id, &message, false)
    })?;

    if resolution.audit_entry.decision == "deny" {
        let _ = update_connector_action_result(
            &records_path,
            &action.approval.id,
            "denied",
            &resolution.audit_entry.decided_at,
            None,
        );
        audit_connector_action(
            &action,
            "blocked",
            "denied",
            "Connector action denied by user.",
        );
        return Ok(ConnectorActionResult {
            request_id: action.id,
            connector_id: action.connector_id,
            action: action.action,
            status: "denied".to_string(),
            message: "The connector action was denied.".to_string(),
            provider_resource_id: None,
        });
    }

    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map_err(|message| command_error("invalid-request", &action.connector_id, &message, false))?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    let current_account_id = connection_for_scope(&connections_path, &action.connector_id, &scope)
        .map(|connection| connection.account.id);
    let expected_connection_id = bound_prepared_connection_id(
        scope.data.workspace_id(),
        &action.connector_id,
        &record,
        current_account_id.as_deref(),
    )?;
    let artifact_upload = if action.action == drive_artifacts::ACTION {
        Some(drive_artifacts::Upload::admit(
            &local_computers,
            scope.data.workspace_id(),
            &action,
        )?)
    } else {
        None
    };

    if matches!(
        action.connector_id.as_str(),
        "google-drive" | "gmail" | "google-calendar"
    ) && !matches!(resolution.audit_entry.decision.as_str(), "once" | "modify")
    {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "Google mutations require a fresh explicit approval for this exact action.",
            false,
        ));
    }

    verify_and_consume_execution_approval(
        &execution_approvals_path(&app).map_err(|message| {
            command_error("approval-required", &action.connector_id, &message, false)
        })?,
        &resolution.effective_request,
        &crate::execution_approvals::wall_clock_consumed_at(),
    )
    .map_err(|message| command_error("approval-required", &action.connector_id, &message, false))?;
    update_connector_action_result(
        &records_path,
        &action.approval.id,
        "approved",
        &resolution.audit_entry.decided_at,
        None,
    )
    .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;

    if matches!(
        action.connector_id.as_str(),
        "google-drive" | "gmail" | "google-calendar"
    ) {
        let result = if let Some(upload) = artifact_upload {
            upload.execute(&app, &action, &expected_connection_id).await
        } else {
            crate::google::execute_action(&app, &action, &expected_connection_id).await
        };
        match result {
            Ok(result) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(&action, "ok", "", "Google connector action completed.");
                return Ok(result);
            }
            Err(provider_error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&provider_error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &provider_error.code,
                    "Google connector action failed.",
                );
                return Err(provider_error);
            }
        }
    }

    if matches!(action.connector_id.as_str(), "notion" | "slack") {
        match collaboration_connectors::execute(&app, &action, &expected_connection_id).await {
            Ok(result) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(
                    &action,
                    "ok",
                    "",
                    "Collaboration connector action completed.",
                );
                return Ok(result);
            }
            Err(error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &error.code,
                    "Collaboration connector action failed.",
                );
                return Err(error);
            }
        }
    }

    if matches!(action.connector_id.as_str(), "github" | "vercel" | "linear") {
        match connector_api::execute_action(&app, &action, &expected_connection_id).await {
            Ok(provider_resource_id) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(&action, "ok", "", "Provider connector action completed.");
                return Ok(ConnectorActionResult {
                    request_id: action.id,
                    connector_id: action.connector_id,
                    action: action.action,
                    status: "completed".to_string(),
                    message: "The approved connector action completed.".to_string(),
                    provider_resource_id,
                });
            }
            Err(error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &error.code,
                    "Provider connector action failed.",
                );
                return Err(error);
            }
        }
    }

    let _ = update_connector_action_result(
        &records_path,
        &action.approval.id,
        "failed",
        &resolution.audit_entry.decided_at,
        Some("configuration-required"),
    );
    audit_connector_action(
        &action,
        "failed",
        "configuration-required",
        "Connector is not configured for this action.",
    );
    Err(configuration_required(&action.connector_id))
}

#[allow(dead_code)]
fn _empty_provider_metadata() -> BTreeMap<String, String> {
    BTreeMap::new()
}

#[cfg(test)]
mod workspace_scope_tests {
    use super::*;

    #[test]
    fn model_writes_use_native_policy_and_unique_exact_approvals() {
        for entry in CATALOG {
            for action in entry.actions {
                let payload = BTreeMap::from([("targetId".into(), "selected-resource".into())]);
                let first = connector_tool_action_request(
                    entry.id.into(),
                    (*action).into(),
                    payload.clone(),
                )
                .unwrap();
                let second =
                    connector_tool_action_request(entry.id.into(), (*action).into(), payload)
                        .unwrap();
                assert_ne!(first.id, second.id);
                let mut changed = first.clone();
                changed.approval.risk_level = "low".into();
                assert!(validate_connector_action(changed).is_err());
                assert!(
                    validate_connector_execution_request(ConnectorActionExecutionRequest {
                        action: first.clone(),
                        approval: crate::models::ApprovalResolutionRequest {
                            request: first.approval.clone(),
                            decision: "session".into(),
                            decided_at: first.approval.requested_at.clone(),
                            confirmation_text: None,
                            modification: None,
                        }
                    })
                    .is_err()
                );
            }
        }
        assert!(connector_tool_action_request(
            "gmail".into(),
            "google-drive.delete-file".into(),
            BTreeMap::new()
        )
        .is_err());
    }

    #[test]
    fn approved_connector_execution_binds_prepared_account_not_current_selection() {
        let path = std::env::temp_dir().join(format!(
            "mivlet-connector-prepared-account-bind-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let prepared = connector_tool_action_request(
            "gmail".into(),
            "gmail.send".into(),
            BTreeMap::from([
                ("to".into(), "person@example.com".into()),
                ("subject".into(), "Status update".into()),
            ]),
        )
        .unwrap();
        let record =
            record_pending_connector_action(&path, &prepared, "account-a", "Account A").unwrap();
        let workspace = "workspace-a";
        let bound =
            bound_prepared_connection_id(workspace, "gmail", &record, Some("account-a")).unwrap();
        assert_eq!(
            bound,
            crate::connector_auth::derive_native_connection_id(workspace, "gmail", "account-a")
        );
        assert_eq!(
            prepared_connection_id(workspace, "gmail", "account-a").as_deref(),
            Some(bound.as_str())
        );
        let switched = bound_prepared_connection_id(workspace, "gmail", &record, Some("account-b"))
            .unwrap_err();
        assert_eq!(switched.code, "conflict");
        assert!(switched.retryable);
        assert_eq!(
            switched.message,
            "Connector account changed after its approval preview."
        );
        assert!(!switched.message.contains("account-a"));
        assert!(!switched.message.contains("account-b"));
        assert_ne!(
            bound,
            crate::connector_auth::derive_native_connection_id(workspace, "gmail", "account-b")
        );
        let disconnected =
            bound_prepared_connection_id(workspace, "gmail", &record, None).unwrap_err();
        assert_eq!(disconnected.code, "conflict");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn oauth_catalog_keeps_write_scopes_only_for_product_writes() {
        let github = CATALOG.iter().find(|entry| entry.id == "github").unwrap();
        assert!(github
            .scopes
            .iter()
            .all(|(id, _, access, _)| *id != "repo" && *access == "read"));
        assert!(github
            .scopes
            .iter()
            .any(|(id, _, _, required)| *id == "read:user" && *required));
        assert!(github
            .scopes
            .iter()
            .any(|(id, _, _, required)| *id == "read:org" && *required));
        assert!(!github.setup_message.contains("GitHub App with read-only"));
        assert!(github.setup_message.contains("classic GitHub OAuth App"));
        assert!(github.actions.is_empty());
        let drive = CATALOG
            .iter()
            .find(|entry| entry.id == "google-drive")
            .unwrap();
        assert!(drive.scopes.iter().any(|(id, _, access, required)| {
            *id == "https://www.googleapis.com/auth/drive.file" && *access == "write" && *required
        }));
        assert!(drive.actions.contains(&drive_artifacts::ACTION));
        assert_eq!(
            action_required_scopes(drive_artifacts::ACTION),
            DRIVE_FILE_ACTION_SCOPES
        );
        let upload_policy = action_policy(drive_artifacts::ACTION).unwrap();
        assert_eq!(
            (upload_policy.mode, upload_policy.risk_level),
            ("full-access", "high")
        );
        let vercel = CATALOG.iter().find(|entry| entry.id == "vercel").unwrap();
        assert!(vercel.scopes.iter().any(|(id, _, access, required)| {
            *id == "deployment:write" && *access == "write" && *required
        }));
        let linear = CATALOG.iter().find(|entry| entry.id == "linear").unwrap();
        assert!(linear
            .scopes
            .iter()
            .all(|(id, _, _, _)| *id != "issues:create" && *id != "comments:create"));
        assert!(linear
            .scopes
            .iter()
            .any(|(id, _, access, required)| *id == "write" && *access == "write" && *required));
        let slack = CATALOG.iter().find(|entry| entry.id == "slack").unwrap();
        assert!(slack.scopes.iter().any(|(id, _, access, required)| {
            *id == "chat:write" && *access == "write" && *required
        }));
        assert!(slack.scopes.iter().any(|(id, _, access, required)| {
            *id == "reactions:write" && *access == "write" && *required
        }));
        assert_eq!(
            action_required_scopes("vercel.promote"),
            &["deployment:write"]
        );
        assert_eq!(action_required_scopes("linear.update-issue"), &["write"]);
        assert_eq!(action_required_scopes("slack.post"), &["chat:write"]);
        assert_eq!(
            action_required_scopes("slack.react-add"),
            &["reactions:write"]
        );
        assert!(!slack.actions.contains(&"slack.create-draft"));
        let notion = CATALOG.iter().find(|entry| entry.id == "notion").unwrap();
        assert!(notion.scopes.is_empty());
        assert!(notion
            .setup_message
            .contains("does not take OAuth scope query parameters"));
    }
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::models::ConnectorAccountSummary;
    use crate::store::repos::workspace_directory::clear_current_internal_user;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    #[test]
    fn connector_commands_fail_closed_for_an_unconfigured_workspace() {
        let error = require_connector_workspace(Some("another-workspace".to_string())).unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }

    #[test]
    fn connector_statuses_remain_truthful_for_an_unconfigured_workspace() {
        let manifests = list_unconfigured_workspace_connector_statuses();

        assert_eq!(manifests.len(), SUPPORTED_CONNECTOR_IDS.len());
        assert!(manifests
            .iter()
            .all(|manifest| manifest.status == "unconfigured"));
        assert!(manifests.iter().all(|manifest| {
            manifest.setup_message.as_deref()
                == Some("Connector credentials are not configured for this Mivlet workspace.")
                && manifest.account.is_none()
                && !manifest.supports_search
                && !manifest.supports_import
                && manifest.supported_actions.is_empty()
                && manifest.scopes.iter().all(|scope| !scope.granted)
        }));
    }

    #[test]
    fn google_requested_optional_scope_uses_complete_reconnect_scope_set() {
        let entry = require_connector("gmail").unwrap();
        let scopes = selected_auth_scopes(
            entry,
            Some(&["https://www.googleapis.com/auth/gmail.send".to_string()]),
        )
        .unwrap();

        assert_eq!(
            scopes,
            vec![
                "https://www.googleapis.com/auth/gmail.readonly".to_string(),
                "https://www.googleapis.com/auth/gmail.send".to_string()
            ]
        );
    }

    #[test]
    fn requested_oauth_scope_set_must_not_be_empty() {
        let entry = require_connector("gmail").unwrap();
        let error = selected_auth_scopes(entry, Some(&[])).unwrap_err();

        assert_eq!(error.code, "invalid-request");
        assert_eq!(
            error.message,
            "Requested OAuth scope set requires at least one scope."
        );
    }

    #[test]
    fn notion_connect_allows_empty_oauth_scope_set() {
        let entry = require_connector("notion").unwrap();
        let scopes = selected_auth_scopes(entry, Some(&[])).unwrap();
        assert!(scopes.is_empty());
        assert!(selected_auth_scopes(entry, None).unwrap().is_empty());
    }

    #[test]
    fn connector_request_rejects_retired_project_scope_and_connection_substitution() {
        require_workspace_connection_target("github", None, None, "connection-1").unwrap();
        require_workspace_connection_target(
            "github",
            None,
            Some("connection-1".into()),
            "connection-1",
        )
        .unwrap();
        let retired = require_workspace_connection_target(
            "github",
            Some("project-1".into()),
            Some("connection-1".into()),
            "connection-1",
        )
        .unwrap_err();
        assert_eq!(retired.code, "invalid-request");
        let substituted = require_workspace_connection_target(
            "github",
            None,
            Some("connection-2".into()),
            "connection-1",
        )
        .unwrap_err();
        assert_eq!(substituted.code, "conflict");
    }

    #[test]
    fn account_listing_reconciles_canonical_records_with_installation_local_authority() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope_a = store
            .transaction(|tx| resolve(tx, None, None, ScopeAccess::Write))
            .unwrap();
        let connection = ConnectorConnection {
            connector_id: "gmail".into(),
            account: ConnectorAccountSummary {
                id: "provider-account-secret".into(),
                display_name: "Work Gmail".into(),
                handle: None,
                email: None,
                workspace: None,
                avatar_url: None,
            },
            status: "connected".into(),
            scopes: vec!["https://www.googleapis.com/auth/gmail.readonly".into()],
            expires_at: None,
            credential_ref: crate::connector_auth::native_connector_credential_ref(
                "gmail",
                "provider-account-secret",
            ),
            connected_at: "1".into(),
            updated_at: "2".into(),
            is_active: true,
        };

        reconcile_canonical_connector_accounts(
            &store,
            &scope_a,
            "gmail",
            std::slice::from_ref(&connection),
        )
        .unwrap();
        reconcile_canonical_connector_accounts(
            &store,
            &scope_a,
            "gmail",
            std::slice::from_ref(&connection),
        )
        .unwrap();
        let records = store
            .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].revision, 1);
        let evidence = store
            .with_conn(|tx| {
                crate::store::repos::capability_evidence::list_current_for_connection(
                    tx,
                    &scope_a,
                    &records[0].id,
                )
            })
            .unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].capability_key, "communication.email.search");
        assert_eq!(evidence[0].availability, "degraded");
        assert_eq!(evidence[0].revision, 1);
        assert!(!serde_json::to_string(&evidence)
            .unwrap()
            .contains("provider-account-secret"));
        assert!(
            require_selectable_canonical_connection(&store, &scope_a, "gmail", &records[0].id,)
                .is_ok()
        );
        let selected = selected_connection_evidence(&store, &scope_a, "gmail").unwrap();
        assert_eq!(selected.connection_id, records[0].id);
        let stamped = bind_search_result_to_connection(
            ConnectorSearchResult {
                connector_id: "gmail".into(),
                query: "launch".into(),
                items: vec![crate::models::ConnectorSearchItem {
                    id: "message-1".into(),
                    connector_id: "gmail".into(),
                    connection_id: None,
                    title: "Launch".into(),
                    kind: "message".into(),
                    summary: "Summary".into(),
                    provenance: "Connector: gmail".into(),
                    freshness: "Now".into(),
                    trust: "untrusted".into(),
                    url: None,
                    content_preview: None,
                    provider_metadata: BTreeMap::new(),
                }],
                next_cursor: None,
                source: "live".into(),
                searched_at: "t".into(),
            },
            &selected.connection_id,
        );
        assert_eq!(
            stamped.items[0].connection_id.as_deref(),
            Some(selected.connection_id.as_str())
        );
        let bound = bind_source_to_private_connection(
            ConnectorImportResult {
                source: ConnectorKnowledgeSource {
                    workspace_id: None,
                    authority_scope: None,
                    scope: None,
                    id: "connector-gmail-message-1".into(),
                    title: "Launch".into(),
                    kind: "document".into(),
                    connector_id: "gmail".into(),
                    connection_id: None,
                    provenance: "Connector: gmail".into(),
                    freshness: "Now".into(),
                    pinned: false,
                    trust: "untrusted".into(),
                    content_preview: Some("Summary".into()),
                    imported_at: "t".into(),
                    origin: "connector-import".into(),
                    provider_metadata: BTreeMap::new(),
                    disabled: false,
                    deleted_at: None,
                    status: Some("ok".into()),
                    status_message: None,
                },
                imported: true,
            },
            &scope_a,
            &selected.connection_id,
        );
        assert_eq!(
            bound.source.connection_id.as_deref(),
            Some(selected.connection_id.as_str())
        );
        assert_eq!(
            bound.source.workspace_id.as_deref(),
            Some(scope_a.data.workspace_id())
        );
        assert_eq!(
            bound
                .source
                .authority_scope
                .as_ref()
                .and_then(|authority| authority.owner_member_id.as_deref()),
            scope_a.member_id.as_deref()
        );
        let mut unsafe_source = bound.source.clone();
        unsafe_source.content_preview = Some("Bearer ghp_supersecretvalue".into());
        unsafe_source
            .provider_metadata
            .insert("access_token".into(), "provider-secret".into());
        let normalized =
            normalize_connector_knowledge_source(unsafe_source, &scope_a.private).unwrap();
        let encoded = serde_json::to_string(&normalized).unwrap();
        assert!(!encoded.contains("ghp_supersecretvalue"));
        assert!(!encoded.contains("provider-secret"));
        assert!(encoded.contains("[redacted connector data]"));
        let first = merge_connector_knowledge_source(Vec::new(), bound.source.clone()).unwrap();
        let mut replacement = bound.source.clone();
        replacement.title = "Updated launch".into();
        let replaced = merge_connector_knowledge_source(first, replacement).unwrap();
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].title, "Updated launch");
        let mut tombstone = replaced[0].clone();
        tombstone.deleted_at = Some("later".into());
        assert!(merge_connector_knowledge_source(vec![tombstone], bound.source.clone()).is_err());
        assert!(!serde_json::to_string(&records)
            .unwrap()
            .contains("provider-account-secret"));
        persist_connector_health_state(
            &store,
            &scope_a,
            "gmail",
            "provider-account-secret",
            &ConnectorHealth {
                state: "healthy".into(),
                summary: "Provider identity verified.".into(),
                checked_at: "3".into(),
                retry_after: None,
            },
        )
        .unwrap();
        let canonical_health = store
            .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
            .unwrap();
        assert_eq!(canonical_health[0].health_state, "healthy");
        assert_eq!(canonical_health[0].revision, 2);
        assert!(store
            .with_conn(|tx| {
                crate::store::repos::capability_evidence::list_current_for_connection(
                    tx,
                    &scope_a,
                    &canonical_health[0].id,
                )
            })
            .unwrap()
            .is_empty());
        let projected = project_canonical_account_options(
            account_options_from_connections(
                std::slice::from_ref(&connection),
                "gmail",
                scope_a.data.workspace_id(),
            ),
            &canonical_health,
            "gmail",
            Some(&canonical_health[0].id),
        )
        .unwrap();
        assert_eq!(projected[0].health_state, "healthy");
        assert!(project_canonical_account_options(
            account_options_from_connections(
                std::slice::from_ref(&connection),
                "gmail",
                scope_a.data.workspace_id(),
            ),
            &[],
            "gmail",
            None,
        )
        .is_err());

        persist_connector_health_state(
            &store,
            &scope_a,
            "gmail",
            "provider-account-secret",
            &ConnectorHealth {
                state: "degraded".into(),
                summary: "Provider temporarily unavailable.".into(),
                checked_at: "4".into(),
                retry_after: Some("later".into()),
            },
        )
        .unwrap();
        let degraded = store
            .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
            .unwrap();
        assert_eq!(degraded[0].health_state, "degraded");
        assert_eq!(degraded[0].revision, 3);
        assert!(require_selectable_canonical_connection(
            &store,
            &scope_a,
            "gmail",
            &degraded[0].id,
        )
        .is_ok());
        store
            .transaction(|tx| {
                crate::store::repos::connection_record::transition_native_connector(
                    tx,
                    &store,
                    &scope_a,
                    &degraded[0].id,
                    degraded[0].revision,
                    "refresh-required",
                    "expired",
                    "unhealthy",
                    "refresh-required",
                    "5",
                )?;
                Ok(())
            })
            .unwrap();
        let unavailable =
            require_selectable_canonical_connection(&store, &scope_a, "gmail", &degraded[0].id)
                .unwrap_err();
        assert_eq!(unavailable.code, "needs-auth");

        let scope_after_account_change = store
            .transaction(|tx| {
                clear_current_internal_user(tx)?;
                resolve(tx, None, None, ScopeAccess::Write)
            })
            .unwrap();
        assert_eq!(scope_after_account_change, scope_a);
        reconcile_canonical_connector_accounts(&store, &scope_a, "gmail", &[connection]).unwrap();
        persist_connector_health_state(
            &store,
            &scope_a,
            "gmail",
            "provider-account-secret",
            &ConnectorHealth {
                state: "degraded".into(),
                summary: "Provider temporarily unavailable.".into(),
                checked_at: "4".into(),
                retry_after: Some("later".into()),
            },
        )
        .unwrap();
    }
}
