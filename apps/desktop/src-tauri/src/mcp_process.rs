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

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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
const MCP_EVENT_CHANNEL_PREFIX: &str = "mivlet://mcp/";
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

struct McpChild {
    child: Child,
    stdin: Option<mpsc::Sender<String>>,
    workspace_id: String,
    owner_subject: String,
    connection_id: String,
    connection_revision: i64,
    initialized: bool,
    discovery_current: bool,
}

type ProcessMap = HashMap<String, McpChild>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiscoveryKind {
    Tools,
    Resources,
}

#[derive(Default)]
struct DiscoveryCollection {
    values: Vec<String>,
    expected_cursor: Option<String>,
    complete: bool,
}

#[derive(Default)]
struct DiscoveryProof {
    initializing: Option<String>,
    pending: HashMap<String, DiscoveryKind>,
    tools: DiscoveryCollection,
    resources: DiscoveryCollection,
}

fn process_map() -> &'static Mutex<ProcessMap> {
    static MAP: OnceLock<Mutex<ProcessMap>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn discovery_proofs() -> &'static Mutex<HashMap<String, DiscoveryProof>> {
    static PROOFS: OnceLock<Mutex<HashMap<String, DiscoveryProof>>> = OnceLock::new();
    PROOFS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct McpRemoteSession {
    endpoint: Url,
    configuration_reference: String,
    workspace_id: String,
    owner_subject: String,
    connection_id: String,
    connection_revision: i64,
    oauth_credential_key: Option<String>,
    discovery_current: bool,
    server_session_id: Option<String>,
    last_event_id: Option<String>,
    retry_after_ms: u64,
    initialized: bool,
    busy: bool,
    poll_busy: bool,
}

#[derive(Clone)]
struct RemoteAuthorizationChallenge {
    resource_metadata: Url,
    scopes: Vec<String>,
    observed_endpoint: Option<Url>,
    connection_revision: Option<i64>,
}

fn authorization_challenges() -> &'static Mutex<HashMap<String, RemoteAuthorizationChallenge>> {
    static MAP: OnceLock<Mutex<HashMap<String, RemoteAuthorizationChallenge>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn authorization_challenge_key(
    workspace_id: &str,
    owner_subject: &str,
    configuration_reference: &str,
) -> String {
    format!("{workspace_id}\0{owner_subject}\0{configuration_reference}")
}

const MCP_OAUTH_KEYRING_SERVICE: &str = "com.fable.mcp.oauth";

fn mcp_oauth_credential_key(
    workspace_id: &str,
    owner_subject: &str,
    configuration_reference: &str,
) -> String {
    let encoded = format!("{workspace_id}\0{owner_subject}\0{configuration_reference}");
    format!("mcp-oauth-{:x}", Sha256::digest(encoded.as_bytes()))
}

fn mcp_oauth_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        MCP_OAUTH_KEYRING_SERVICE,
        &crate::account_session::credential_key(key)?,
    )
    .map_err(|_| "Mivlet could not access MCP OAuth credentials.".to_string())
}

fn store_mcp_oauth_tokens(key: &str, tokens: &RemoteMcpOAuthTokens) -> Result<(), String> {
    let encoded = serde_json::to_string(tokens)
        .map_err(|_| "Mivlet could not encode MCP OAuth credentials.".to_string())?;
    mcp_oauth_entry(key)?
        .set_password(&encoded)
        .map_err(|_| "Mivlet could not store MCP OAuth credentials.".to_string())
}

fn load_mcp_oauth_tokens(key: &str) -> Result<Option<RemoteMcpOAuthTokens>, String> {
    let encoded = match mcp_oauth_entry(key)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err("Mivlet could not read MCP OAuth credentials.".into()),
    };
    serde_json::from_str(&encoded)
        .map(Some)
        .map_err(|_| "Stored MCP OAuth credentials are invalid; reconnect this server.".into())
}

fn remove_mcp_oauth_tokens(key: &str) -> Result<(), String> {
    match mcp_oauth_entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Mivlet could not remove MCP OAuth credentials.".into()),
    }
}

fn remote_sessions() -> &'static Mutex<HashMap<String, McpRemoteSession>> {
    static MAP: OnceLock<Mutex<HashMap<String, McpRemoteSession>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn oauth_refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn oauth_authorization_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpPollResult {
    supported: bool,
    frames: Vec<String>,
    retry_after_ms: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRemoteMcpAuthorizationRequest {
    workspace_id: String,
    configuration_reference: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginRemoteMcpAuthorizationRequest {
    workspace_id: String,
    configuration_reference: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRemoteMcpAuthorizationRequest {
    workspace_id: String,
    configuration_reference: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpAuthorizationResult {
    status: &'static str,
    issuer: String,
    scopes: Vec<String>,
    client_registration_strategy: String,
    message: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpDisconnectionResult {
    status: &'static str,
    message: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpAuthorizationSummary {
    issuer: String,
    scopes: Vec<String>,
    pkce_method: String,
    client_id_metadata_document_supported: bool,
    dynamic_registration_supported: bool,
    client_registration_strategy: String,
    client_registration_status: String,
    client_registration_reason: String,
}

struct RemoteMcpAuthorizationDiscovery {
    summary: RemoteMcpAuthorizationSummary,
    resource: Option<String>,
    authorization_endpoint: Url,
    token_endpoint: Url,
    registration_endpoint: Option<Url>,
    revocation_endpoint: Option<Url>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct RemoteMcpOAuthTokens {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    expires_at: i64,
    scopes: Vec<String>,
    token_endpoint: String,
    client_id: String,
    resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transport_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revocation_endpoint: Option<String>,
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
    #[serde(default)]
    capability_bindings: Vec<crate::store::repos::connection_record::McpCapabilityBindingWrite>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveMcpCapabilityRouteRequest {
    workspace_id: String,
    capability_id: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMcpCapabilityRoute {
    configuration_reference: String,
    transport: String,
    connection_id: String,
    connection_revision: i64,
    capability_id: String,
    tool_name: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolProposal {
    workspace_id: String,
    session_id: String,
    tool_name: String,
    arguments: Value,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpSemanticContinuation {
    kind: &'static str,
    proposal: McpToolProposal,
    permit_id: String,
    workspace_id: String,
    query: String,
    connection_id: String,
    matched_grant_ids: Vec<String>,
    degraded: bool,
    degradation_reasons: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMcpToolCall {
    proposal_fingerprint: String,
    requires_approval: bool,
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

include!("mcp_process/configuration.rs");
include!("mcp_process/discovery.rs");
include!("mcp_process/remote_transport.rs");
include!("mcp_process/tests.rs");
