//! Codex app-server process boundary.
//!
//! Fable supervises `codex app-server --stdio` as a provider adapter, but Codex
//! owns authentication. This module never opens Codex auth files and never asks
//! for `getAuthStatus`, because that response can include auth tokens.

use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

const CODEX_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_LOGIN_COMPLETION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    pub(crate) installed: bool,
    pub(crate) authenticated: bool,
    pub(crate) auth_method: Option<String>,
    pub(crate) executable_path: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBrowserLoginResult {
    provider_id: &'static str,
    outcome: &'static str,
    message: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexModelCatalogEntry {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) is_default: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStartRequest {
    request_id: String,
    provider_id: String,
    thread_id: Option<String>,
    request: CodexAgentRunRequest,
    options: CodexTurnOptions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAgentRunRequest {
    model: String,
    messages: Vec<CodexMessage>,
    #[allow(dead_code)]
    tools: Vec<Value>,
    #[allow(dead_code)]
    max_tokens: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct CodexMessage {
    role: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnOptions {
    context_prefix: Option<String>,
    permission_mode: Option<String>,
    run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalResponseRequest {
    request_id: String,
    approval_request_id: String,
    result: CodexApprovalResult,
}

#[derive(Clone, Debug, Deserialize)]
struct CodexApprovalResult {
    #[allow(dead_code)]
    call_id: String,
    ok: bool,
    output: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInterruptRequest {
    request_id: String,
    thread_id: String,
    turn_id: Option<String>,
}

struct ActiveCodexRun {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    approval_kinds: Arc<Mutex<HashMap<String, ApprovalKind>>>,
}

#[derive(Clone, Copy)]
enum ApprovalKind {
    Command,
    FileChange,
    DynamicTool,
    Other,
}

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveCodexRun>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, ActiveCodexRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn codex_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            #[cfg(windows)]
            {
                candidates.push(dir.join("codex.cmd"));
                candidates.push(dir.join("codex.exe"));
                candidates.push(dir.join("codex"));
            }
            #[cfg(not(windows))]
            {
                candidates.push(dir.join("codex"));
            }
        }
    }
    candidates
}

fn find_codex_executable() -> Option<PathBuf> {
    codex_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn codex_command(path: &PathBuf) -> Command {
    #[cfg(windows)]
    {
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("cmd"))
            .unwrap_or(false)
        {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(path);
            return command;
        }
    }
    Command::new(path)
}

fn write_json_line(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut locked = stdin
        .lock()
        .map_err(|_| "Codex app-server stdin is unavailable.".to_string())?;
    let encoded = serde_json::to_string(value)
        .map_err(|_| "Fable could not encode a Codex app-server request.".to_string())?;
    locked
        .write_all(encoded.as_bytes())
        .and_then(|_| locked.write_all(b"\n"))
        .and_then(|_| locked.flush())
        .map_err(|_| "Fable could not write to Codex app-server.".to_string())
}

fn validated_codex_auth_url(value: &str) -> Result<String, String> {
    if value.chars().count() > 8_192 {
        return Err("Codex returned an invalid ChatGPT sign-in address.".into());
    }
    let url = Url::parse(value)
        .map_err(|_| "Codex returned an invalid ChatGPT sign-in address.".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let trusted_host = matches!(host.as_str(), "chatgpt.com" | "auth.openai.com")
        || host.ends_with(".chatgpt.com")
        || host.ends_with(".openai.com");
    if url.scheme() != "https"
        || !trusted_host
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Codex returned an untrusted ChatGPT sign-in address.".into());
    }
    Ok(url.to_string())
}

fn open_system_browser(value: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("rundll32.exe"))
        .filter(|path| path.is_file())
        .ok_or_else(|| "Fable could not locate the Windows browser launcher.".to_string())
        .and_then(|launcher| {
            Command::new(launcher)
                .arg("url.dll,FileProtocolHandler")
                .arg(value)
                .spawn()
                .map_err(|_| "Fable could not open the ChatGPT sign-in page.".to_string())
        });
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(value).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(value).spawn();

    result
        .map(|_| ())
        .map_err(|_| "Fable could not open the ChatGPT sign-in page.".to_string())
}

fn receive_codex_value(
    receiver: &mpsc::Receiver<Value>,
    timeout: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("ChatGPT sign-in timed out.".into());
        }
        let value = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Codex stopped before ChatGPT sign-in completed.".to_string())?;
        if predicate(&value) {
            return Ok(value);
        }
    }
}

