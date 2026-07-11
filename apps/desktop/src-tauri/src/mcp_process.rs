//! Native process custody for machine-local STDIO MCP servers.
//!
//! Launch details are resolved from the encrypted owner-bound repository by an
//! opaque reference. The renderer cannot supply an executable or arguments at
//! spawn time, and every subsequent write/close rechecks the active account and
//! workspace before touching the session.

use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::mpsc,
    time::timeout,
};
use url::Url;

const MAX_MCP_FRAME_BYTES: usize = 10 * 1024 * 1024;
const MCP_EVENT_CHANNEL_PREFIX: &str = "fable://mcp/";

struct McpChild {
    child: Child,
    stdin: Option<mpsc::Sender<String>>,
    workspace_id: String,
    owner_subject: String,
    connection_id: String,
    connection_revision: i64,
}

type ProcessMap = HashMap<String, McpChild>;

fn process_map() -> &'static Mutex<ProcessMap> {
    static MAP: OnceLock<Mutex<ProcessMap>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct McpRemoteSession {
    endpoint: Url,
    workspace_id: String,
    owner_subject: String,
    connection_id: String,
    connection_revision: i64,
    server_session_id: Option<String>,
    initialized: bool,
    busy: bool,
}

fn remote_sessions() -> &'static Mutex<HashMap<String, McpRemoteSession>> {
    static MAP: OnceLock<Mutex<HashMap<String, McpRemoteSession>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

struct McpToolPermit {
    session_id: String,
    connection_id: String,
    connection_revision: i64,
    tool_name: String,
    arguments_fingerprint: String,
    issued_at: Instant,
}

fn tool_permits() -> &'static Mutex<HashMap<String, McpToolPermit>> {
    static MAP: OnceLock<Mutex<HashMap<String, McpToolPermit>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PendingMcpAudit {
    tool_name: String,
    connection_id: String,
    actor: String,
}

