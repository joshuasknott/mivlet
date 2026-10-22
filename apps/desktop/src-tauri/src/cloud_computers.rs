//! Native boundary for an optional user-owned Instabox computer.
//!
//! The renderer receives only account/machine metadata. The API key and any
//! bearer material remain in the OS keyring and are consumed by this module.
//! This module deliberately implements lifecycle and selection only. Remote
//! process, file, and desktop capabilities stay closed until a supported
//! per-agent isolation contract exists.

use crate::{
    account_session::AccountDispatchFence,
    authorized_scope::{self, ScopeAccess},
    local_computer::LocalComputerState,
    protected_secrets::{prompt_checked, Custody, Failure, NativeCustody, RequestInput},
    store::{self, repos::scope::PrivateDataScope},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

pub(crate) mod viewer;

const API_BASE: &str = "https://api.instabox.sh";
const KEY_ID: &str = "instabox-api-key";
const DOC: &str = "instabox-computer.json";
const MAX_PENDING: usize = 16;
const MAX_MACHINES: usize = 100;
const IDEMPOTENCY_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const DESKTOP_START_WIDTH: u64 = 1280;
const DESKTOP_START_HEIGHT: u64 = 800;
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

mod create;
mod metadata;
mod status;
mod transport;
use create::*;
use metadata::*;
use status::{fetch_machines, status_inner};
pub(super) use transport::{api_request, client, endpoint, map_status};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentComputerPreference {
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "instabox")]
    Instabox {
        machine_id: String,
        connection_revision: u64,
    },
}