fn chatgpt_login_details(value: &Value) -> Result<(String, String), String> {
    if value.get("error").is_some()
        || value.pointer("/result/type").and_then(Value::as_str) != Some("chatgpt")
    {
        return Err("Codex could not start ChatGPT sign-in.".into());
    }
    let login_id = value
        .pointer("/result/loginId")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.is_empty() && candidate.len() <= 160)
        .ok_or_else(|| "Codex returned no ChatGPT sign-in identifier.".to_string())?;
    let auth_url = value
        .pointer("/result/authUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex returned no ChatGPT sign-in address.".to_string())?;
    Ok((login_id.to_string(), validated_codex_auth_url(auth_url)?))
}

fn start_codex_browser_login_blocking() -> Result<CodexBrowserLoginResult, String> {
    let path =
        find_codex_executable().ok_or_else(|| "Codex CLI was not found on PATH.".to_string())?;
    let mut command = codex_command(&path);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Fable could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    thread::spawn(
        move || {
            for _ in BufReader::new(stderr).lines().map_while(Result::ok) {}
        },
    );

    let result = (|| {
        write_json_line(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "fable", "title": "Fable", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": false, "requestAttestation": false }
                }
            }),
        )?;
        let initialized = receive_codex_value(&receiver, CODEX_LOGIN_START_TIMEOUT, |value| {
            value.get("id").and_then(Value::as_i64) == Some(1)
        })?;
        if initialized.get("error").is_some() {
            return Err("Codex app-server could not initialize ChatGPT sign-in.".into());
        }
        write_json_line(&stdin, &json!({ "method": "initialized" }))?;
        write_json_line(
            &stdin,
            &json!({
                "id": 2,
                "method": "account/login/start",
                "params": {
                    "type": "chatgpt",
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "chatgpt"
                }
            }),
        )?;
        let start = receive_codex_value(&receiver, CODEX_LOGIN_START_TIMEOUT, |value| {
            value.get("id").and_then(Value::as_i64) == Some(2)
        })?;
        let (login_id, auth_url) = chatgpt_login_details(&start)?;
        open_system_browser(&auth_url)?;
        let completion = receive_codex_value(&receiver, CODEX_LOGIN_COMPLETION_TIMEOUT, |value| {
            value.get("method").and_then(Value::as_str) == Some("account/login/completed")
                && value.pointer("/params/loginId").and_then(Value::as_str)
                    == Some(login_id.as_str())
        })?;
        if completion
            .pointer("/params/success")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err("ChatGPT sign-in was not completed.".into());
        }
        Ok(CodexBrowserLoginResult {
            provider_id: "codex",
            outcome: "ready",
            message: "ChatGPT sign-in completed in your browser.",
        })
    })();

    let _ = child.kill();
    let _ = child.wait();
    result
}