fn pending_audits() -> &'static Mutex<HashMap<String, PendingMcpAudit>> {
    static MAP: OnceLock<Mutex<HashMap<String, PendingMcpAudit>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnMcpProcessRequest {
    workspace_id: String,
    launch_reference: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedMcpProcess {
    session_id: String,
    channel: String,
    launch_reference: String,
    connection_id: String,
    connection_revision: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRemoteMcpSessionRequest {
    workspace_id: String,
    configuration_reference: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRemoteMcpSession {
    session_id: String,
    configuration_reference: String,
    connection_id: String,
    connection_revision: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRemoteMcpFrameRequest {
    workspace_id: String,
    session_id: String,
    frame: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRemoteMcpAuthorizationRequest {
    workspace_id: String,
    configuration_reference: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpAuthorizationSummary {
    issuer: String,
    scopes: Vec<String>,
    pkce_method: String,
    client_id_metadata_document_supported: bool,
    dynamic_registration_supported: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMcpFrameRequest {
    workspace_id: String,
    session_id: String,
    frame: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseMcpProcessRequest {
    workspace_id: String,
    session_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfiguration {
    workspace_id: String,
    id: String,
    display_name: String,
    #[serde(default = "default_mcp_transport")]
    transport: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    endpoint: Option<String>,
    expected_revision: Option<i64>,
}

fn default_mcp_transport() -> String {
    "stdio".into()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMcpServerConfiguration {
    configuration_fingerprint: String,
    approval: crate::models::ApprovalRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMcpServerConfigurationRequest {
    configuration: McpServerConfiguration,
    resolution: crate::models::ApprovalResolutionRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMcpDiscoveryRequest {
    workspace_id: String,
    session_id: String,
    tools: Vec<String>,
    resources: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMcpEnablementRequest {
    workspace_id: String,
    connection_id: String,
    expected_revision: i64,
    enabled_tools: Vec<String>,
    enabled_resources: Vec<String>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolProposal {
    workspace_id: String,
    session_id: String,
    tool_name: String,
    arguments: Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMcpToolCall {
    proposal_fingerprint: String,
    approval: crate::models::ApprovalRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeMcpToolCallRequest {
    proposal: McpToolProposal,
    resolution: crate::models::ApprovalResolutionRequest,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedMcpToolCall {
    permit_id: String,
    expires_in_seconds: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteMcpToolCallRequest {
    proposal: McpToolProposal,
    permit_id: String,
    request_id: String,
}

#[tauri::command]
pub fn prepare_mcp_server_configuration(
    configuration: McpServerConfiguration,
) -> Result<PreparedMcpServerConfiguration, String> {
    crate::authorized_scope::command_scope(
        Some(configuration.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    validate_configuration_for_approval(&configuration)?;
    let fingerprint = configuration_fingerprint(&configuration)?;
    let id = random_session_id()?.replacen("mcp-", "approval-mcp-", 1);
    let approval = approval_for_configuration(
        &configuration,
        &fingerprint,
        id,
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    Ok(PreparedMcpServerConfiguration {
        configuration_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub fn commit_mcp_server_configuration(
    app: AppHandle,
    request: CommitMcpServerConfigurationRequest,
) -> Result<crate::store::repos::mcp_local_server::SafeMcpLocalServer, String> {
    validate_configuration_for_approval(&request.configuration)?;
    let fingerprint = configuration_fingerprint(&request.configuration)?;
    let expected = approval_for_configuration(
        &request.configuration,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The MCP configuration changed after the approval preview.".to_string());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Local MCP configuration requires a fresh one-time approval.".to_string());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let scope = crate::authorized_scope::command_scope(
        Some(request.configuration.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let now = resolution.audit_entry.decided_at;
    store
        .transaction(|tx| {
            let saved = crate::store::repos::mcp_local_server::upsert(
                tx,
                store,
                &scope,
                crate::store::repos::mcp_local_server::McpLocalServerWrite {
                    id: &request.configuration.id,
                    display_name: &request.configuration.display_name,
                    transport: &request.configuration.transport,
                    command: &request.configuration.command,
                    args: &request.configuration.args,
                    endpoint: request.configuration.endpoint.as_deref(),
                    expected_revision: request.configuration.expected_revision,
                    updated_at: &now,
                },
            )?;
            if saved.transport == "stdio" {
                crate::store::repos::connection_record::upsert_mcp_stdio(
                    tx,
                    store,
                    &scope,
                    &saved.id,
                    &saved.display_name,
                    &now,
                )?;
            } else {
                crate::store::repos::connection_record::upsert_mcp_streamable_http(
                    tx,
                    store,
                    &scope,
                    &saved.id,
                    &saved.display_name,
                    &now,
                )?;
            }
            Ok(saved)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_mcp_server_configurations(
    workspace_id: String,
) -> Result<Vec<crate::store::repos::mcp_local_server::SafeMcpLocalServer>, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| crate::store::repos::mcp_local_server::list(tx, store, &scope))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_remote_mcp_session(
    request: OpenRemoteMcpSessionRequest,
) -> Result<OpenedRemoteMcpSession, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let configuration = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This remote MCP server is unavailable.".to_string())?;
    if configuration.metadata.disabled || configuration.metadata.transport != "streamable-http" {
        return Err("This remote MCP server is unavailable.".to_string());
    }
    let endpoint = validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?;
    let session_id = random_session_id()?;
    remote_sessions()
        .lock()
        .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?
        .insert(
            session_id.clone(),
            McpRemoteSession {
                endpoint,
                workspace_id: scope.data.workspace_id().to_string(),
                owner_subject: scope.private.owner_subject().to_string(),
                connection_id: connection.connection_id.clone(),
                connection_revision: connection.connection_revision,
                server_session_id: None,
                initialized: false,
                busy: false,
            },
        );
    Ok(OpenedRemoteMcpSession {
        session_id,
        configuration_reference: request.configuration_reference,
        connection_id: connection.connection_id,
        connection_revision: connection.connection_revision,
    })
}

#[tauri::command]
pub async fn inspect_remote_mcp_authorization(
    request: InspectRemoteMcpAuthorizationRequest,
) -> Result<RemoteMcpAuthorizationSummary, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let configuration = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This remote MCP server is unavailable.".to_string())?;
    if configuration.metadata.disabled || configuration.metadata.transport != "streamable-http" {
        return Err("This remote MCP server is unavailable.".into());
    }
    let endpoint = validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    discover_remote_authorization(&endpoint).await
}

#[tauri::command]
pub async fn send_remote_mcp_frame(
    request: SendRemoteMcpFrameRequest,
) -> Result<Vec<String>, String> {
    if !valid_session_id(&request.session_id) || !permitted_renderer_frame(&request.frame) {
        return Err("The remote MCP frame is invalid or not permitted.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let snapshot = {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if session.busy {
            return Err("This remote MCP session is already handling a request.".to_string());
        }
        session.busy = true;
        session.clone()
    };
    let result = post_remote_mcp_frame(&snapshot, &request.frame).await;
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(&request.session_id) {
            session.busy = false;
            if let Ok(response) = &result {
                if response.initialized {
                    session.initialized = true;
                }
                if let Some(server_session_id) = &response.server_session_id {
                    session.server_session_id = Some(server_session_id.clone());
                }
            }
        }
    }
    result.map(|response| response.frames)
}

#[tauri::command]
pub async fn close_remote_mcp_session(request: CloseMcpProcessRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("The remote MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let session = {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get(&request.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        sessions
            .remove(&request.session_id)
            .expect("session existed")
    };
    if session.server_session_id.is_some() {
        delete_remote_mcp_session(&session).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn record_mcp_server_discovery(
    request: RecordMcpDiscoveryRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let local = process_map()
        .lock()
        .map_err(|_| "Fable could not access MCP sessions.".to_string())?
        .get(&request.session_id)
        .map(|process| {
            require_session_owner(process, &scope)?;
            Ok::<(String, i64), String>((
                process.connection_id.clone(),
                process.connection_revision,
            ))
        })
        .transpose()?;
    let (connection_id, connection_revision) = if let Some(local) = local {
        local
    } else {
        let sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access MCP sessions.".to_string())?;
        let session = sessions
            .get(&request.session_id)
            .ok_or_else(|| "This MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        (session.connection_id.clone(), session.connection_revision)
    };
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let recorded = store
        .transaction(|tx| {
            crate::store::repos::connection_record::record_mcp_discovery(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                request.tools,
                request.resources,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())?;
    if let Ok(mut map) = process_map().lock() {
        if let Some(process) = map.get_mut(&request.session_id) {
            if process.connection_id == recorded.connection_id
                && process.connection_revision == connection_revision
            {
                process.connection_revision = recorded.connection_revision;
            }
        }
    }
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(&request.session_id) {
            if session.connection_id == recorded.connection_id
                && session.connection_revision == connection_revision
            {
                session.connection_revision = recorded.connection_revision;
            }
        }
    }
    Ok(recorded)
}

#[tauri::command]
pub fn set_mcp_server_enablement(
    request: SetMcpEnablementRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::connection_record::set_mcp_enablement(
                tx,
                store,
                &scope,
                &request.connection_id,
                request.expected_revision,
                request.enabled_tools,
                request.enabled_resources,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn prepare_mcp_tool_call(proposal: McpToolProposal) -> Result<PreparedMcpToolCall, String> {
    let context = validate_tool_proposal(&proposal)?;
    let approval = approval_for_tool_proposal(
        &proposal,
        &context.proposal_fingerprint,
        random_session_id()?.replacen("mcp-", "approval-mcp-tool-", 1),
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    Ok(PreparedMcpToolCall {
        proposal_fingerprint: context.proposal_fingerprint,
        approval,
    })
}

#[tauri::command]
pub fn authorize_mcp_tool_call(
    app: AppHandle,
    request: AuthorizeMcpToolCallRequest,
) -> Result<AuthorizedMcpToolCall, String> {
    let context = validate_tool_proposal(&request.proposal)?;
    let expected = approval_for_tool_proposal(
        &request.proposal,
        &context.proposal_fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The MCP tool proposal changed after approval preview.".into());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    // Re-resolve every authority after permit I/O so an account, session,
    // Connection revision, or enablement change cannot race approval.
    let current = validate_tool_proposal(&request.proposal)?;
    if current.proposal_fingerprint != context.proposal_fingerprint {
        return Err("The MCP tool proposal changed during approval.".into());
    }
    let permit_id = random_session_id()?.replacen("mcp-", "mcp-permit-", 1);
    let permit = McpToolPermit {
        session_id: request.proposal.session_id,
        connection_id: current.connection_id,
        connection_revision: current.connection_revision,
        tool_name: request.proposal.tool_name,
        arguments_fingerprint: current.arguments_fingerprint,
        issued_at: Instant::now(),
    };
    let mut permits = tool_permits()
        .lock()
        .map_err(|_| "Fable could not access MCP execution permits.".to_string())?;
    permits.retain(|_, value| value.issued_at.elapsed() <= Duration::from_secs(60));
    permits.insert(permit_id.clone(), permit);
    Ok(AuthorizedMcpToolCall {
        permit_id,
        expires_in_seconds: 60,
    })
}

#[tauri::command]
pub async fn execute_approved_mcp_tool_call(
    request: ExecuteMcpToolCallRequest,
) -> Result<(), String> {
    if !valid_request_id(&request.request_id) {
        return Err("The MCP request id is invalid.".into());
    }
    let permit = tool_permits()
        .lock()
        .map_err(|_| "Fable could not access MCP execution permits.".to_string())?
        .remove(&request.permit_id)
        .ok_or_else(|| "The MCP execution permit is unavailable or already used.".to_string())?;
    if permit.issued_at.elapsed() > Duration::from_secs(60) {
        return Err("The MCP execution permit expired.".into());
    }
    let context = validate_tool_proposal(&request.proposal)?;
    if permit.session_id != request.proposal.session_id
        || permit.connection_id != context.connection_id
        || permit.connection_revision != context.connection_revision
        || permit.tool_name != request.proposal.tool_name
        || permit.arguments_fingerprint != context.arguments_fingerprint
    {
        return Err("The MCP execution permit does not match this exact tool call.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.proposal.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let sender = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.proposal.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        process
            .stdin
            .clone()
            .ok_or_else(|| "This local MCP session is closed.".to_string())?
    };
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request.request_id,
        "method": "tools/call",
        "params": {
            "name": request.proposal.tool_name,
            "arguments": request.proposal.arguments
        }
    })
    .to_string();
    if frame.len() > MAX_MCP_FRAME_BYTES || !valid_mcp_frame(&frame) {
        return Err("The approved MCP tool frame is invalid.".into());
    }
    let audit_key = pending_audit_key(&request.proposal.session_id, &request.request_id);
    pending_audits()
        .lock()
        .map_err(|_| "Fable could not access MCP audit state.".to_string())?
        .insert(
            audit_key.clone(),
            PendingMcpAudit {
                tool_name: request.proposal.tool_name,
                connection_id: context.connection_id,
                actor: scope.internal_user_id,
            },
        );
    if sender.send(frame).await.is_err() {
        if let Some(pending) = pending_audits()
            .lock()
            .ok()
            .and_then(|mut audits| audits.remove(&audit_key))
        {
            record_mcp_audit(pending, &request.request_id, true, "transport-closed");
        }
        return Err("This local MCP session is closed.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn spawn_mcp_process(
    app: AppHandle,
    request: SpawnMcpProcessRequest,
) -> Result<SpawnedMcpProcess, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let launch = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This local MCP server is unavailable.".to_string())?;
    if launch.metadata.disabled {
        return Err("This local MCP server is disabled.".to_string());
    }
    if launch.metadata.transport != "stdio" {
        return Err("This MCP server does not use the local STDIO transport.".to_string());
    }
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?;

    let executable = validate_executable(&launch.command)?;
    let workspace_root = crate::tools::resolve_workspace_root(&app)?;
    let mut child = spawn_mcp_child(&executable, &launch.args, &workspace_root)
        .map_err(|_| "Fable could not start this local MCP server.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdout pipe.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Fable could not open the MCP stderr pipe.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdin pipe.".to_string())?;

    let session_id = random_session_id()?;
    let channel = format!("{MCP_EVENT_CHANNEL_PREFIX}{session_id}");
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(frame) = stdin_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    let stdout_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut reader = stdout;
        let mut decoder = BoundedLineDecoder::default();
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(count) => {
                    for line in decoder.push(&chunk[..count]) {
                        if let Ok(text) = String::from_utf8(line) {
                            if valid_mcp_frame(&text) {
                                audit_mcp_response(&stdout_session_id, &text);
                                let _ = stdout_app.emit(&stdout_channel, text);
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stdout_app.emit(&stdout_channel, "[MCP-CLOSED]");
    });
    // Stderr may contain credentials or provider diagnostics. Drain it so the
    // child cannot block, but never forward it across the native boundary.
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0_u8; 8 * 1024];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
        }
    });

    process_map()
        .lock()
        .map_err(|_| "Fable could not access local MCP sessions.".to_string())?
        .insert(
            session_id.clone(),
            McpChild {
                child,
                stdin: Some(stdin_tx),
                workspace_id: scope.data.workspace_id().to_string(),
                owner_subject: scope.private.owner_subject().to_string(),
                connection_id: connection.connection_id.clone(),
                connection_revision: connection.connection_revision,
            },
        );
    Ok(SpawnedMcpProcess {
        session_id,
        channel,
        launch_reference: launch.metadata.id,
        connection_id: connection.connection_id,
        connection_revision: connection.connection_revision,
    })
}

#[tauri::command]
pub async fn write_mcp_frame(request: WriteMcpFrameRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) || !permitted_renderer_frame(&request.frame) {
        return Err("The MCP frame is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let sender = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        process
            .stdin
            .clone()
            .ok_or_else(|| "This local MCP session is closed.".to_string())?
    };
    sender
        .send(request.frame)
        .await
        .map_err(|_| "This local MCP session is closed.".to_string())
}

#[tauri::command]
pub async fn close_mcp_process(request: CloseMcpProcessRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let mut process = {
        let mut map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        map.remove(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?
    };
    drain_session_audits(&request.session_id);
    if let Ok(mut permits) = tool_permits().lock() {
        permits.retain(|_, permit| permit.session_id != request.session_id);
    }
    process.stdin.take();
    match timeout(Duration::from_secs(2), process.child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => {
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
            Ok(())
        }
    }
}

fn require_session_owner(
    process: &McpChild,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), String> {
    if process.workspace_id != scope.data.workspace_id()
        || process.owner_subject != scope.private.owner_subject()
    {
        return Err("This local MCP session belongs to a different account or workspace.".into());
    }
    Ok(())
}

fn require_remote_session_owner(
    session: &McpRemoteSession,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), String> {
    if session.workspace_id != scope.data.workspace_id()
        || session.owner_subject != scope.private.owner_subject()
    {
        return Err("This remote MCP session belongs to a different account or workspace.".into());
    }
    Ok(())
}

struct ToolProposalContext {
    connection_id: String,
    connection_revision: i64,
    arguments_fingerprint: String,
    proposal_fingerprint: String,
}

fn validate_tool_proposal(proposal: &McpToolProposal) -> Result<ToolProposalContext, String> {
    if !valid_session_id(&proposal.session_id) {
        return Err("The MCP session id is invalid.".into());
    }
    validate_mcp_tool_name(&proposal.tool_name)?;
    validate_mcp_arguments(&proposal.arguments)?;
    let scope = crate::authorized_scope::command_scope(
        Some(proposal.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let (connection_id, connection_revision) = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&proposal.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        (process.connection_id.clone(), process.connection_revision)
    };
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            crate::store::repos::connection_record::require_enabled_mcp_tool(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                &proposal.tool_name,
            )
        })
        .map_err(|error| error.to_string())?;
    let arguments = serde_json::to_vec(&proposal.arguments)
        .map_err(|_| "The MCP tool arguments are invalid.".to_string())?;
    let arguments_fingerprint = format!("{:x}", Sha256::digest(&arguments));
    let proposal_value = serde_json::json!({
        "sessionId": proposal.session_id,
        "connectionId": connection_id,
        "connectionRevision": connection_revision,
        "toolName": proposal.tool_name,
        "argumentsFingerprint": arguments_fingerprint
    });
    let proposal_fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&proposal_value)
                .map_err(|_| "The MCP tool proposal is invalid.".to_string())?
        )
    );
    Ok(ToolProposalContext {
        connection_id,
        connection_revision,
        arguments_fingerprint,
        proposal_fingerprint,
    })
}

fn approval_for_tool_proposal(
    proposal: &McpToolProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    crate::models::ApprovalRequest {
        id,
        service: "MCP tools".into(),
        action: format!("run MCP tool {}", proposal.tool_name),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![format!("proposal fingerprint: {fingerprint}")],
        consequence: "Runs an enabled tool in user-managed local software.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(format!("run {}", proposal.tool_name)),
    }
}

fn validate_mcp_tool_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("The MCP tool name is invalid.".into());
    }
    Ok(())
}

fn validate_mcp_arguments(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("MCP tool arguments must be a JSON object.".into());
    }
    let encoded =
        serde_json::to_vec(value).map_err(|_| "The MCP tool arguments are invalid.".to_string())?;
    if encoded.len() > 1024 * 1024 {
        return Err("MCP tool arguments exceed the supported size.".into());
    }
    fn walk(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if depth > 20 || *nodes > 10_000 {
            return Err("MCP tool arguments are too deeply nested or complex.".into());
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    let lower = key.to_ascii_lowercase();
                    if [
                        "authorization",
                        "apikey",
                        "api_key",
                        "password",
                        "secret",
                        "token",
                    ]
                    .iter()
                    .any(|marker| lower.contains(marker))
                    {
                        return Err("Credentials cannot be passed in MCP tool arguments.".into());
                    }
                    walk(child, depth + 1, nodes)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    walk(child, depth + 1, nodes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut nodes = 0;
    walk(value, 0, &mut nodes)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:".contains(character))
}

fn pending_audit_key(session_id: &str, request_id: &str) -> String {
    format!("{session_id}:{request_id}")
}

fn audit_mcp_response(session_id: &str, frame: &str) {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return;
    };
    if object.contains_key("method") {
        return;
    }
    let Some(request_id) = object.get("id").and_then(Value::as_str) else {
        return;
    };
    let key = pending_audit_key(session_id, request_id);
    let pending = pending_audits()
        .lock()
        .ok()
        .and_then(|mut audits| audits.remove(&key));
    let Some(pending) = pending else {
        return;
    };
    let failed = object.contains_key("error");
    record_mcp_audit(
        pending,
        request_id,
        failed,
        if failed { "mcp-tool-error" } else { "" },
    );
}

fn record_mcp_audit(pending: PendingMcpAudit, request_id: &str, failed: bool, error_code: &str) {
    let mut recorder = crate::action_history::Recorder::new(
        crate::store::repos::action_history::category::TOOL_ACTION,
        "MCP",
        &pending.tool_name,
        if failed { "failed" } else { "completed" },
    )
    .actor(&pending.actor)
    .risk("critical")
    .mode("full-access")
    .correlation(request_id)
    .summary(if failed {
        "Approved MCP tool call failed."
    } else {
        "Approved MCP tool call completed."
    })
    .detail(serde_json::json!({ "connectionId": pending.connection_id }));
    if failed {
        recorder = recorder.error(error_code);
    }
    recorder.record();
}

fn drain_session_audits(session_id: &str) {
    let prefix = format!("{session_id}:");
    let drained = pending_audits()
        .lock()
        .map(|mut audits| {
            let keys = audits
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| audits.remove(&key).map(|pending| (key, pending)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (key, pending) in drained {
        let request_id = key.strip_prefix(&prefix).unwrap_or("unknown");
        record_mcp_audit(pending, request_id, true, "session-closed");
    }
}

const MCP_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

struct RemotePostResponse {
    frames: Vec<String>,
    server_session_id: Option<String>,
    initialized: bool,
}

fn validate_remote_endpoint(raw: &str) -> Result<Url, String> {
    let mut endpoint =
        Url::parse(raw).map_err(|_| "Remote MCP requires a valid HTTPS endpoint.".to_string())?;
    if endpoint.scheme() != "https"
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(
            "Remote MCP endpoints must use HTTPS without credentials or a fragment.".into(),
        );
    }
    if endpoint.host_str().is_some_and(|host| {
        let host = host.to_ascii_lowercase();
        host == "localhost"
            || host == "local"
            || host.ends_with(".localhost")
            || host.ends_with(".local")
    }) {
        return Err("Remote MCP endpoints cannot target local network names.".into());
    }
    if endpoint.port().is_some_and(crate::tools::is_unsafe_port) {
        return Err("Remote MCP endpoints cannot use an unsafe port.".into());
    }
    const CREDENTIAL_QUERY_MARKERS: &[&str] = &[
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "password",
        "secret",
        "token",
    ];
    if endpoint.query_pairs().any(|(key, _)| {
        let key = key.to_ascii_lowercase();
        CREDENTIAL_QUERY_MARKERS
            .iter()
            .any(|marker| key.contains(marker))
    }) {
        return Err("Remote MCP endpoint queries cannot contain credentials.".into());
    }
    match endpoint.host() {
        Some(url::Host::Ipv4(ip)) if crate::tools::is_forbidden_ip(IpAddr::V4(ip)) => {
            return Err("Remote MCP endpoints cannot target private or reserved networks.".into())
        }
        Some(url::Host::Ipv6(ip)) if crate::tools::is_forbidden_ip(IpAddr::V6(ip)) => {
            return Err("Remote MCP endpoints cannot target private or reserved networks.".into())
        }
        _ => {}
    }
    if endpoint.port() == Some(443) {
        let _ = endpoint.set_port(None);
    }
    Ok(endpoint)
}

async fn remote_http_client(endpoint: &Url) -> Result<reqwest::Client, String> {
    crate::ensure_rustls_provider();
    let mut builder = reqwest::Client::builder()
        .timeout(MCP_HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Fable/0.1 (MCP)");
    match endpoint.host() {
        Some(url::Host::Domain(host)) => {
            let port = endpoint.port_or_known_default().unwrap_or(443);
            let addrs = tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| "Remote MCP endpoint DNS lookup failed.".to_string())?
                .collect::<Vec<_>>();
            if addrs.is_empty()
                || addrs
                    .iter()
                    .any(|address| crate::tools::is_forbidden_ip(address.ip()))
            {
                return Err(
                    "Remote MCP endpoint resolved to a private or reserved network.".into(),
                );
            }
            builder = builder.resolve_to_addrs(host, &addrs);
        }
        Some(url::Host::Ipv4(ip)) if crate::tools::is_forbidden_ip(IpAddr::V4(ip)) => {
            return Err("Remote MCP endpoint targets a private or reserved network.".into())
        }
        Some(url::Host::Ipv6(ip)) if crate::tools::is_forbidden_ip(IpAddr::V6(ip)) => {
            return Err("Remote MCP endpoint targets a private or reserved network.".into())
        }
        Some(_) => {}
        None => return Err("Remote MCP endpoint has no host.".into()),
    }
    builder
        .build()
        .map_err(|_| "Fable could not initialize the remote MCP transport.".into())
}

fn valid_server_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn canonical_remote_frame(payload: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|_| "Remote MCP returned malformed JSON-RPC.".to_string())?;
    let encoded = serde_json::to_string(&value)
        .map_err(|_| "Remote MCP returned malformed JSON-RPC.".to_string())?;
    if !valid_mcp_frame(&encoded) {
        return Err("Remote MCP returned an invalid JSON-RPC message.".into());
    }
    Ok(encoded)
}

fn parse_remote_sse(body: &[u8]) -> Result<Vec<String>, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "Remote MCP returned non-UTF-8 event data.".to_string())?;
    let mut frames = Vec::new();
    let mut data = Vec::new();
    for line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if line.is_empty() {
            if !data.is_empty() {
                frames.push(canonical_remote_frame(&data.join("\n"))?);
                data.clear();
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        }
    }
    if !data.is_empty() {
        frames.push(canonical_remote_frame(&data.join("\n"))?);
    }
    if frames.is_empty() {
        return Err("Remote MCP event stream returned no JSON-RPC messages.".into());
    }
    Ok(frames)
}

async fn read_remote_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("Remote MCP response exceeded the supported limit.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Remote MCP response could not be read.".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Remote MCP response exceeded the supported limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn post_remote_mcp_frame(
    session: &McpRemoteSession,
    frame: &str,
) -> Result<RemotePostResponse, String> {
    let parsed: Value =
        serde_json::from_str(frame).map_err(|_| "The remote MCP frame is invalid.".to_string())?;
    let is_initialize = parsed.get("method").and_then(Value::as_str) == Some("initialize");
    let is_request = parsed.get("id").is_some();
    let client = remote_http_client(&session.endpoint).await?;
    let mut request = client
        .post(session.endpoint.clone())
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .body(frame.to_string());
    if session.initialized {
        request = request.header("MCP-Protocol-Version", "2025-11-25");
    }
    if let Some(server_session_id) = &session.server_session_id {
        request = request.header("MCP-Session-Id", server_session_id);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Remote MCP request failed.".to_string())?;
    if response.status().is_redirection() {
        return Err("Remote MCP redirects are not followed.".into());
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND && session.server_session_id.is_some() {
        return Err("The remote MCP session expired; reconnect the server.".into());
    }
    if response.status() == reqwest::StatusCode::ACCEPTED {
        if is_request {
            return Err("Remote MCP accepted a request without returning a response.".into());
        }
        return Ok(RemotePostResponse {
            frames: Vec::new(),
            server_session_id: None,
            initialized: false,
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "Remote MCP rejected the request with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let server_session_id = if is_initialize {
        response
            .headers()
            .get("MCP-Session-Id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .map(|value| {
                if valid_server_session_id(&value) {
                    Ok(value)
                } else {
                    Err("Remote MCP returned an invalid session id.".to_string())
                }
            })
            .transpose()?
    } else {
        None
    };
    let body = read_remote_body(response, MAX_MCP_FRAME_BYTES).await?;
    let frames = match content_type.as_str() {
        "application/json" => vec![canonical_remote_frame(
            std::str::from_utf8(&body)
                .map_err(|_| "Remote MCP returned non-UTF-8 JSON.".to_string())?,
        )?],
        "text/event-stream" => parse_remote_sse(&body)?,
        _ => return Err("Remote MCP returned an unsupported content type.".into()),
    };
    Ok(RemotePostResponse {
        frames,
        server_session_id,
        initialized: is_initialize,
    })
}

async fn delete_remote_mcp_session(session: &McpRemoteSession) -> Result<(), String> {
    let client = remote_http_client(&session.endpoint).await?;
    let response = client
        .delete(session.endpoint.clone())
        .header("MCP-Protocol-Version", "2025-11-25")
        .header(
            "MCP-Session-Id",
            session.server_session_id.as_deref().unwrap_or_default(),
        )
        .send()
        .await
        .map_err(|_| "Remote MCP session could not be closed.".to_string())?;
    if response.status().is_success()
        || response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED
        || response.status() == reqwest::StatusCode::NOT_FOUND
    {
        Ok(())
    } else {
        Err("Remote MCP session could not be closed.".into())
    }
}

const MCP_AUTH_METADATA_MAX_BYTES: usize = 256 * 1024;

fn protected_resource_metadata_candidates(endpoint: &Url) -> Vec<Url> {
    let mut path_specific = endpoint.clone();
    let endpoint_path = endpoint.path().trim_start_matches('/');
    path_specific.set_path(&format!(
        "/.well-known/oauth-protected-resource{}{}",
        if endpoint_path.is_empty() { "" } else { "/" },
        endpoint_path
    ));
    path_specific.set_query(None);
    let mut root = endpoint.clone();
    root.set_path("/.well-known/oauth-protected-resource");
    root.set_query(None);
    if path_specific == root {
        vec![root]
    } else {
        vec![path_specific, root]
    }
}

fn authorization_metadata_candidates(issuer: &Url) -> Vec<Url> {
    let issuer_path = issuer.path().trim_matches('/');
    let mut oauth = issuer.clone();
    oauth.set_path(&format!(
        "/.well-known/oauth-authorization-server{}{}",
        if issuer_path.is_empty() { "" } else { "/" },
        issuer_path
    ));
    oauth.set_query(None);
    let mut oidc_inserted = issuer.clone();
    oidc_inserted.set_path(&format!(
        "/.well-known/openid-configuration{}{}",
        if issuer_path.is_empty() { "" } else { "/" },
        issuer_path
    ));
    oidc_inserted.set_query(None);
    if issuer_path.is_empty() {
        vec![oauth, oidc_inserted]
    } else {
        let mut oidc_appended = issuer.clone();
        oidc_appended.set_path(&format!(
            "{}/.well-known/openid-configuration",
            issuer.path().trim_end_matches('/')
        ));
        oidc_appended.set_query(None);
        vec![oauth, oidc_inserted, oidc_appended]
    }
}

async fn fetch_remote_metadata(url: &Url) -> Result<Option<Value>, String> {
    let url = validate_remote_endpoint(url.as_str())?;
    let client = remote_http_client(&url).await?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| "Remote MCP authorization metadata request failed.".to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status().is_redirection() || !response.status().is_success() {
        return Err("Remote MCP authorization metadata was unavailable.".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if content_type != "application/json" {
        return Err("Remote MCP authorization metadata was not JSON.".into());
    }
    let bytes = read_remote_body(response, MCP_AUTH_METADATA_MAX_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Remote MCP authorization metadata was malformed.".into())
}

fn parse_protected_resource_metadata(
    endpoint: &Url,
    value: &Value,
) -> Result<(Vec<Url>, Vec<String>), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Remote MCP protected-resource metadata was malformed.".to_string())?;
    let resource = object
        .get("resource")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Remote MCP protected-resource metadata omitted its resource.".to_string()
        })?;
    if validate_remote_endpoint(resource)? != *endpoint {
        return Err("Remote MCP protected-resource metadata named a different resource.".into());
    }
    let servers = object
        .get("authorization_servers")
        .and_then(Value::as_array)
        .filter(|servers| !servers.is_empty() && servers.len() <= 4)
        .ok_or_else(|| {
            "Remote MCP protected-resource metadata omitted its authorization server.".to_string()
        })?
        .iter()
        .map(|value| {
            let raw = value.as_str().ok_or_else(|| {
                "Remote MCP authorization server metadata was malformed.".to_string()
            })?;
            let issuer = validate_remote_endpoint(raw)?;
            if issuer.query().is_some() {
                return Err(
                    "Remote MCP authorization server issuer cannot contain a query.".into(),
                );
            }
            Ok(issuer)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let scopes = object
        .get("scopes_supported")
        .map(|value| {
            let values = value
                .as_array()
                .filter(|values| values.len() <= 64)
                .ok_or_else(|| "Remote MCP authorization scopes were malformed.".to_string())?;
            let mut scopes = values
                .iter()
                .map(|value| {
                    let scope = value.as_str().unwrap_or_default().trim();
                    if scope.is_empty()
                        || scope.chars().count() > 200
                        || scope.chars().any(char::is_whitespace)
                        || scope.chars().any(char::is_control)
                    {
                        return Err("Remote MCP authorization scopes were malformed.".to_string());
                    }
                    Ok(scope.to_string())
                })
                .collect::<Result<Vec<_>, String>>()?;
            scopes.sort();
            scopes.dedup();
            Ok::<Vec<String>, String>(scopes)
        })
        .transpose()?
        .unwrap_or_default();
    Ok((servers, scopes))
}

fn parse_authorization_server_metadata(
    issuer: &Url,
    scopes: Vec<String>,
    value: &Value,
) -> Result<RemoteMcpAuthorizationSummary, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Remote MCP authorization-server metadata was malformed.".to_string())?;
    let metadata_issuer = object
        .get("issuer")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Remote MCP authorization-server metadata omitted its issuer.".to_string()
        })?;
    if validate_remote_endpoint(metadata_issuer)? != *issuer {
        return Err("Remote MCP authorization-server metadata changed issuer.".into());
    }
    for field in ["authorization_endpoint", "token_endpoint"] {
        let endpoint = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            "Remote MCP authorization-server metadata omitted a required endpoint.".to_string()
        })?;
        validate_remote_endpoint(endpoint)?;
    }
    let supports_s256 = object
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|value| value.as_str() == Some("S256")));
    if !supports_s256 {
        return Err("Remote MCP authorization server does not advertise S256 PKCE.".into());
    }
    let supports_code = object
        .get("response_types_supported")
        .and_then(Value::as_array)
        .is_some_and(|types| types.iter().any(|value| value.as_str() == Some("code")));
    let supports_authorization_code = object
        .get("grant_types_supported")
        .map(|value| {
            value.as_array().is_some_and(|types| {
                types
                    .iter()
                    .any(|value| value.as_str() == Some("authorization_code"))
            })
        })
        .unwrap_or(true);
    if !supports_code || !supports_authorization_code {
        return Err(
            "Remote MCP authorization server does not support authorization code flow.".into(),
        );
    }
    let dynamic_registration_supported = object
        .get("registration_endpoint")
        .and_then(Value::as_str)
        .map(validate_remote_endpoint)
        .transpose()?
        .is_some();
    Ok(RemoteMcpAuthorizationSummary {
        issuer: issuer.to_string(),
        scopes,
        pkce_method: "S256".into(),
        client_id_metadata_document_supported: object
            .get("client_id_metadata_document_supported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        dynamic_registration_supported,
    })
}

async fn discover_remote_authorization(
    endpoint: &Url,
) -> Result<RemoteMcpAuthorizationSummary, String> {
    let mut protected = None;
    for candidate in protected_resource_metadata_candidates(endpoint) {
        if let Some(value) = fetch_remote_metadata(&candidate).await? {
            protected = Some(value);
            break;
        }
    }
    let protected = protected.ok_or_else(|| {
        "Remote MCP server did not publish protected-resource metadata.".to_string()
    })?;
    let (servers, scopes) = parse_protected_resource_metadata(endpoint, &protected)?;
    for issuer in servers {
        for candidate in authorization_metadata_candidates(&issuer) {
            if let Some(value) = fetch_remote_metadata(&candidate).await? {
                return parse_authorization_server_metadata(&issuer, scopes.clone(), &value);
            }
        }
    }
    Err("Remote MCP authorization server did not publish compatible metadata.".into())
}

fn validate_configuration_for_approval(
    configuration: &McpServerConfiguration,
) -> Result<(), String> {
    crate::store::repos::scope::normalize_id(&configuration.id, "MCP launch reference")
        .map_err(|error| error.to_string())?;
    if configuration
        .expected_revision
        .is_some_and(|revision| revision < 1)
    {
        return Err("MCP configuration revision is invalid.".to_string());
    }
    crate::store::repos::mcp_local_server::validate_server_values(
        &configuration.display_name,
        &configuration.transport,
        &configuration.command,
        &configuration.args,
        configuration.endpoint.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    if configuration.transport == "stdio" {
        validate_executable(&configuration.command)?;
    } else {
        validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    }
    let lower_args = configuration.args.join(" ").to_ascii_lowercase();
    const SECRET_MARKERS: &[&str] = &[
        "api-key",
        "apikey",
        "authorization",
        "bearer",
        "password",
        "secret",
        "token",
    ];
    if SECRET_MARKERS
        .iter()
        .any(|marker| lower_args.contains(marker))
    {
        return Err(
            "MCP launch arguments cannot contain credentials; use native credential custody."
                .to_string(),
        );
    }
    Ok(())
}

fn configuration_fingerprint(configuration: &McpServerConfiguration) -> Result<String, String> {
    let encoded = serde_json::to_vec(configuration)
        .map_err(|_| "Fable could not fingerprint this MCP configuration.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn approval_for_configuration(
    configuration: &McpServerConfiguration,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    crate::models::ApprovalRequest {
        id,
        service: "MCP connections".to_string(),
        action: format!("configure MCP server {}", configuration.id),
        mode: "full-access".to_string(),
        risk_level: "critical".to_string(),
        data_used: vec![
            format!("server: {}", configuration.display_name.trim()),
            format!("configuration fingerprint: {fingerprint}"),
        ],
        consequence: if configuration.transport == "stdio" {
            "Starts a user-managed local program that can expose tools and resources to Fable."
                .to_string()
        } else {
            "Connects to a user-managed remote service that can expose tools and resources to Fable."
                .to_string()
        },
        requested_at,
        decisions: vec!["once".to_string(), "deny".to_string()],
        confirmation_phrase: Some(format!("configure {}", configuration.id)),
    }
}

fn validate_executable(command: &str) -> Result<PathBuf, String> {
    let path = Path::new(command);
    if !path.is_absolute() {
        return Err("Local MCP executables must use an absolute path.".to_string());
    }
    let canonical = crate::paths::strict_canonicalize(path)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    if !metadata.is_file() || crate::paths::contains_symlink(path) {
        return Err("The local MCP executable must be a regular file without links.".to_string());
    }
    #[cfg(windows)]
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Local MCP executables must be Windows .exe files.".to_string());
    }
    Ok(canonical)
}

fn copy_safe_environment(command: &mut Command) {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ];
    for name in SAFE {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn spawn_mcp_child(executable: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_safe_environment(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command.spawn()
}

fn random_session_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a local MCP session id.".to_string())?;
    Ok(format!("mcp-{}", hex::encode(bytes)))
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("mcp-")
        && value[4..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn valid_mcp_frame(frame: &str) -> bool {
    if frame.is_empty() || frame.len() > MAX_MCP_FRAME_BYTES || frame.contains(['\r', '\n']) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    let valid_id = object
        .get("id")
        .is_none_or(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some());
    if !valid_id {
        return false;
    }
    if let Some(method) = object.get("method") {
        return method.as_str().is_some_and(|value| !value.is_empty())
            && !object.contains_key("result")
            && !object.contains_key("error");
    }
    object.contains_key("id") && (object.contains_key("result") ^ object.contains_key("error"))
}

fn permitted_renderer_frame(frame: &str) -> bool {
    if !valid_mcp_frame(frame) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // This client advertises no server-request capabilities, so renderer
        // responses are never needed and cannot become an execution bypass.
        return false;
    };
    matches!(
        method,
        "initialize"
            | "ping"
            | "tools/list"
            | "resources/list"
            | "resources/templates/list"
            | "notifications/initialized"
            | "notifications/cancelled"
    )
}

#[derive(Default)]
struct BoundedLineDecoder {
    buffer: Vec<u8>,
    dropping: bool,
}

impl BoundedLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if !self.dropping {
                    if self.buffer.last() == Some(&b'\r') {
                        self.buffer.pop();
                    }
                    lines.push(std::mem::take(&mut self.buffer));
                } else {
                    self.buffer.clear();
                }
                self.dropping = false;
            } else if !self.dropping {
                if self.buffer.len() < MAX_MCP_FRAME_BYTES {
                    self.buffer.push(*byte);
                } else {
                    self.buffer.clear();
                    self.dropping = true;
                }
            }
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[test]
    fn frame_validation_accepts_protocol_messages_and_rejects_logs_or_multiline() {
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":"one","method":"initialize","params":{}}"#
        ));
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        assert!(!valid_mcp_frame("server ready"));
        assert!(!valid_mcp_frame(
            "{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n{}"
        ));
        assert!(!valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":null,"result":{}}"#
        ));
    }

    #[test]
    fn renderer_frames_are_control_plane_only() {
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#
        ));
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        for method in [
            "tools/call",
            "resources/read",
            "prompts/get",
            "sampling/createMessage",
        ] {
            assert!(!permitted_renderer_frame(&format!(
                r#"{{"jsonrpc":"2.0","id":"blocked","method":"{method}","params":{{}}}}"#
            )));
        }
        assert!(!permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"server-request","result":{}}"#
        ));
    }

    #[test]
    fn bounded_decoder_reassembles_lines_and_discards_oversized_input() {
        let mut decoder = BoundedLineDecoder::default();
        assert!(decoder.push(b"one").is_empty());
        assert_eq!(
            decoder.push(b"\r\ntwo\n"),
            [b"one".to_vec(), b"two".to_vec()]
        );
        decoder.push(&vec![b'x'; MAX_MCP_FRAME_BYTES + 1]);
        assert!(decoder
            .push(b"discarded\nvalid\n")
            .iter()
            .any(|line| line == b"valid"));
    }

    #[test]
    fn session_ids_are_random_and_strictly_shaped() {
        let first = random_session_id().unwrap();
        let second = random_session_id().unwrap();
        assert!(valid_session_id(&first));
        assert_ne!(first, second);
        assert!(!valid_session_id("mcp-guessable"));
    }

    #[test]
    fn executable_validation_rejects_relative_paths_and_directories() {
        assert!(validate_executable("server.exe").is_err());
        assert!(validate_executable(std::env::temp_dir().to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn configuration_approval_binds_exact_secret_free_input() {
        let command = find_node();
        let configuration = McpServerConfiguration {
            workspace_id: "workspace-a".into(),
            id: "files".into(),
            display_name: "Local files".into(),
            transport: "stdio".into(),
            command: command.to_string_lossy().to_string(),
            args: vec!["--stdio".into(), "C:\\work".into()],
            endpoint: None,
            expected_revision: None,
        };
        validate_configuration_for_approval(&configuration).unwrap();
        let fingerprint = configuration_fingerprint(&configuration).unwrap();
        let approval = approval_for_configuration(
            &configuration,
            &fingerprint,
            "approval-1".into(),
            "2026-07-11T19:00:00Z".into(),
        );
        assert_eq!(approval.decisions, ["once", "deny"]);
        assert!(approval
            .data_used
            .iter()
            .all(|value| !value.contains("C:\\work")));

        let mut changed = configuration.clone();
        changed.args.push("--write".into());
        assert_ne!(
            configuration_fingerprint(&configuration).unwrap(),
            configuration_fingerprint(&changed).unwrap()
        );
        changed.args = vec!["--api-key=secret".into()];
        assert!(validate_configuration_for_approval(&changed).is_err());
    }

    #[test]
    fn remote_endpoint_policy_is_https_public_and_credential_free() {
        assert_eq!(
            validate_remote_endpoint("https://example.com:443/mcp?tenant=a")
                .unwrap()
                .as_str(),
            "https://example.com/mcp?tenant=a"
        );
        for endpoint in [
            "http://example.com/mcp",
            "https://user:pass@example.com/mcp",
            "https://localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://169.254.169.254/mcp",
            "https://example.com:22/mcp",
            "https://example.com/mcp#secret",
            "https://example.com/mcp?access_token=secret",
        ] {
            assert!(validate_remote_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn remote_sse_parser_accepts_only_bounded_json_rpc_data_events() {
        let frames = parse_remote_sse(
            b": keepalive\nid: 1\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"one\",\"result\":{}}\n\n",
        )
        .unwrap();
        assert_eq!(frames.len(), 1);
        assert!(valid_mcp_frame(&frames[0]));
        assert!(parse_remote_sse(b"data: server ready\n\n").is_err());
        assert!(parse_remote_sse(b"event: ping\n\n").is_err());
    }

    #[test]
    fn oauth_metadata_candidates_follow_mcp_discovery_order() {
        let endpoint = validate_remote_endpoint("https://example.com/public/mcp").unwrap();
        assert_eq!(
            protected_resource_metadata_candidates(&endpoint)
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>(),
            [
                "https://example.com/.well-known/oauth-protected-resource/public/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        let issuer = validate_remote_endpoint("https://auth.example.com/tenant").unwrap();
        assert_eq!(
            authorization_metadata_candidates(&issuer)
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>(),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
                "https://auth.example.com/.well-known/openid-configuration/tenant",
                "https://auth.example.com/tenant/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn oauth_metadata_requires_exact_resource_issuer_and_s256() {
        let endpoint = validate_remote_endpoint("https://example.com/mcp").unwrap();
        let protected = serde_json::json!({
            "resource": "https://example.com/mcp",
            "authorization_servers": ["https://auth.example.com/tenant"],
            "scopes_supported": ["files:write", "files:read", "files:read"]
        });
        let (servers, scopes) = parse_protected_resource_metadata(&endpoint, &protected).unwrap();
        assert_eq!(scopes, ["files:read", "files:write"]);
        let metadata = serde_json::json!({
            "issuer": "https://auth.example.com/tenant",
            "authorization_endpoint": "https://auth.example.com/authorize",
            "token_endpoint": "https://auth.example.com/token",
            "code_challenge_methods_supported": ["S256"],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "client_id_metadata_document_supported": true
        });
        let summary = parse_authorization_server_metadata(&servers[0], scopes, &metadata).unwrap();
        assert_eq!(summary.pkce_method, "S256");
        assert!(summary.client_id_metadata_document_supported);
        let mut wrong_resource = protected.clone();
        wrong_resource["resource"] = Value::String("https://other.example.com/mcp".into());
        assert!(parse_protected_resource_metadata(&endpoint, &wrong_resource).is_err());
        let mut no_pkce = metadata;
        no_pkce["code_challenge_methods_supported"] = serde_json::json!(["plain"]);
        assert!(parse_authorization_server_metadata(&servers[0], vec![], &no_pkce).is_err());
    }

    fn find_node() -> PathBuf {
        let executable = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .map(|directory| directory.join(executable))
            .find(|candidate| candidate.is_file())
            .expect("the workspace requires Node.js on PATH")
    }

    #[tokio::test]
    async fn real_stdio_child_initializes_discovers_calls_and_closes() {
        let node = validate_executable(find_node().to_string_lossy().as_ref()).unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-stdio-server.mjs");
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut child =
            spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], &cwd).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();

        for request in [
            r#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Fable","version":"0.1.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}}}"#,
        ] {
            stdin.write_all(request.as_bytes()).await.unwrap();
            stdin.write_all(b"\n").await.unwrap();
            stdin.flush().await.unwrap();
            let response = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(valid_mcp_frame(&response));
            let value: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(value.get("error"), None);
        }
        drop(stdin);
        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn tool_approval_is_fingerprint_only_and_arguments_reject_credentials() {
        let proposal = McpToolProposal {
            workspace_id: "workspace-a".into(),
            session_id: "mcp-1234567890abcdef1234567890abcdef".into(),
            tool_name: "read".into(),
            arguments: serde_json::json!({ "path": "safe.txt" }),
        };
        validate_mcp_tool_name(&proposal.tool_name).unwrap();
        validate_mcp_arguments(&proposal.arguments).unwrap();
        let approval = approval_for_tool_proposal(
            &proposal,
            "fingerprint-only",
            "approval-1".into(),
            "2026-07-11T20:00:00Z".into(),
        );
        let encoded = serde_json::to_string(&approval).unwrap();
        assert!(encoded.contains("fingerprint-only"));
        assert!(!encoded.contains("safe.txt"));
        assert!(validate_mcp_arguments(&serde_json::json!({ "apiKey": "secret" })).is_err());
        assert!(validate_mcp_arguments(&serde_json::json!(["not-an-object"])).is_err());
    }

    #[test]
    fn correlated_response_consumes_pending_audit_without_result_content() {
        let session = "mcp-1234567890abcdef1234567890abcdef";
        let request = "native-mcp-tool-1";
        pending_audits().lock().unwrap().insert(
            pending_audit_key(session, request),
            PendingMcpAudit {
                tool_name: "read".into(),
                connection_id: "connection-mcp".into(),
                actor: "user-a".into(),
            },
        );
        audit_mcp_response(
            session,
            r#"{"jsonrpc":"2.0","id":"native-mcp-tool-1","result":{"content":[{"type":"text","text":"private"}]}}"#,
        );
        assert!(pending_audits()
            .lock()
            .unwrap()
            .get(&pending_audit_key(session, request))
            .is_none());
    }
}