pub(crate) fn validate_agent_computer_preference(
    preference: &AgentComputerPreference,
) -> Result<(), String> {
    match preference {
        AgentComputerPreference::Local => Ok(()),
        AgentComputerPreference::Instabox {
            machine_id,
            connection_revision,
        } if valid_id(machine_id) && *connection_revision > 0 => Ok(()),
        AgentComputerPreference::Instabox { .. } => {
            Err("The selected Instabox computer identity or connection revision is invalid.".into())
        }
    }
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Secure operation id generation is unavailable.".to_string())?;
    Ok(hex::encode(bytes))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerStatus {
    pub connected: bool,
    pub provider: &'static str,
    pub selected_machine_id: Option<String>,
    pub connection_revision: u64,
    pub machine: Option<MachineSummary>,
    pub machines: Vec<MachineSummary>,
    pub usage: Option<UsageSummary>,
    pub pending_action: Option<String>,
    pub capabilities: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerStatusRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub template_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSummary {
    pub machine_count: Option<u64>,
    pub machine_limit: Option<u64>,
    pub snapshot_count: Option<u64>,
    pub snapshot_limit: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedConnection {
    #[serde(default)]
    connection_revision: u64,
    #[serde(default)]
    account_user_id: Option<i64>,
    selected_machine_id: Option<String>,
    selected_machine_name: Option<String>,
    selected_machine_status: Option<String>,
    pending: Vec<PendingOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingOperation {
    idempotency_key: String,
    action: String,
    machine_id: String,
    operation_id: Option<String>,
    path: String,
    body: Value,
    #[serde(default)]
    created_at_ms: i64,
    /// Older pending creates did not include desktop startup approval. Keep
    /// those recoverable without silently adding this new remote mutation.
    #[serde(default)]
    desktop_start_approved: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerConnectRequest {
    pub workspace_id: String,
    pub agent_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerSelectRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerCreateRequest {
    pub workspace_id: String,
    pub name: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerMachineRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerReconcileRequest {
    pub workspace_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudComputerDisconnectRequest {
    pub workspace_id: String,
    pub expected_revision: u64,
}

fn doc_path() -> &'static Path {
    Path::new(DOC)
}

fn scope() -> Result<PrivateDataScope, String> {
    Ok(authorized_scope::active_command_scope(ScopeAccess::Write)?.private)
}

fn scope_for(workspace_id: &str) -> Result<PrivateDataScope, String> {
    let scope = scope()?;
    if scope.workspace_id() != workspace_id {
        return Err("The active Instabox workspace changed. Refresh and try again.".into());
    }
    Ok(scope)
}

fn read_saved(scope: &PrivateDataScope) -> Result<SavedConnection, String> {
    store::read_private_workspace_document(doc_path(), scope).map(|v| v.unwrap_or_default())
}

fn write_saved(scope: &PrivateDataScope, value: &SavedConnection) -> Result<(), String> {
    if store::write_private_workspace_document(doc_path(), scope, value)? {
        Ok(())
    } else {
        Err("Mivlet's encrypted store is not initialized.".into())
    }
}

fn update_saved(
    scope: &PrivateDataScope,
    expected_revision: Option<u64>,
    update: impl FnOnce(&mut SavedConnection) -> Result<(), String>,
) -> Result<SavedConnection, String> {
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| "Instabox connection state is unavailable.".to_string())?;
    let mut saved = read_saved(scope)?;
    if expected_revision.is_some_and(|expected| expected != saved.connection_revision) {
        return Err("Instabox connection changed. Refresh before continuing.".into());
    }
    update(&mut saved)?;
    if saved.pending.len() > MAX_PENDING {
        return Err("Too many unresolved Instabox operations. Reconcile before continuing.".into());
    }
    saved.connection_revision = saved.connection_revision.saturating_add(1);
    write_saved(scope, &saved)?;
    Ok(saved)
}

fn check_revision(scope: &PrivateDataScope, expected: u64) -> Result<SavedConnection, String> {
    let saved = read_saved(scope)?;
    if expected != saved.connection_revision {
        return Err("Instabox connection changed. Refresh before continuing.".into());
    }
    Ok(saved)
}

fn key_name() -> Result<String, String> {
    crate::account_session::credential_key(KEY_ID)
}

fn native_key(credential_name: &str) -> Result<Option<crate::protected_secrets::Secret>, String> {
    let key = NativeCustody::get(&NativeCustody, credential_name, KEY_ID)
        .map_err(|_| "Instabox credential storage is unavailable.".to_string())?;
    Ok(key)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn replay_is_within_idempotency_window(created_at_ms: i64, now: i64) -> bool {
    created_at_ms > 0 && now >= created_at_ms && now - created_at_ms <= IDEMPOTENCY_TTL_MS
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Instabox actions are available only in Mivlet's main window.".into())
}

#[tauri::command]
pub async fn cloud_computer_status(
    window: tauri::WebviewWindow,
    request: CloudComputerStatusRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let status = status_inner(&request.workspace_id, &fence).await?;
    fence.with_current(|| Ok(()))?;
    Ok(status)
}

#[tauri::command]
pub async fn cloud_computer_connect(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    request: CloudComputerConnectRequest,
) -> Result<Option<CloudComputerStatus>, String> {
    if request.workspace_id.trim().is_empty() || request.agent_id.trim().is_empty() {
        return Err("Instabox connection must be started from the main workspace.".into());
    }
    require_main(&window)?;
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let authority = state.authority_for(&request.workspace_id, &request.agent_id)?;
    let generation = authority.snapshot()?.generation;
    let ticket = authority.begin_viewer(generation)?;
    let entry_id = format!("instabox-key-{}", chrono::Utc::now().timestamp_millis());
    let input = RequestInput {
        label: "Connect your Instabox account".into(),
        reason: "Mivlet sends this key only to api.instabox.sh and keeps it in native secure storage. It does not create a computer while checking the key.".into(),
        purpose: "connect-instabox-account".into(),
        consumer: "instabox-computer-connection".into(),
        target_id: entry_id.clone(),
    };
    let computers = state.inner().clone();
    let workspace = request.workspace_id.clone();
    let agent = request.agent_id.clone();
    let (secret, fence, ticket) = tauri::async_runtime::spawn_blocking(move || {
        let secret =
            computers.with_protected_input(&workspace, &agent, generation, &entry_id, || {
                prompt_checked(&input, &|| {
                    ticket.check().map_err(|_| Failure::Stopped)?;
                    fence.poll_current().map_err(|_| Failure::Stopped)
                })
                .map_err(|error| error.to_string())
            })?;
        Ok::<_, String>((secret, fence, ticket))
    })
    .await
    .map_err(|_| "Protected Instabox key entry stopped unexpectedly.".to_string())??;
    // Decline, Escape and close leave the connection untouched. Do not check
    // the provider or replace an existing key after deliberate cancellation.
    let Some(secret) = secret else {
        return Ok(None);
    };
    fence.with_current(|| Ok(()))?;
    ticket.check()?;
    drop(ticket);
    if secret.len() < 16 || secret.len() > 512 {
        return Err("Use a valid Instabox API key.".into());
    }
    let _ = check_revision(&scope, request.expected_revision)?;
    let me = api_request(reqwest::Method::GET, "/v1/me", secret.as_str(), None, None).await;
    fence.with_current(|| Ok(()))?;
    let me = me?;
    let usage_result = api_request(
        reqwest::Method::GET,
        "/v1/usage",
        secret.as_str(),
        None,
        None,
    )
    .await;
    fence.with_current(|| Ok(()))?;
    let _usage = usage_result?;
    let machines_result = api_request(
        reqwest::Method::GET,
        "/v1/machines?limit=100",
        secret.as_str(),
        None,
        None,
    )
    .await;
    fence.with_current(|| Ok(()))?;
    let machines = machines_result?;
    let account_user_id = me
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Instabox did not return an account identity.".to_string())?;
    let _ = machines;
    let current = read_saved(&scope)?;
    let account_changed = current
        .account_user_id
        .is_some_and(|existing| existing != account_user_id);
    if account_changed && !current.pending.is_empty() {
        return Err(
            "This API key belongs to a different Instabox account. Reconcile or disconnect first."
                .into(),
        );
    }
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    fence.with_current(|| Ok(()))?;
    update_saved(&scope, Some(request.expected_revision), |saved| {
        NativeCustody::put(&NativeCustody, &credential_name, KEY_ID, secret.as_str())
            .map_err(|_| "Instabox credential storage is unavailable.".to_string())?;
        if account_changed {
            saved.selected_machine_id = None;
            saved.selected_machine_name = None;
            saved.selected_machine_status = None;
        }
        saved.account_user_id = Some(account_user_id);
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    drop(secret);
    status_inner(&request.workspace_id, &fence).await.map(Some)
}

#[tauri::command]
pub async fn cloud_computer_select(
    window: tauri::WebviewWindow,
    request: CloudComputerSelectRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    if !valid_id(&request.machine_id) {
        return Err("Choose a valid Instabox computer.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let Some(key) = native_key(&credential_name)? else {
        return Err("Connect Instabox before choosing a computer.".into());
    };
    let _saved = check_revision(&scope, request.expected_revision)?;
    let listed_result = fetch_machines(key.as_str()).await;
    fence.with_current(|| Ok(()))?;
    let listed = listed_result?;
    if !listed.iter().any(|m| m.id == request.machine_id) {
        return Err("That Instabox computer is not available to this account.".into());
    }
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    fence.with_current(|| Ok(()))?;
    update_saved(&scope, Some(request.expected_revision), |saved| {
        saved.selected_machine_id = Some(request.machine_id.clone());
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    status_inner(&request.workspace_id, &fence).await
}

#[tauri::command]
pub async fn cloud_computer_create(
    window: tauri::WebviewWindow,
    request: CloudComputerCreateRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let name = request.name.trim();
    if name.is_empty() || name.len() > 80 || name.chars().any(|c| c.is_control()) {
        return Err("Choose a computer name between 1 and 80 characters.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let Some(key) = native_key(&credential_name)? else {
        return Err("Connect Instabox before creating a computer.".into());
    };
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    fence.with_current(|| check_revision(&scope, request.expected_revision).map(|_| ()))?;
    let me_result = api_request(reqwest::Method::GET, "/v1/me", key.as_str(), None, None).await;
    fence.with_current(|| Ok(()))?;
    let me = me_result?;
    let usage_result =
        api_request(reqwest::Method::GET, "/v1/usage", key.as_str(), None, None).await;
    fence.with_current(|| Ok(()))?;
    let usage_value = usage_result?;
    fence.with_current(|| Ok(()))?;
    let account_user_id = me
        .get("userId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Instabox did not return an account identity.".to_string())?;
    if read_saved(&scope)?.account_user_id != Some(account_user_id) {
        return Err(
            "This API key belongs to a different Instabox account. Reconnect first.".into(),
        );
    }
    if me
        .get("allowedSpecs")
        .or_else(|| me.get("allowed_specs"))
        .and_then(Value::as_array)
        .is_some_and(|specs| specs.is_empty())
    {
        return Err("This Instabox account has no computer specifications available.".into());
    }
    let current_usage = usage(&usage_value);
    if current_usage
        .machine_count
        .zip(current_usage.machine_limit)
        .is_some_and(|(count, limit)| count >= limit)
    {
        return Err("This Instabox account has reached its computer limit.".into());
    }
    let idem = format!("mivlet-create-{}", random_id()?);
    let body = json!({"name": name, "templateId": "agent-browser", "vault": false, "secrets": [], "envSecrets": []});
    fence.with_current(|| Ok(()))?;
    let pending_saved = update_saved(&scope, Some(request.expected_revision), |saved| {
        if !saved.pending.is_empty() {
            return Err(
                "Finish checking the pending Instabox operation before creating another computer."
                    .into(),
            );
        }
        if saved.pending.len() >= MAX_PENDING {
            return Err("An Instabox operation is already pending.".into());
        }
        saved.pending.push(PendingOperation {
            idempotency_key: idem.clone(),
            action: "create".into(),
            machine_id: "pending".into(),
            operation_id: None,
            path: "/v1/machines".into(),
            body: body.clone(),
            created_at_ms: now_ms(),
            desktop_start_approved: true,
        });
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    let result = api_request(
        reqwest::Method::POST,
        "/v1/machines",
        key.as_str(),
        Some(body),
        Some(&idem),
    )
    .await;
    fence.with_current(|| Ok(()))?;
    fence.with_current(|| check_revision(&scope, pending_saved.connection_revision).map(|_| ()))?;
    match result {
        Ok(value) => {
            let operation_id = pick_string(&value, &["operationId", "operation_id", "id"]);
            let response_machine_id = operation_machine_id(&value);
            let pending_revision =
                update_saved(&scope, Some(pending_saved.connection_revision), |saved| {
                    if let Some(p) = saved.pending.iter_mut().find(|p| p.idempotency_key == idem) {
                        if let Some(machine_id) = response_machine_id.as_deref() {
                            if is_real_machine_id(machine_id) {
                                p.machine_id = machine_id.to_string();
                            }
                        }
                        p.operation_id = operation_id.clone();
                    }
                    Ok(())
                })?;
            fence.with_current(|| Ok(()))?;
            let Some(operation_id) = operation_id else {
                return Err("Instabox did not return a create operation identity. Check the operation result before retrying.".into());
            };
            let operation = wait_for_operation(key.as_str(), &operation_id, &fence).await?;
            let state = operation_state(&operation);
            if state != "succeeded" {
                if state == "failed" {
                    update_saved(
                        &scope,
                        Some(pending_revision.connection_revision),
                        |saved| {
                            saved
                                .pending
                                .retain(|pending| pending.idempotency_key != idem);
                            Ok(())
                        },
                    )?;
                    return Err("Instabox could not create the computer. Check Instabox for details and try again.".into());
                }
                return status_inner(&request.workspace_id, &fence).await;
            }
            let pending = pending_revision
                .pending
                .iter()
                .find(|pending| pending.idempotency_key == idem)
                .ok_or_else(|| {
                    "The Instabox create operation changed while it was running. Refresh and retry."
                        .to_string()
                })?;
            let machine_id = create_machine_id(&value, &operation, pending)?;
            let queued = update_saved(
                &scope,
                Some(pending_revision.connection_revision),
                |saved| {
                    let found = saved
                        .pending
                        .iter()
                        .any(|pending| pending.idempotency_key == idem);
                    if !found {
                        return Err("The Instabox create operation changed while it was running. Refresh and retry.".into());
                    }
                    saved
                        .pending
                        .retain(|pending| pending.idempotency_key != idem);
                    saved.selected_machine_id = Some(machine_id.clone());
                    queue_desktop_start(saved, &machine_id)
                },
            )?;
            fence.with_current(|| Ok(()))?;
            let latest =
                fence.with_current(|| check_revision(&scope, queued.connection_revision))?;
            if latest.selected_machine_id.as_deref() != Some(machine_id.as_str()) {
                return Err("The selected Instabox computer changed while creation was finishing. Refresh and retry.".into());
            }
            if let Err(error) = start_desktop(key.as_str(), &machine_id, &fence).await {
                let mut status = status_inner(&request.workspace_id, &fence).await?;
                status.error = Some(error);
                return Ok(status);
            }
            update_saved(&scope, Some(queued.connection_revision), |saved| {
                saved.pending.retain(|pending| {
                    !(pending.action == "desktop-start" && pending.machine_id == machine_id)
                });
                Ok(())
            })?;
            fence.with_current(|| Ok(()))?;
            status_inner(&request.workspace_id, &fence).await
        }
        Err(error) => Err(error),
    }
}

async fn lifecycle(
    action: &str,
    request: CloudComputerMachineRequest,
) -> Result<CloudComputerStatus, String> {
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let Some(key) = native_key(&credential_name)? else {
        return Err("Connect Instabox before changing a computer.".into());
    };
    if !valid_id(&request.machine_id) {
        return Err("That Instabox computer id is invalid.".into());
    }
    let saved = check_revision(&scope, request.expected_revision)?;
    if saved.selected_machine_id.as_deref() != Some(request.machine_id.as_str()) {
        return Err("Select this exact Instabox computer before changing its state.".into());
    }
    let idem = format!("mivlet-{action}-{}", random_id()?);
    let remote_action = if action == "resume" {
        let listed = fetch_machines(key.as_str()).await;
        fence.with_current(|| Ok(()))?;
        let machine = listed?
            .into_iter()
            .find(|machine| machine.id == request.machine_id)
            .ok_or_else(|| "That Instabox computer is no longer available.".to_string())?;
        if machine.status.eq_ignore_ascii_case("stopped") {
            "start"
        } else {
            "resume"
        }
    } else {
        action
    };
    let path = format!("/v1/machines/{}/{}", request.machine_id, remote_action);
    let body = json!({});
    fence.with_current(|| Ok(()))?;
    update_saved(&scope, Some(request.expected_revision), |saved| {
        if saved
            .pending
            .iter()
            .any(|p| p.machine_id == request.machine_id)
        {
            return Err("An Instabox operation is already pending for this computer.".into());
        }
        saved.pending.push(PendingOperation {
            idempotency_key: idem.clone(),
            action: action.into(),
            machine_id: request.machine_id.clone(),
            operation_id: None,
            path: path.clone(),
            body: body.clone(),
            created_at_ms: now_ms(),
            desktop_start_approved: false,
        });
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    let result = api_request(
        reqwest::Method::POST,
        &path,
        key.as_str(),
        Some(body),
        Some(&idem),
    )
    .await;
    fence.with_current(|| Ok(()))?;
    match result {
        Ok(value) => {
            let operation_id = pick_string(&value, &["operationId", "operation_id", "id"]);
            update_saved(&scope, None, |saved| {
                if let Some(p) = saved.pending.iter_mut().find(|p| p.idempotency_key == idem) {
                    p.operation_id = operation_id;
                }
                Ok(())
            })?;
            fence.with_current(|| Ok(()))?;
            status_inner(&request.workspace_id, &fence).await
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn cloud_computer_pause(
    window: tauri::WebviewWindow,
    request: CloudComputerMachineRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() || !valid_id(&request.machine_id) {
        return Err("Choose a valid selected Instabox computer before pausing it.".into());
    }
    let saved = check_revision(
        &scope_for(&request.workspace_id)?,
        request.expected_revision,
    )?;
    if saved.selected_machine_id.as_deref() != Some(request.machine_id.as_str()) {
        return Err("Select this exact Instabox computer before pausing it.".into());
    }
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    lifecycle("suspend", request).await
}

#[tauri::command]
pub async fn cloud_computer_resume(
    window: tauri::WebviewWindow,
    request: CloudComputerMachineRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    let saved = check_revision(
        &scope_for(&request.workspace_id)?,
        request.expected_revision,
    )?;
    if saved.selected_machine_id.as_deref() != Some(request.machine_id.as_str()) {
        return Err("Select this exact Instabox computer before resuming it.".into());
    }
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    lifecycle("resume", request).await
}

#[tauri::command]
pub async fn cloud_computer_disconnect(
    window: tauri::WebviewWindow,
    request: CloudComputerDisconnectRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let _saved = check_revision(&scope, request.expected_revision)?;
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    fence.with_current(|| Ok(()))?;
    let saved = update_saved(&scope, Some(request.expected_revision), |_| {
        NativeCustody::remove(&NativeCustody, &credential_name, KEY_ID)
            .map_err(|_| "Instabox credential storage is unavailable.".to_string())?;
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    Ok(CloudComputerStatus {
        provider: "instabox",
        connection_revision: saved.connection_revision,
        selected_machine_id: saved.selected_machine_id,
        pending_action: saved.pending.first().map(|pending| pending.action.clone()),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn cloud_computer_reconcile(
    window: tauri::WebviewWindow,
    request: CloudComputerReconcileRequest,
) -> Result<CloudComputerStatus, String> {
    require_main(&window)?;
    if request.workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let fence = AccountDispatchFence::capture()?;
    let scope = scope_for(&request.workspace_id)?;
    let credential_name = key_name()?;
    let saved = check_revision(&scope, request.expected_revision)?;
    let Some(key) = native_key(&credential_name)? else {
        return Ok(CloudComputerStatus {
            provider: "instabox",
            connection_revision: saved.connection_revision,
            selected_machine_id: saved.selected_machine_id,
            pending_action: saved.pending.first().map(|pending| pending.action.clone()),
            ..Default::default()
        });
    };
    let _viewer_guard = viewer::close_for_lifecycle(&window).await?;
    fence.with_current(|| check_revision(&scope, request.expected_revision).map(|_| ()))?;
    let mut keep = Vec::new();
    let mut expired_replay = false;
    let mut terminal_failure = false;
    let mut created_machine: Option<String> = None;
    let mut created_desktop_approved = false;
    let mut desktop_retry_machine: Option<String> = None;
    for mut pending in saved.pending {
        if pending.action == "desktop-start" {
            if desktop_retry_machine.is_none() {
                desktop_retry_machine = Some(pending.machine_id.clone());
            }
            keep.push(pending);
            continue;
        }
        if let Some(operation_id) = pending.operation_id.as_deref() {
            if !valid_id(operation_id) {
                keep.push(pending);
                continue;
            }
            let result = wait_for_operation(key.as_str(), operation_id, &fence).await;
            match result {
                Ok(value) => {
                    let state = operation_state(&value);
                    if state == "failed" {
                        terminal_failure = true;
                    } else if state == "succeeded" && pending.action == "create" {
                        match create_machine_id(&Value::Null, &value, &pending) {
                            Ok(machine_id) => {
                                if created_machine.is_some() {
                                    keep.push(pending);
                                } else {
                                    created_desktop_approved = pending.desktop_start_approved;
                                    created_machine = Some(machine_id);
                                }
                            }
                            Err(_) => {
                                terminal_failure = true;
                                keep.push(pending);
                            }
                        }
                    } else if state != "succeeded" {
                        keep.push(pending);
                    }
                }
                Err(_) => keep.push(pending),
            }
        } else {
            // Replaying the exact body with the same idempotency key is the
            // only permitted recovery for an accepted request whose response
            // was lost. Instabox guarantees key reuse returns the prior result.
            if !replay_is_within_idempotency_window(pending.created_at_ms, now_ms()) {
                expired_replay = true;
                keep.push(pending);
                continue;
            }
            fence.with_current(|| check_revision(&scope, request.expected_revision).map(|_| ()))?;
            let result = api_request(
                reqwest::Method::POST,
                &pending.path,
                key.as_str(),
                Some(pending.body.clone()),
                Some(&pending.idempotency_key),
            )
            .await;
            fence.with_current(|| Ok(()))?;
            match result {
                Ok(value) => {
                    fence.with_current(|| Ok(()))?;
                    pending.operation_id =
                        pick_string(&value, &["operationId", "operation_id", "id"]);
                    if pending.action == "create" {
                        if let Some(machine_id) = operation_machine_id(&value) {
                            if is_real_machine_id(&machine_id) {
                                pending.machine_id = machine_id;
                            }
                        }
                    }
                    keep.push(pending);
                }
                Err(_) => keep.push(pending),
            }
        }
    }
    fence.with_current(|| Ok(()))?;
    let queued = update_saved(&scope, Some(request.expected_revision), |saved| {
        saved.pending = keep;
        if let Some(machine_id) = created_machine.as_deref() {
            saved.selected_machine_id = Some(machine_id.to_string());
            if created_desktop_approved {
                queue_desktop_start(saved, machine_id)?;
            }
        }
        Ok(())
    })?;
    fence.with_current(|| Ok(()))?;
    let created_without_desktop = created_machine.is_some() && !created_desktop_approved;
    let desktop_machine = created_machine.or(desktop_retry_machine);
    if let Some(machine_id) = desktop_machine {
        if created_without_desktop {
            let mut status = status_inner(&request.workspace_id, &fence).await?;
            status.error = Some(
                "The computer was created and selected. Start its desktop in Instabox before opening it.".into(),
            );
            return Ok(status);
        }
        let latest = fence.with_current(|| check_revision(&scope, queued.connection_revision))?;
        if latest.selected_machine_id.as_deref() != Some(machine_id.as_str()) {
            return Err("The selected Instabox computer changed while reconciliation was finishing. Refresh and retry.".into());
        }
        if let Err(error) = start_desktop(key.as_str(), &machine_id, &fence).await {
            let mut status = status_inner(&request.workspace_id, &fence).await?;
            status.error = Some(error);
            return Ok(status);
        }
        update_saved(&scope, Some(queued.connection_revision), |saved| {
            saved.pending.retain(|pending| {
                !(pending.action == "desktop-start" && pending.machine_id == machine_id)
            });
            Ok(())
        })?;
        fence.with_current(|| Ok(()))?;
    }
    let mut status = status_inner(&request.workspace_id, &fence).await?;
    if expired_replay {
        status.error = Some(
            "An Instabox operation is older than seven days and needs manual recovery in Instabox."
                .into(),
        );
    } else if terminal_failure {
        status.error = Some(
            "An Instabox computer operation failed. Check Instabox for details and try again."
                .into(),
        );
    }
    Ok(status)
}

#[cfg(test)]
mod tests;