#[tauri::command]
pub async fn start_codex_browser_login() -> Result<CodexBrowserLoginResult, String> {
    tauri::async_runtime::spawn_blocking(start_codex_browser_login_blocking)
        .await
        .map_err(|_| "The ChatGPT sign-in task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub fn codex_cli_status() -> CodexCliStatus {
    let Some(path) = find_codex_executable() else {
        return CodexCliStatus {
            installed: false,
            authenticated: false,
            auth_method: None,
            executable_path: None,
            version: None,
            message: Some("Codex CLI was not found on PATH.".to_string()),
        };
    };

    let version = codex_command(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .filter(|value| !value.is_empty());

    // `codex login status` exposes only whether the provider-owned session is
    // usable and its broad login kind. Fable never reads auth.json or tokens.
    let login = codex_command(&path).args(["login", "status"]).output().ok();
    let authenticated = login.as_ref().is_some_and(|output| output.status.success());
    let login_copy = login
        .as_ref()
        .map(|output| {
            format!(
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let auth_method = if !authenticated {
        None
    } else if login_copy.contains("api key") {
        Some("api-key".to_string())
    } else if login_copy.contains("chatgpt") {
        Some("chatgpt".to_string())
    } else {
        Some("provider-login".to_string())
    };

    CodexCliStatus {
        installed: true,
        authenticated,
        auth_method,
        executable_path: Some(path.display().to_string()),
        version,
        message: if authenticated {
            None
        } else {
            Some("Codex CLI is installed but not signed in.".to_string())
        },
    }
}

/// Ask the installed app-server for its current model catalog.
///
/// Codex owns both authentication and model availability. Keeping this lookup
/// at the native process boundary avoids stale hardcoded model IDs without
/// exposing any auth material to JavaScript.
pub(crate) fn codex_model_catalog() -> Result<Vec<CodexModelCatalogEntry>, String> {
    let path =
        find_codex_executable().ok_or_else(|| "Codex CLI was not found on PATH.".to_string())?;
    let mut command = codex_command(&path);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Fable could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });

    let request_result = (|| {
        write_json_line(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "fable",
                        "title": "Fable",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false
                    }
                }
            }),
        )?;
        write_json_line(&stdin, &json!({ "method": "initialized" }))?;
        write_json_line(
            &stdin,
            &json!({
                "id": 2,
                "method": "model/list",
                "params": { "limit": 100 }
            }),
        )?;

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex app-server did not return its model list.".to_string());
            }
            let value = receiver
                .recv_timeout(remaining)
                .map_err(|_| "Codex app-server did not return its model list.".to_string())?;
            if value.get("id").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            if value.get("error").is_some() {
                return Err("Codex app-server could not list available models.".to_string());
            }

            let mut models = value
                .pointer("/result/data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|model| {
                    !model
                        .get("hidden")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|model| {
                    let id = model.get("model").and_then(Value::as_str)?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    let label = model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|label| !label.is_empty())
                        .unwrap_or(id);
                    Some(CodexModelCatalogEntry {
                        id: id.to_string(),
                        label: label.to_string(),
                        is_default: model
                            .get("isDefault")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>();
            models.sort_by_key(|model| !model.is_default);
            if models.is_empty() {
                return Err("Codex app-server returned no available models.".to_string());
            }
            return Ok(models);
        }
    })();

    let _ = child.kill();
    let _ = child.wait();
    request_result
}

#[tauri::command]
pub fn start_codex_app_server_turn(
    app: AppHandle,
    request: CodexTurnStartRequest,
) -> Result<(), String> {
    crate::execution_control::ensure_active_execution_allowed()?;
    if request.provider_id != "codex" {
        return Err("Codex app-server can only run the Codex provider.".to_string());
    }
    let Some(path) = find_codex_executable() else {
        return Err("Codex CLI was not found on PATH.".to_string());
    };

    let mut command = codex_command(&path);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Fable could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let approval_kinds = Arc::new(Mutex::new(HashMap::new()));

    {
        let mut runs = active_runs()
            .lock()
            .map_err(|_| "Fable could not track Codex app-server state.".to_string())?;
        runs.insert(
            request.request_id.clone(),
            ActiveCodexRun {
                stdin: Arc::clone(&stdin),
                child: Arc::clone(&child),
                approval_kinds: Arc::clone(&approval_kinds),
            },
        );
    }

    let initialize = json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "fable", "title": "Fable", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true, "requestAttestation": false }
        }
    });
    write_json_line(&stdin, &initialize)?;
    write_json_line(&stdin, &json!({ "method": "initialized" }))?;
    let thread_request = if let Some(thread_id) = &request.thread_id {
        json!({
            "id": 2,
            "method": "thread/resume",
            "params": {
                "threadId": thread_id,
                "model": request.request.model,
                "approvalPolicy": "on-request"
            }
        })
    } else {
        json!({
            "id": 2,
            "method": "thread/start",
            "params": {
                "model": request.request.model,
                "approvalPolicy": "on-request",
                "threadSource": "appServer",
                "serviceName": "Fable"
            }
        })
    };
    write_json_line(&stdin, &thread_request)?;

    let app_for_stdout = app.clone();
    let request_for_stdout = request.clone();
    thread::spawn(move || {
        read_codex_stdout(
            app_for_stdout,
            request_for_stdout,
            stdout,
            stdin,
            approval_kinds,
        );
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for _ in reader.lines().map_while(Result::ok) {}
    });

    Ok(())
}

