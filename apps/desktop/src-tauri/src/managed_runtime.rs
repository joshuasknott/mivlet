//! Provider-owned local runtime boundary for Claude, Cursor, Grok, and OpenCode.
//!
//! Cursor and Grok speak ACP over newline-delimited JSON-RPC. Claude uses its
//! bidirectional Agent SDK stdio protocol. OpenCode exposes an authenticated
//! local HTTP/SSE server. Mivlet supervises those processes, normalizes their
//! output, and keeps provider-owned credentials outside JavaScript. Missing
//! executables and unverified login state fail closed.

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
mod usage;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
pub(crate) use usage::claude_usage;

use crate::models::{BackendModel, BackendVerifyResult};
mod image_input;
mod sdk_launch;
mod shared_tools;
mod tool_delivery;

mod acp;
mod claude;
mod opencode;
mod runtime;
use acp::{managed_approval_payload, prompt_text, start_acp_turn, write_json};
use claude::{provider_tool_kind, respond_to_unsupported_claude_control, start_claude_turn};
use opencode::{open_code_endpoint, open_code_error, start_opencode_turn};
use runtime::safe_error_message;
use runtime::{
    cache_models, command_for_provider, find_executable, missing_runtime_message, probe_status,
    provider_label, read_limited, run_command, validate_provider_id, workspace_dir,
};
pub(crate) use runtime::{cached_models, status_for};
use shared_tools::{Dispatch, ToolBridge, ToolSpec};

const STATUS_TIMEOUT: Duration = Duration::from_secs(12);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_COMMAND_OUTPUT: usize = 128 * 1024;
const MANAGED_PROVIDER_IDS: [&str; 4] = ["claude", "cursor", "grok", "opencode"];
const ACP_PROVIDER_IDS: [&str; 2] = ["cursor", "grok"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeStatus {
    provider_id: String,
    pub(crate) installed: bool,
    pub(crate) authenticated: bool,
    pub(crate) version: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLoginResult {
    provider_id: String,
    outcome: &'static str,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTurnRequest {
    request_id: String,
    provider_id: String,
    request: ManagedAgentRequest,
    options: ManagedTurnOptions,
}

#[derive(Clone, Debug, Deserialize)]
struct ManagedAgentRequest {
    model: String,
    messages: Vec<ManagedMessage>,
    #[serde(default)]
    tools: Vec<ToolSpec>,
}

#[derive(Clone, Debug, Deserialize)]
struct ManagedMessage {
    role: String,
    content: String,
    #[serde(default)]
    images: Vec<crate::user_images::UserImageInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedTurnOptions {
    context_prefix: Option<String>,
    permission_mode: Option<String>,
    #[serde(rename = "runId")]
    _run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedApprovalResponse {
    request_id: String,
    approval_request_id: String,
    approved: bool,
}

#[derive(Clone)]
enum PendingPermission {
    Acp {
        allow_option: String,
        reject_option: String,
    },
    OpenCode,
}

#[derive(Clone)]
struct OpenCodeControl {
    base_url: String,
    authorization: String,
    directory: String,
}

struct ActiveRun {
    owner: String,
    provider_id: String,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    child: Arc<Mutex<crate::provider_process::SupervisedChild>>,
    session_id: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    opencode: Option<OpenCodeControl>,
    tool_bridge: Arc<Mutex<ToolBridge>>,
}

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn managed_runtime_status(provider_id: String) -> Result<ManagedRuntimeStatus, String> {
    validate_provider_id(&provider_id)?;
    let user_id = crate::backends::require_current_internal_user()?;
    let connected = crate::backends::connected_providers_for(&user_id)?;
    Ok(status_for(
        &provider_id,
        connected.iter().any(|candidate| candidate == &provider_id),
    ))
}

#[tauri::command]
pub async fn check_managed_runtime_connection(
    app: AppHandle,
    provider_id: String,
) -> Result<BackendVerifyResult, String> {
    validate_provider_id(&provider_id)?;
    let user_id = crate::backends::require_current_internal_user()?;
    let app_for_task = app.clone();
    let user_for_task = user_id.clone();
    let provider_for_task = provider_id.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        probe_status(&app_for_task, &user_for_task, &provider_for_task)
    })
    .await
    .map_err(|_| "The provider runtime check stopped unexpectedly.".to_string())??;
    let outcome = if !status.installed {
        "unsupported"
    } else if status.authenticated {
        crate::backends::record_connected_provider(&user_id, &provider_id)?;
        "ready"
    } else {
        let _ = crate::backends::remove_connected_provider(&user_id, &provider_id);
        "auth-failed"
    };
    Ok(BackendVerifyResult {
        provider_id,
        outcome: outcome.to_string(),
        message: status.message,
    })
}

#[tauri::command]
pub async fn start_managed_runtime_login(
    app: AppHandle,
    provider_id: String,
) -> Result<ManagedLoginResult, String> {
    validate_provider_id(&provider_id)?;
    if provider_id == "opencode" {
        return Err("OpenCode has no single account login. Run `opencode auth login` for the provider you want, then check the connection in Mivlet.".into());
    }
    let user_id = crate::backends::require_current_internal_user()?;
    let path =
        find_executable(&provider_id).ok_or_else(|| missing_runtime_message(&provider_id))?;
    let app_for_task = app.clone();
    let user_for_task = user_id.clone();
    let provider_for_task = provider_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut command =
            command_for_provider(&app_for_task, &user_for_task, &provider_for_task, &path)?;
        match provider_for_task.as_str() {
            "claude" => command.args(["auth", "login"]),
            "cursor" | "grok" => command.arg("login"),
            _ => unreachable!(),
        };
        let output = run_command(command, LOGIN_TIMEOUT)?;
        if output.success {
            Ok(())
        } else {
            Err(format!(
                "{} sign-in did not complete.",
                provider_label(&provider_for_task)
            ))
        }
    })
    .await
    .map_err(|_| "Provider sign-in stopped unexpectedly.".to_string())??;
    let status = probe_status(&app, &user_id, &provider_id)?;
    if !status.authenticated {
        return Err(status
            .message
            .unwrap_or_else(|| "Provider sign-in could not be verified.".to_string()));
    }
    crate::backends::record_connected_provider(&user_id, &provider_id)?;
    Ok(ManagedLoginResult {
        provider_id: provider_id.clone(),
        outcome: "ready",
        message: format!("{} account connected.", provider_label(&provider_id)),
    })
}

