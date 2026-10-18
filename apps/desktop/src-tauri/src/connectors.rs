//! Supported connector runtime boundary.
//!
//! Provider adapters plug into this shared command surface. OAuth/token work is
//! delegated to `connector_auth`; secrets never enter this module or JavaScript.

use std::collections::{BTreeMap, BTreeSet};
mod catalog;
mod drive_artifacts;
mod knowledge;
pub(crate) use catalog::connection_has_disallowed_github_scope;
use catalog::*;
use knowledge::*;

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
#[path = "connectors/tests.rs"]
mod workspace_scope_tests;