fn read_codex_stdout(
    app: AppHandle,
    request: CodexTurnStartRequest,
    stdout: std::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    approval_kinds: Arc<Mutex<HashMap<String, ApprovalKind>>>,
) {
    let channel = format!("fable://codex/{}", request.request_id);
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(2) {
            if value.get("error").is_some() {
                let message = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server could not start or resume the thread.");
                let _ = app.emit(&channel, json!({ "type": "error", "message": message }));
                let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
                continue;
            }
            if let Some(thread_id) = value
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
            {
                let _ = app.emit(&channel, json!({ "type": "thread", "threadId": thread_id }));
                let _ = write_json_line(&stdin, &turn_start_request(&thread_id, &request));
            } else {
                let _ = app.emit(
                    &channel,
                    json!({
                        "type": "error",
                        "message": "Codex app-server returned no thread identifier."
                    }),
                );
                let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
            }
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(3) && value.get("error").is_some() {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server could not start the turn.");
            let _ = app.emit(&channel, json!({ "type": "error", "message": message }));
            let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
            continue;
        }
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            handle_codex_method(&app, &channel, method, &value, &approval_kinds);
        }
    }
    let _ = app.emit(&channel, json!({ "type": "process-exited" }));
    if let Ok(mut runs) = active_runs().lock() {
        runs.remove(&request.request_id);
    }
}

fn turn_start_request(thread_id: &str, request: &CodexTurnStartRequest) -> Value {
    let mut text = request
        .request
        .messages
        .iter()
        .filter(|message| message.role == "user")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if let Some(prefix) = request.options.context_prefix.as_deref() {
        if !prefix.trim().is_empty() {
            text = format!("{prefix}\n\n{text}");
        }
    }
    let approval_policy = match request.options.permission_mode.as_deref() {
        Some("read-only") => "untrusted",
        Some("ask") => "on-request",
        _ => "on-request",
    };
    json!({
        "id": 3,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "clientUserMessageId": request.options.run_id,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
            "model": request.request.model,
            "approvalPolicy": approval_policy
        }
    })
}

fn handle_codex_method(
    app: &AppHandle,
    channel: &str,
    method: &str,
    value: &Value,
    approval_kinds: &Arc<Mutex<HashMap<String, ApprovalKind>>>,
) {
    match method {
        "turn/started" => {
            if let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({ "type": "turn", "turnId": turn_id }));
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = value.pointer("/params/delta").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({ "type": "text-delta", "text": delta }));
            }
        }
        "thread/tokenUsage/updated" => {
            let input = value
                .pointer("/params/tokenUsage/last/inputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = value
                .pointer("/params/tokenUsage/last/outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let _ = app.emit(
                channel,
                json!({ "type": "usage", "inputTokens": input, "outputTokens": output }),
            );
        }
        "turn/completed" => {
            let status = value
                .pointer("/params/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            if status == "failed" {
                let message = value
                    .pointer("/params/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed.");
                let _ = app.emit(channel, json!({ "type": "error", "message": message }));
                let _ = app.emit(channel, json!({ "type": "done", "finishReason": "error" }));
            } else if status == "interrupted" {
                let _ = app.emit(channel, json!({ "type": "cancelled" }));
            } else {
                let _ = app.emit(channel, json!({ "type": "done", "finishReason": "stop" }));
            }
        }
        "item/commandExecution/requestApproval" => {
            emit_approval(app, channel, value, approval_kinds, ApprovalKind::Command);
        }
        "item/fileChange/requestApproval" => {
            emit_approval(
                app,
                channel,
                value,
                approval_kinds,
                ApprovalKind::FileChange,
            );
        }
        "item/tool/call" => {
            emit_approval(
                app,
                channel,
                value,
                approval_kinds,
                ApprovalKind::DynamicTool,
            );
        }
        "error" => {
            let message = value
                .pointer("/params/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server returned an error.");
            let _ = app.emit(channel, json!({ "type": "error", "message": message }));
        }
        _ => {}
    }
}

fn emit_approval(
    app: &AppHandle,
    channel: &str,
    value: &Value,
    approval_kinds: &Arc<Mutex<HashMap<String, ApprovalKind>>>,
    kind: ApprovalKind,
) {
    let request_id = value
        .get("id")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .to_string();
    let call_id = value
        .pointer("/params/itemId")
        .or_else(|| value.pointer("/params/callId"))
        .and_then(Value::as_str)
        .unwrap_or(&request_id);
    let tool = value
        .pointer("/params/tool")
        .or_else(|| value.pointer("/params/command"))
        .and_then(Value::as_str)
        .unwrap_or(match kind {
            ApprovalKind::Command => "run-shell",
            ApprovalKind::FileChange => "file-change",
            ApprovalKind::DynamicTool => "dynamic-tool",
            ApprovalKind::Other => "codex-tool",
        });
    let args = value
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({ "command": tool }));
    if let Ok(mut map) = approval_kinds.lock() {
        map.insert(request_id.clone(), kind);
    }
    let _ = app.emit(
        channel,
        json!({
            "type": "approval-request",
            "requestId": request_id,
            "callId": call_id,
            "tool": tool,
            "arguments": args.to_string(),
            "approval": {
                "id": format!("codex-{call_id}"),
                "service": "Codex",
                "action": format!("Approve {tool}"),
                "mode": "full-access",
                "riskLevel": "medium",
                "dataUsed": ["workspace"],
                "consequence": "Codex requested a consequential action.",
                "requestedAt": chrono::Utc::now().to_rfc3339(),
                "decisions": []
            }
        }),
    );
}