#[tauri::command]
pub fn list_managed_runtime_models(
    app: AppHandle,
    provider_id: String,
) -> Result<Vec<BackendModel>, String> {
    validate_provider_id(&provider_id)?;
    let user_id = crate::backends::require_current_internal_user()?;
    Ok(cached_models(&app, &user_id, &provider_id))
}

#[tauri::command]
pub fn start_managed_runtime_turn(
    app: AppHandle,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    validate_provider_id(&request.provider_id)?;
    image_input::validate_route(&request.provider_id, &request.request)?;
    let user_id = crate::backends::require_current_internal_user()?;
    if !crate::backends::connected_providers_for(&user_id)?
        .iter()
        .any(|provider_id| provider_id == &request.provider_id)
    {
        return Err(format!(
            "Connect {} before starting a turn.",
            provider_label(&request.provider_id)
        ));
    }
    if ACP_PROVIDER_IDS.contains(&request.provider_id.as_str()) {
        start_acp_turn(app, user_id, request)
    } else if request.provider_id == "claude" {
        start_claude_turn(app, user_id, request)
    } else {
        start_opencode_turn(app, user_id, request)
    }
}

fn shared_tool_response(request_id: &str, response: Value) -> Value {
    json!({"type":"control_response","response":{"subtype":"success",
        "request_id":request_id,"response":{"mcp_response":response}}})
}

fn terminate_claude_turn(
    child: &Arc<Mutex<crate::provider_process::SupervisedChild>>,
) -> Result<(), String> {
    child
        .lock()
        .map_err(|_| "The Claude process supervisor is unavailable.")?
        .kill()
        .map_err(|_| "The Claude process could not be stopped.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedToolResponse {
    request_id: String,
    tool_request_id: String,
    call_id: String,
    ok: bool,
    output: String,
}

#[tauri::command]
pub async fn respond_managed_runtime_tool(request: ManagedToolResponse) -> Result<(), String> {
    let owner = crate::backends::require_current_internal_user()?;
    let delivery = tool_delivery::prepare(&owner, request)?;
    delivery
        .send(|| {
            if crate::backends::require_current_internal_user()? == owner {
                Ok(())
            } else {
                Err("The provider turn's account changed.".into())
            }
        })
        .await
}

/// Check a shared call again after waiting for approval. This grants no authority.
#[tauri::command]
pub fn check_managed_runtime_tool(
    approval_id: String,
    tool: String,
    arguments: Value,
) -> Result<(), String> {
    if !approval_id.starts_with("mivlet-shared-") {
        return Ok(());
    }
    let owner = crate::backends::require_current_internal_user()?;
    let runs = active_runs()
        .lock()
        .map_err(|_| "The provider tool turn is unavailable.")?;
    if runs.values().any(|run| {
        run.owner == owner
            && run.provider_id == "claude"
            && run
                .tool_bridge
                .lock()
                .ok()
                .is_some_and(|bridge| bridge.current(&approval_id, &tool, &arguments))
    }) {
        Ok(())
    } else {
        Err("This Mivlet tool call was cancelled or its provider turn ended.".into())
    }
}

#[tauri::command]
pub async fn respond_managed_runtime_approval(
    request: ManagedApprovalResponse,
) -> Result<(), String> {
    let (provider_id, stdin, opencode, pending) = {
        let runs = active_runs()
            .lock()
            .map_err(|_| "Managed provider turn state is unavailable.".to_string())?;
        let run = runs
            .get(&request.request_id)
            .ok_or_else(|| "The managed provider turn is no longer active.".to_string())?;
        let pending = run
            .permissions
            .lock()
            .map_err(|_| "Managed provider permission state is unavailable.".to_string())?
            .remove(&request.approval_request_id)
            .ok_or_else(|| "This provider permission is no longer pending.".to_string())?;
        (
            run.provider_id.clone(),
            run.stdin.clone(),
            run.opencode.clone(),
            pending,
        )
    };
    match pending {
        PendingPermission::Acp {
            allow_option,
            reject_option,
        } => {
            let stdin = stdin
                .as_ref()
                .ok_or_else(|| "This ACP run no longer accepts approvals.".to_string())?;
            let id: Value = request
                .approval_request_id
                .parse::<u64>()
                .map(Value::from)
                .unwrap_or_else(|_| Value::String(request.approval_request_id.clone()));
            let option_id = if request.approved {
                allow_option
            } else {
                reject_option
            };
            write_json(
                stdin,
                &provider_id,
                &json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"selected","optionId":option_id}}}),
            )
        }
        PendingPermission::OpenCode => {
            let control = opencode
                .as_ref()
                .ok_or_else(|| "This OpenCode server is no longer available.".to_string())?;
            let endpoint = open_code_endpoint(
                &control.base_url,
                &["permission", &request.approval_request_id, "reply"],
            )?;
            let response = reqwest::Client::new()
                .post(endpoint)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .json(&json!({"reply":if request.approved { "once" } else { "reject" }}))
                .send()
                .await
                .map_err(|_| {
                    "Mivlet could not deliver the OpenCode permission decision.".to_string()
                })?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(open_code_error(response, "OpenCode rejected the permission decision.").await)
            }
        }
    }
}