#[tauri::command]
pub fn respond_codex_app_server_approval(
    request: CodexApprovalResponseRequest,
) -> Result<(), String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Fable could not access Codex app-server state.".to_string())?;
    let run = runs
        .get(&request.request_id)
        .ok_or_else(|| "Codex app-server run is no longer active.".to_string())?;
    let kind = run
        .approval_kinds
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request.approval_request_id))
        .unwrap_or(ApprovalKind::Other);
    let response = match kind {
        ApprovalKind::Command => json!({
            "id": request.approval_request_id,
            "result": { "decision": if request.result.ok { "accept" } else { "decline" } }
        }),
        ApprovalKind::FileChange => json!({
            "id": request.approval_request_id,
            "result": { "decision": if request.result.ok { "accept" } else { "decline" } }
        }),
        ApprovalKind::DynamicTool => json!({
            "id": request.approval_request_id,
            "result": {
                "contentItems": [{ "type": "inputText", "text": request.result.output }],
                "success": request.result.ok
            }
        }),
        ApprovalKind::Other => json!({
            "id": request.approval_request_id,
            "result": {}
        }),
    };
    write_json_line(&run.stdin, &response)
}

#[tauri::command]
pub fn interrupt_codex_app_server_turn(request: CodexInterruptRequest) -> Result<(), String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Fable could not access Codex app-server state.".to_string())?;
    let run = runs
        .get(&request.request_id)
        .ok_or_else(|| "Codex app-server run is no longer active.".to_string())?;
    let Some(turn_id) = request.turn_id else {
        return Ok(());
    };
    write_json_line(
        &run.stdin,
        &json!({
            "id": 9,
            "method": "turn/interrupt",
            "params": { "threadId": request.thread_id, "turnId": turn_id }
        }),
    )
}

#[tauri::command]
pub fn shutdown_codex_app_server_turn(request_id: String) -> Result<(), String> {
    let run = active_runs()
        .lock()
        .map_err(|_| "Fable could not access Codex app-server state.".to_string())?
        .remove(&request_id);
    if let Some(run) = run {
        if let Ok(mut child) = run.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        chatgpt_login_details, find_codex_executable, validated_codex_auth_url, CodexCliStatus,
    };
    use serde_json::json;

    #[test]
    fn cli_status_shape_never_contains_token_fields() {
        let status = CodexCliStatus {
            installed: false,
            authenticated: false,
            auth_method: None,
            executable_path: None,
            version: None,
            message: Some("missing".to_string()),
        };
        let encoded = serde_json::to_string(&status).expect("status serializes");
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("authToken"));
    }

    #[test]
    fn executable_detection_is_optional_for_tests() {
        let _ = find_codex_executable();
    }

    #[test]
    fn chatgpt_browser_login_accepts_only_official_https_hosts() {
        assert!(validated_codex_auth_url("https://chatgpt.com/auth?state=opaque").is_ok());
        assert!(validated_codex_auth_url("https://auth.openai.com/codex").is_ok());
        for value in [
            "http://chatgpt.com/auth",
            "https://chatgpt.com.evil.example/auth",
            "https://user@chatgpt.com/auth",
            "file:///tmp/auth",
        ] {
            assert!(validated_codex_auth_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn chatgpt_browser_login_parses_only_managed_chatgpt_results() {
        let (login_id, auth_url) = chatgpt_login_details(&json!({
            "id": 2,
            "result": {
                "type": "chatgpt",
                "loginId": "login-123",
                "authUrl": "https://chatgpt.com/auth?state=opaque"
            }
        }))
        .unwrap();
        assert_eq!(login_id, "login-123");
        assert!(auth_url.starts_with("https://chatgpt.com/auth"));
        assert!(chatgpt_login_details(&json!({
            "id": 2,
            "result": {
                "type": "chatgptAuthTokens",
                "loginId": "login-123",
                "authUrl": "https://chatgpt.com/auth"
            }
        }))
        .is_err());
    }
}