#[tauri::command]
pub async fn interrupt_managed_runtime_turn(request_id: String) -> Result<(), String> {
    let run = {
        let runs = active_runs()
            .lock()
            .map_err(|_| "Managed provider turn state is unavailable.".to_string())?;
        runs.get(&request_id).map(|run| {
            if let Ok(mut bridge) = run.tool_bridge.lock() {
                bridge.stop();
            }
            (
                run.provider_id.clone(),
                run.stdin.clone(),
                run.child.clone(),
                run.session_id.lock().ok().and_then(|guard| guard.clone()),
                run.opencode.clone(),
            )
        })
    };
    let Some((provider_id, stdin, child, session_id, opencode)) = run else {
        return Ok(());
    };
    if provider_id == "opencode" {
        if let (Some(control), Some(session_id)) = (opencode.as_ref(), session_id.as_deref()) {
            let endpoint =
                open_code_endpoint(&control.base_url, &["session", session_id, "abort"])?;
            let response = reqwest::Client::new()
                .post(endpoint)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .send()
                .await
                .map_err(|_| "Mivlet could not interrupt OpenCode.".to_string())?;
            if !response.status().is_success() {
                return Err(open_code_error(response, "OpenCode rejected interruption.").await);
            }
        } else if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    } else if provider_id == "claude" {
        // A payload writer may be blocked on stdin. Stop terminates the turn's
        // supervised process tree independently of that writer or its mutex.
        terminate_claude_turn(&child)?;
    } else if let (Some(stdin), Some(session_id)) = (stdin.as_ref(), session_id) {
        write_json(
            stdin,
            &provider_id,
            &json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session_id}}),
        )?;
    } else if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

pub(crate) fn shutdown_account() {
    let ids: Vec<_> = active_runs()
        .lock()
        .map(|runs| runs.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = shutdown_managed_runtime_turn(id);
    }
}

#[tauri::command]
pub fn shutdown_managed_runtime_turn(request_id: String) -> Result<(), String> {
    let run = active_runs()
        .lock()
        .map_err(|_| "Managed provider turn state is unavailable.".to_string())?
        .remove(&request_id);
    if let Some(run) = run {
        if let Ok(mut bridge) = run.tool_bridge.lock() {
            bridge.stop();
        }
        let _ = run
            .child
            .lock()
            .map_err(|_| "Managed provider process state is unavailable.".to_string())?
            .kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn logout_managed_runtime(app: AppHandle, provider_id: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    let user_id = crate::backends::require_current_internal_user()?;
    if provider_id != "opencode" {
        if let Some(path) = find_executable(&provider_id) {
            let app_for_task = app.clone();
            let user_for_task = user_id.clone();
            let provider_for_task = provider_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut command =
                    command_for_provider(&app_for_task, &user_for_task, &provider_for_task, &path)?;
                match provider_for_task.as_str() {
                    "claude" => command.args(["auth", "logout"]),
                    "cursor" | "grok" => command.arg("logout"),
                    _ => unreachable!(),
                };
                let output = run_command(command, STATUS_TIMEOUT)?;
                output.success.then_some(()).ok_or_else(|| {
                    format!("{} sign-out failed.", provider_label(&provider_for_task))
                })
            })
            .await
            .map_err(|_| "Provider sign-out stopped unexpectedly.".to_string())??;
        }
    }
    crate::backends::remove_connected_provider(&user_id, &provider_id)
}

#[cfg(test)]
mod tests;
