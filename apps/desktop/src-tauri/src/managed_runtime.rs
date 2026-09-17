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
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::models::{BackendModel, BackendVerifyResult};

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
}

#[derive(Clone, Debug, Deserialize)]
struct ManagedMessage {
    role: String,
    content: String,
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
    Claude {
        tool_use_id: String,
        input: Value,
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
    provider_id: String,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    child: Arc<Mutex<crate::provider_process::SupervisedChild>>,
    session_id: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    opencode: Option<OpenCodeControl>,
}

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_provider_id(provider_id: &str) -> Result<&str, String> {
    MANAGED_PROVIDER_IDS
        .contains(&provider_id)
        .then_some(provider_id)
        .ok_or_else(|| "Mivlet does not recognize that managed provider runtime.".to_string())
}

fn provider_label(provider_id: &str) -> &'static str {
    match provider_id {
        "claude" => "Claude",
        "cursor" => "Cursor",
        "grok" => "Grok",
        "opencode" => "OpenCode",
        _ => "Provider",
    }
}

fn executable_names(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "claude" => &["claude"],
        "cursor" => &["agent", "cursor-agent"],
        "grok" => &["grok"],
        "opencode" => &["opencode"],
        _ => &[],
    }
}

fn push_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if seen.insert(path.clone()) {
        candidates.push(path);
    }
}

fn executable_candidates(provider_id: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            for name in executable_names(provider_id) {
                #[cfg(windows)]
                for suffix in [".exe", ".cmd", ".bat", ""] {
                    push_candidate(
                        &mut candidates,
                        &mut seen,
                        directory.join(format!("{name}{suffix}")),
                    );
                }
                #[cfg(not(windows))]
                push_candidate(&mut candidates, &mut seen, directory.join(name));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
            for name in executable_names(provider_id) {
                for base in [
                    profile.join(".local").join("bin"),
                    profile.join(".grok").join("bin"),
                ] {
                    push_candidate(&mut candidates, &mut seen, base.join(format!("{name}.exe")));
                    push_candidate(&mut candidates, &mut seen, base.join(format!("{name}.cmd")));
                }
            }
        }
        if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
            for name in executable_names(provider_id) {
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    app_data.join("npm").join(format!("{name}.cmd")),
                );
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    app_data.join("npm").join(format!("{name}.exe")),
                );
            }
        }
    }
    candidates
}

fn find_executable(provider_id: &str) -> Option<PathBuf> {
    executable_candidates(provider_id)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn executable_command(path: &Path) -> Command {
    #[cfg(windows)]
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
    {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(path);
        return command;
    }
    Command::new(path)
}

fn account_hash(user_id: &str) -> String {
    hex::encode(Sha256::digest(user_id.as_bytes()))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir(app)?.join("managed-runtimes"))
}

fn workspace_dir(app: &AppHandle, user_id: &str, provider_id: &str) -> Result<PathBuf, String> {
    let path = root(app)?
        .join("workspaces")
        .join(account_hash(user_id))
        .join(provider_id);
    fs::create_dir_all(&path).map_err(|_| {
        format!(
            "Mivlet could not prepare the {} workspace.",
            provider_label(provider_id)
        )
    })?;
    Ok(path)
}

fn claude_profile_dir(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    let path = root(app)?
        .join("profiles")
        .join(account_hash(user_id))
        .join("claude");
    fs::create_dir_all(&path)
        .map_err(|_| "Mivlet could not prepare the private Claude profile.".to_string())?;
    Ok(path)
}

fn models_path(app: &AppHandle, user_id: &str, provider_id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?
        .join("models")
        .join(account_hash(user_id))
        .join(format!("{provider_id}.json")))
}

fn cache_models(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    models: &[BackendModel],
) -> Result<(), String> {
    if models.is_empty() {
        return Ok(());
    }
    let path = models_path(app, user_id, provider_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Mivlet could not prepare the managed model cache.".to_string())?;
    }
    let bytes = serde_json::to_vec(models)
        .map_err(|_| "Mivlet could not encode managed provider models.".to_string())?;
    fs::write(path, bytes)
        .map_err(|_| "Mivlet could not cache managed provider models.".to_string())
}

pub(crate) fn cached_models(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
) -> Vec<BackendModel> {
    models_path(app, user_id, provider_id)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| fallback_models(provider_id))
}

fn fallback_models(provider_id: &str) -> Vec<BackendModel> {
    let values: &[(&str, &str)] = match provider_id {
        "claude" => &[
            ("sonnet", "Claude Sonnet"),
            ("opus", "Claude Opus"),
            ("haiku", "Claude Haiku"),
        ],
        "cursor" => &[("default", "Cursor default")],
        "grok" => &[("grok-build", "Grok default")],
        _ => &[],
    };
    values
        .iter()
        .map(|(id, label)| BackendModel {
            id: (*id).to_string(),
            label: (*label).to_string(),
            available: true,
            capabilities: None,
            reasoning: None,
        })
        .collect()
}

struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn read_limited(mut reader: impl Read, limit: usize) -> String {
    let mut collected = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = limit.saturating_sub(collected.len());
                collected.extend_from_slice(&buffer[..count.min(remaining)]);
            }
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

fn run_command(mut command: Command, timeout: Duration) -> Result<CommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start the provider runtime.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Provider stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Provider stderr was unavailable.".to_string())?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, MAX_COMMAND_OUTPUT));
    let stderr_reader = thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Mivlet could not inspect the provider process.".to_string())?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The provider runtime check timed out.".to_string());
        }
        thread::sleep(Duration::from_millis(40));
    };
    Ok(CommandOutput {
        success: status.success(),
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

fn normalized_version(value: &str) -> Option<String> {
    let line = value
        .lines()
        .map(str::trim)
        .find(|line| line.chars().any(|character| character.is_ascii_digit()))?;
    Some(crate::paths::truncate_characters(
        &crate::paths::normalize_spaces(line),
        120,
    ))
}

fn safe_error_message(value: &str, fallback: &str) -> String {
    let candidate = value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback);
    crate::store::repos::action_history::redact_safe_detail(&Value::String(candidate.to_string()))
        .as_str()
        .unwrap_or(fallback)
        .to_string()
}

fn command_for_provider(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    path: &Path,
) -> Result<Command, String> {
    if provider_id != "claude" || cfg!(target_os = "macos") {
        return Err(format!("{} is unavailable until its provider-owned credential store supports verified Mivlet account isolation. Connect a direct API provider instead.", provider_label(provider_id)));
    }
    crate::account_session::ensure_current()?;
    let mut command = executable_command(path);
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_API_KEY_HELPER",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        command.env_remove(key);
    }

    if provider_id == "claude" {
        command.env("CLAUDE_CONFIG_DIR", claude_profile_dir(app, user_id)?);
    }
    if provider_id == "opencode" {
        command
            .env("OPENCODE_AUTO_SHARE", "false")
            .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
            .env("OPENCODE_DISABLE_TERMINAL_TITLE", "true");
    }
    Ok(command)
}

fn parse_cursor_about(output: &CommandOutput) -> (bool, Option<String>) {
    if let Ok(value) = serde_json::from_str::<Value>(output.stdout.trim()) {
        let version = value
            .get("cliVersion")
            .and_then(Value::as_str)
            .map(str::to_string);
        let authenticated = value
            .get("userEmail")
            .and_then(Value::as_str)
            .is_some_and(|email| !email.trim().is_empty());
        return (authenticated, version);
    }
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    let lower = combined.to_ascii_lowercase();
    let authenticated = combined
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(char::is_whitespace)?;
            key.eq_ignore_ascii_case("User")
                .then(|| value.trim_start_matches("Email").trim())
        })
        .is_some_and(|email| {
            !email.is_empty()
                && !email.eq_ignore_ascii_case("not logged in")
                && !lower.contains("authentication required")
        });
    (authenticated, normalized_version(&combined))
}

fn parse_grok_models(output: &str) -> (Option<bool>, Vec<BackendModel>) {
    let authenticated = if output.to_ascii_lowercase().contains("you are logged in") {
        Some(true)
    } else if output.to_ascii_lowercase().contains("not authenticated")
        || output.to_ascii_lowercase().contains("not logged in")
    {
        Some(false)
    } else {
        None
    };
    let mut seen = HashSet::new();
    let models = output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let slug = trimmed
                .strip_prefix("* ")
                .or_else(|| trimmed.strip_prefix("- "))?
                .split_whitespace()
                .next()?
                .trim();
            if slug.is_empty() || !seen.insert(slug.to_string()) {
                return None;
            }
            Some(BackendModel {
                id: slug.to_string(),
                label: slug
                    .split(['-', '_'])
                    .map(|part| {
                        if part.eq_ignore_ascii_case("grok") {
                            "Grok".to_string()
                        } else {
                            part.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                available: true,
                capabilities: None,
                reasoning: None,
            })
        })
        .take(32)
        .collect();
    (authenticated, models)
}

fn parse_opencode_models(output: &str) -> Vec<BackendModel> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let id = line.split_whitespace().next()?.trim();
            if id.is_empty()
                || !id.contains('/')
                || id.len() > 180
                || !id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "/._-:@".contains(character)
                })
                || !seen.insert(id.to_string())
            {
                return None;
            }
            Some(BackendModel {
                id: id.to_string(),
                label: id.to_string(),
                available: true,
                capabilities: None,
                reasoning: None,
            })
        })
        .take(32)
        .collect()
}

fn probe_status(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
) -> Result<ManagedRuntimeStatus, String> {
    validate_provider_id(provider_id)?;
    let Some(path) = find_executable(provider_id) else {
        return Ok(ManagedRuntimeStatus {
            provider_id: provider_id.to_string(),
            installed: false,
            authenticated: false,
            version: None,
            message: Some(format!(
                "Install the official {} runtime, then reopen Mivlet.",
                provider_label(provider_id)
            )),
        });
    };
    let mut version_command = command_for_provider(app, user_id, provider_id, &path)?;
    version_command.arg("--version");
    let version_output = run_command(version_command, STATUS_TIMEOUT)?;
    let version = normalized_version(&format!(
        "{}\n{}",
        version_output.stdout, version_output.stderr
    ));
    if !version_output.success {
        return Ok(ManagedRuntimeStatus {
            provider_id: provider_id.to_string(),
            installed: true,
            authenticated: false,
            version,
            message: Some(format!(
                "The {} runtime is installed but could not be started.",
                provider_label(provider_id)
            )),
        });
    }

    let (authenticated, discovered_models) = match provider_id {
        "claude" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["auth", "status", "--json"]);
            let output = run_command(command, STATUS_TIMEOUT)?;
            let value = serde_json::from_str::<Value>(output.stdout.trim()).unwrap_or(Value::Null);
            let authenticated = value
                .get("loggedIn")
                .or_else(|| value.get("authenticated"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
                    output.success && text.contains("logged in") && !text.contains("not logged in")
                });
            (authenticated, fallback_models(provider_id))
        }
        "cursor" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["about", "--format", "json"]);
            let mut output = run_command(command, STATUS_TIMEOUT)?;
            if !output.success
                && (output
                    .stderr
                    .to_ascii_lowercase()
                    .contains("unexpected argument")
                    || output.stderr.to_ascii_lowercase().contains("unknown"))
            {
                let mut fallback = command_for_provider(app, user_id, provider_id, &path)?;
                fallback.arg("about");
                output = run_command(fallback, STATUS_TIMEOUT)?;
            }
            let (authenticated, _) = parse_cursor_about(&output);
            (authenticated, fallback_models(provider_id))
        }
        "grok" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.arg("models");
            let output = run_command(command, STATUS_TIMEOUT)?;
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            let (auth, models) = parse_grok_models(&combined);
            (auth.unwrap_or(false), models)
        }
        "opencode" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["models"]);
            let output = run_command(command, STATUS_TIMEOUT)?;
            let models = if output.success {
                parse_opencode_models(&output.stdout)
            } else {
                Vec::new()
            };
            (!models.is_empty(), models)
        }
        _ => unreachable!(),
    };
    if authenticated {
        cache_models(app, user_id, provider_id, &discovered_models)?;
    }
    Ok(ManagedRuntimeStatus {
        provider_id: provider_id.to_string(),
        installed: true,
        authenticated,
        version,
        message: Some(if authenticated {
            format!("{} is connected.", provider_label(provider_id))
        } else if provider_id == "opencode" {
            "OpenCode is installed, but no configured provider models were found. Run `opencode auth login`, then check again.".to_string()
        } else {
            format!(
                "{} is installed. Continue with your {} account to connect it.",
                provider_label(provider_id),
                provider_label(provider_id)
            )
        }),
    })
}

pub(crate) fn status_for(provider_id: &str, previously_connected: bool) -> ManagedRuntimeStatus {
    let installed = find_executable(provider_id).is_some();
    ManagedRuntimeStatus {
        provider_id: provider_id.to_string(),
        installed,
        authenticated: installed && previously_connected,
        version: None,
        message: Some(if !installed {
            format!(
                "Install the official {} runtime, then reopen Mivlet.",
                provider_label(provider_id)
            )
        } else if previously_connected {
            format!(
                "{} account connection is ready to verify.",
                provider_label(provider_id)
            )
        } else if provider_id == "opencode" {
            "Configure a provider with `opencode auth login`, then check the connection in Mivlet."
                .to_string()
        } else {
            format!(
                "Continue with your {} account.",
                provider_label(provider_id)
            )
        }),
    }
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
    let path = find_executable(&provider_id).ok_or_else(|| {
        format!(
            "Install the official {} runtime first.",
            provider_label(&provider_id)
        )
    })?;
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

fn write_json(
    stdin: &Arc<Mutex<ChildStdin>>,
    provider_id: &str,
    value: &Value,
) -> Result<(), String> {
    let mut input = stdin
        .lock()
        .map_err(|_| format!("{} stdin is unavailable.", provider_label(provider_id)))?;
    serde_json::to_writer(&mut *input, value)
        .map_err(|_| "Mivlet could not encode an ACP request.".to_string())?;
    input
        .write_all(b"\n")
        .and_then(|_| input.flush())
        .map_err(|_| {
            format!(
                "Mivlet could not write to {} ACP.",
                provider_label(provider_id)
            )
        })
}

fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc":"2.0",
        "id":id,
        "method":"initialize",
        "params":{
            "protocolVersion":1,
            "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
            "clientInfo":{"name":"Mivlet","title":"Mivlet","version":env!("CARGO_PKG_VERSION")}
        }
    })
}

fn auth_method(provider_id: &str) -> &'static str {
    match provider_id {
        "cursor" => "cursor_login",
        "grok" => "cached_token",
        _ => "",
    }
}

fn validate_initialize(provider_id: &str, value: &Value) -> Result<(), String> {
    if value.get("error").is_some() {
        return Err(format!(
            "{} ACP initialization failed.",
            provider_label(provider_id)
        ));
    }
    let protocol = value
        .pointer("/result/protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let methods = value
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let expected = auth_method(provider_id);
    let supports_auth = methods.is_empty()
        || methods.iter().any(|method| {
            method.as_str() == Some(expected)
                || method.get("id").and_then(Value::as_str) == Some(expected)
        });
    if protocol == 1 && supports_auth {
        Ok(())
    } else {
        Err(format!(
            "The installed {} runtime did not expose the expected ACP contract.",
            provider_label(provider_id)
        ))
    }
}

fn extract_acp_models(value: &Value) -> Vec<BackendModel> {
    let result = value.get("result").unwrap_or(value);
    let model_state = result
        .get("models")
        .or_else(|| result.pointer("/_meta/modelState"));
    let direct = model_state
        .and_then(|state| state.get("availableModels"))
        .and_then(Value::as_array);
    let configured = result
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
        })
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array);
    let mut seen = HashSet::new();
    direct
        .or(configured)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model
                .get("modelId")
                .or_else(|| model.get("value"))
                .and_then(Value::as_str)?
                .trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let label = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .trim();
            Some(BackendModel {
                id: id.to_string(),
                label: label.to_string(),
                available: true,
                capabilities: None,
                reasoning: None,
            })
        })
        .take(32)
        .collect()
}

fn acp_command(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    workspace: &Path,
) -> Result<Command, String> {
    let path = find_executable(provider_id).ok_or_else(|| {
        format!(
            "Install the official {} runtime first.",
            provider_label(provider_id)
        )
    })?;
    let mut command = command_for_provider(app, user_id, provider_id, &path)?;
    match provider_id {
        "cursor" => {
            command.arg("acp");
        }
        "grok" => {
            command.args(["agent", "stdio"]);
        }
        _ => return Err("This provider does not expose an ACP runtime.".into()),
    }
    command
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    Ok(command)
}

fn prompt_text(request: &ManagedAgentRequest, options: &ManagedTurnOptions) -> String {
    let mut parts = Vec::new();
    if let Some(prefix) = options
        .context_prefix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(prefix.to_string());
    }
    let history = request
        .messages
        .iter()
        .map(|message| format!("{}: {}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    if !history.is_empty() {
        parts.push(history);
    }
    parts.join("\n\n")
}

fn normalized_permission_mode(mode: &str) -> &'static str {
    match mode {
        "read-only" => "read-only",
        "full-access" => "full-access",
        _ => "trusted-scope",
    }
}

fn managed_approval_payload(
    provider_id: &str,
    run_id: &str,
    request_id: &str,
    call_id: &str,
    tool_kind: &str,
    title: &str,
    arguments: &Value,
    mode: &str,
) -> Value {
    let title = crate::paths::truncate_characters(&crate::paths::normalize_spaces(title), 120);
    let arguments = crate::store::repos::action_history::redact_safe_detail(arguments);
    let arguments_text = crate::paths::truncate_characters(&arguments.to_string(), 2_000);
    let permission_mode = normalized_permission_mode(mode);
    let label = provider_label(provider_id);
    json!({
        "type":"approval-request",
        "requestId":request_id,
        "callId":call_id,
        "tool":format!("{provider_id}:{tool_kind}"),
        "arguments":arguments_text.clone(),
        "approval":{
            "id":crate::paths::truncate_characters(&format!("{provider_id}-{run_id}-{request_id}"),120),
            "service":provider_id,
            "action":title.clone(),
            "mode":permission_mode,
            "riskLevel":if permission_mode == "full-access" { "high" } else { "medium" },
            "dataUsed":[arguments_text],
            "consequence":format!("Allow {label} to {title}."),
            "requestedAt":chrono::Utc::now().to_rfc3339(),
            "decisions":["once","deny"],
            "confirmationPhrase":if permission_mode == "full-access" { Value::String(format!("approve {} action", provider_id)) } else { Value::Null }
        }
    })
}

fn acp_approval_payload(
    provider_id: &str,
    run_id: &str,
    request_id: &str,
    value: &Value,
    mode: &str,
) -> (Value, Option<PendingPermission>) {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let call_id = tool
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or(request_id)
        .to_string();
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("perform this provider action");
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("other");
    let args = tool.get("rawInput").cloned().unwrap_or_else(|| json!({}));
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let allow = options
        .iter()
        .find(|option| {
            matches!(
                option.get("kind").and_then(Value::as_str),
                Some("allow_once")
                    | Some("allow-once")
                    | Some("allow_always")
                    | Some("allow-always")
            )
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let reject = options
        .iter()
        .find(|option| {
            matches!(
                option.get("kind").and_then(Value::as_str),
                Some("reject_once") | Some("reject-once")
            )
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let payload = managed_approval_payload(
        provider_id,
        run_id,
        request_id,
        &call_id,
        kind,
        title,
        &args,
        mode,
    );
    let pending = allow
        .zip(reject)
        .map(|(allow_option, reject_option)| PendingPermission::Acp {
            allow_option,
            reject_option,
        });
    (payload, pending)
}

fn respond_to_unsupported_extension(
    stdin: &Arc<Mutex<ChildStdin>>,
    provider_id: &str,
    value: &Value,
) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let Some(id) = value.get("id") else {
        return;
    };
    if method.starts_with("cursor/") || method.starts_with("x.ai/") {
        let _ = write_json(
            stdin,
            provider_id,
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Mivlet does not expose that provider extension."}}),
        );
    }
}

fn handle_acp_line(
    app: &AppHandle,
    channel: &str,
    provider_id: &str,
    run_id: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    value: Value,
    prompt_id: u64,
    permission_mode: &str,
) -> bool {
    if value.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        let request_id = value
            .get("id")
            .map(|id| id.to_string().trim_matches('"').to_string())
            .unwrap_or_else(|| "permission".into());
        let (payload, pending) =
            acp_approval_payload(provider_id, run_id, &request_id, &value, permission_mode);
        if let Some(pending) = pending {
            if let Ok(mut map) = permissions.lock() {
                map.insert(request_id, pending);
            }
            let _ = app.emit(channel, payload);
        } else {
            let _ = write_json(
                stdin,
                provider_id,
                &json!({"jsonrpc":"2.0","id":value.get("id").cloned().unwrap_or(Value::Null),"result":{"outcome":{"outcome":"cancelled"}}}),
            );
        }
        return false;
    }
    if value.get("method").and_then(Value::as_str) == Some("session/update") {
        let update = value.pointer("/params/update").unwrap_or(&Value::Null);
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk") {
            if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
            }
        }
        return false;
    }
    respond_to_unsupported_extension(stdin, provider_id, &value);
    if value.get("id").and_then(Value::as_u64) == Some(prompt_id) {
        if let Some(error) = value.pointer("/error/message").and_then(Value::as_str) {
            let message = safe_error_message(error, "Managed ACP execution failed.");
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
        } else {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
        }
        return true;
    }
    false
}

fn start_acp_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    let provider_id = request.provider_id.clone();
    if !ACP_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return Err("This provider does not use the managed ACP adapter.".into());
    }
    let workspace = workspace_dir(&app, &user_id, &provider_id)?;
    let mut child = crate::provider_process::SupervisedChild::spawn(acp_command(
        &app,
        &user_id,
        &provider_id,
        &workspace,
    )?)
    .map_err(|_| {
        format!(
            "Mivlet could not start {} ACP.",
            provider_label(&provider_id)
        )
    })?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
        format!("{} stdin was unavailable.", provider_label(&provider_id))
    })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{} stdout was unavailable.", provider_label(&provider_id)))?;
    let child = Arc::new(Mutex::new(child));
    let session_id = Arc::new(Mutex::new(None));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the managed ACP turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                provider_id: provider_id.clone(),
                stdin: Some(stdin.clone()),
                child: child.clone(),
                session_id: session_id.clone(),
                permissions: permissions.clone(),
                opencode: None,
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/{provider_id}/{request_id}");
    thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            write_json(&stdin, &provider_id, &initialize_request(1))?;
            let reader = BufReader::new(stdout);
            let prompt_id = 5_u64;
            for line in reader.lines() {
                let line = line.map_err(|_| {
                    format!("{} ACP stopped unexpectedly.", provider_label(&provider_id))
                })?;
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match value.get("id").and_then(Value::as_u64) {
                    Some(1) => {
                        validate_initialize(&provider_id, &value)?;
                        let models = extract_acp_models(&value);
                        let _ = cache_models(&app, &user_id, &provider_id, &models);
                        write_json(
                            &stdin,
                            &provider_id,
                            &json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":auth_method(&provider_id)}}),
                        )?;
                    }
                    Some(2) if value.get("error").is_none() => write_json(
                        &stdin,
                        &provider_id,
                        &json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":workspace,"mcpServers":[]}}),
                    )?,
                    Some(3) if value.get("error").is_none() => {
                        let sid = value
                            .pointer("/result/sessionId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                format!(
                                    "{} did not return an ACP session id.",
                                    provider_label(&provider_id)
                                )
                            })?
                            .to_string();
                        *session_id.lock().map_err(|_| {
                            format!(
                                "{} session state is unavailable.",
                                provider_label(&provider_id)
                            )
                        })? = Some(sid.clone());
                        let models = extract_acp_models(&value);
                        let _ = cache_models(&app, &user_id, &provider_id, &models);
                        let model = request.request.model.trim();
                        if !model.is_empty() && model != "default" && model != "grok-build" {
                            write_json(
                                &stdin,
                                &provider_id,
                                &json!({"jsonrpc":"2.0","id":4,"method":"session/set_model","params":{"sessionId":sid,"modelId":model}}),
                            )?;
                        } else {
                            let text = prompt_text(&request.request, &request.options);
                            write_json(
                                &stdin,
                                &provider_id,
                                &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":text}]}}),
                            )?;
                        }
                    }
                    Some(4) if value.get("error").is_none() => {
                        let sid = session_id
                            .lock()
                            .ok()
                            .and_then(|guard| guard.clone())
                            .ok_or_else(|| {
                                format!(
                                    "{} session state is unavailable.",
                                    provider_label(&provider_id)
                                )
                            })?;
                        let text = prompt_text(&request.request, &request.options);
                        write_json(
                            &stdin,
                            &provider_id,
                            &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":text}]}}),
                        )?;
                    }
                    Some(2..=4) => {
                        return Err(value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Managed ACP setup failed.")
                            .to_string())
                    }
                    _ => {}
                }
                if handle_acp_line(
                    &app,
                    &channel,
                    &provider_id,
                    &request_id,
                    &stdin,
                    &permissions,
                    value,
                    prompt_id,
                    request
                        .options
                        .permission_mode
                        .as_deref()
                        .unwrap_or("trusted-scope"),
                ) {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(message) = outcome {
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}

fn provider_tool_kind(tool_name: &str) -> &'static str {
    match tool_name.to_ascii_lowercase().as_str() {
        "read" => "read",
        "glob" | "grep" | "websearch" | "codesearch" => "search",
        "webfetch" => "fetch",
        "write" | "edit" | "multiedit" | "notebookedit" => "edit",
        "bash" | "shell" | "execute" => "execute",
        _ => "other",
    }
}

fn claude_approval_payload(
    run_id: &str,
    request_id: &str,
    value: &Value,
    mode: &str,
) -> Option<(Value, PendingPermission)> {
    let request = value.get("request")?;
    let tool_name = request.get("tool_name")?.as_str()?.trim();
    let tool_use_id = request.get("tool_use_id")?.as_str()?.trim().to_string();
    if tool_name.is_empty() || tool_use_id.is_empty() {
        return None;
    }
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    let title = request
        .get("title")
        .or_else(|| request.get("display_name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("use {tool_name}"));
    let payload = managed_approval_payload(
        "claude",
        run_id,
        request_id,
        &tool_use_id,
        provider_tool_kind(tool_name),
        &title,
        &input,
        mode,
    );
    Some((payload, PendingPermission::Claude { tool_use_id, input }))
}

fn respond_to_unsupported_claude_control(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) {
    let Some(request_id) = value.get("request_id").and_then(Value::as_str) else {
        return;
    };
    let _ = write_json(
        stdin,
        "claude",
        &json!({
            "type":"control_response",
            "response":{
                "subtype":"error",
                "request_id":request_id,
                "error":"Mivlet does not expose this Claude control surface."
            }
        }),
    );
}

fn handle_claude_line(
    app: &AppHandle,
    channel: &str,
    run_id: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    value: &Value,
    permission_mode: &str,
    emitted_text: &mut bool,
) -> bool {
    if value.get("type").and_then(Value::as_str) == Some("control_request") {
        let request_id = value
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("permission")
            .to_string();
        if value.pointer("/request/subtype").and_then(Value::as_str) == Some("can_use_tool") {
            if let Some((payload, pending)) =
                claude_approval_payload(run_id, &request_id, value, permission_mode)
            {
                if let Ok(mut map) = permissions.lock() {
                    map.insert(request_id, pending);
                }
                let _ = app.emit(channel, payload);
            } else {
                respond_to_unsupported_claude_control(stdin, value);
            }
        } else {
            respond_to_unsupported_claude_control(stdin, value);
        }
        return false;
    }
    if value.get("type").and_then(Value::as_str) == Some("control_cancel_request") {
        if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
            if let Ok(mut map) = permissions.lock() {
                map.remove(request_id);
            }
        }
        return false;
    }
    if value.get("type").and_then(Value::as_str) == Some("stream_event")
        && value.pointer("/event/delta/type").and_then(Value::as_str) == Some("text_delta")
    {
        if let Some(text) = value.pointer("/event/delta/text").and_then(Value::as_str) {
            *emitted_text = true;
            let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("result") {
        if !*emitted_text {
            if let Some(text) = value.get("result").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
            }
        }
        let input = value
            .pointer("/usage/input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let output = value
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let cost = value.get("total_cost_usd").and_then(Value::as_f64);
        if input > 0 || output > 0 || cost.is_some() {
            let _ = app.emit(
                channel,
                json!({"type":"usage","inputTokens":input,"outputTokens":output,"costUsd":cost}),
            );
        }
        if value.get("is_error").and_then(Value::as_bool) == Some(true) {
            let provider_message = value
                .get("result")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/errors/0").and_then(Value::as_str))
                .unwrap_or("Claude execution failed.");
            let message = safe_error_message(provider_message, "Claude execution failed.");
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
        } else {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
        }
        return true;
    }
    false
}

fn start_claude_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    let provider_id = request.provider_id.clone();
    if provider_id != "claude" {
        return Err("This provider does not use the Claude agent adapter.".into());
    }
    let path = find_executable(&provider_id)
        .ok_or_else(|| "Install the official Claude runtime first.".to_string())?;
    let workspace = workspace_dir(&app, &user_id, &provider_id)?;
    let prompt = prompt_text(&request.request, &request.options);
    let mut command = command_for_provider(&app, &user_id, &provider_id, &path)?;
    command.args([
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
        "--setting-sources=",
        "--strict-mcp-config",
        "--mcp-config",
        "{}",
    ]);
    let model = request.request.model.trim();
    if !model.is_empty() {
        command.args(["--model", model]);
    }
    command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start Claude.".to_string())?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Claude stdin was unavailable.".to_string())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Claude stderr was unavailable.".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the Claude turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                provider_id: provider_id.clone(),
                stdin: Some(stdin.clone()),
                child: child.clone(),
                session_id: Arc::new(Mutex::new(None)),
                permissions: permissions.clone(),
                opencode: None,
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/{provider_id}/{request_id}");
    thread::spawn(move || {
        let stderr_thread = thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT));
        let initialize_id = format!("mivlet-init-{request_id}");
        let mut prompt_sent = false;
        let mut completed = false;
        let mut emitted_text = false;
        let initialize = json!({
            "type":"control_request",
            "request_id":initialize_id,
            "request":{"subtype":"initialize"}
        });
        if let Err(message) = write_json(&stdin, "claude", &initialize) {
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
        }
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if !prompt_sent
                && value.get("type").and_then(Value::as_str) == Some("control_response")
                && value
                    .pointer("/response/request_id")
                    .and_then(Value::as_str)
                    == Some(initialize_id.as_str())
            {
                if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
                    let _ = app.emit(
                        &channel,
                        json!({"type":"error","message":"Claude rejected Mivlet's SDK initialization."}),
                    );
                    break;
                }
                let message = json!({
                    "type":"user",
                    "session_id":"",
                    "message":{"role":"user","content":[{"type":"text","text":prompt}]},
                    "parent_tool_use_id":Value::Null
                });
                if write_json(&stdin, "claude", &message).is_err() {
                    break;
                }
                prompt_sent = true;
                continue;
            }
            if handle_claude_line(
                &app,
                &channel,
                &request_id,
                &stdin,
                &permissions,
                &value,
                request
                    .options
                    .permission_mode
                    .as_deref()
                    .unwrap_or("trusted-scope"),
                &mut emitted_text,
            ) {
                completed = true;
                break;
            }
        }
        if let Ok(mut provider_child) = child.lock() {
            let _ = provider_child.kill();
        }
        let _ = child.lock().ok().and_then(|mut child| child.wait().ok());
        let stderr_text = stderr_thread.join().unwrap_or_default();
        if !completed {
            let message = safe_error_message(&stderr_text, "Claude execution failed.");
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}

fn open_code_endpoint(base_url: &str, segments: &[&str]) -> Result<String, String> {
    let mut url = url::Url::parse(base_url)
        .map_err(|_| "Mivlet could not construct the OpenCode server URL.".to_string())?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "Mivlet could not construct the OpenCode server URL.".to_string())?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url.into())
}

fn open_code_password() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not secure the local OpenCode server.".to_string())?;
    Ok(hex::encode(bytes))
}

fn open_code_rules() -> Value {
    json!([
        {"permission":"*","pattern":"*","action":"ask"},
        {"permission":"bash","pattern":"*","action":"ask"},
        {"permission":"edit","pattern":"*","action":"ask"},
        {"permission":"external_directory","pattern":"*","action":"ask"},
        {"permission":"question","pattern":"*","action":"deny"}
    ])
}

async fn open_code_error(mut response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok().flatten() {
        let remaining = MAX_COMMAND_OUTPUT.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() == MAX_COMMAND_OUTPUT {
            break;
        }
    }
    let body = String::from_utf8_lossy(&body);
    let detail = safe_error_message(&body, fallback);
    format!("{detail} (OpenCode HTTP {status})")
}

async fn wait_for_open_code(
    client: &reqwest::Client,
    control: &OpenCodeControl,
) -> Result<(), String> {
    let health = open_code_endpoint(&control.base_url, &["global", "health"])?;
    for _ in 0..50 {
        if client
            .get(&health)
            .header("Authorization", &control.authorization)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("OpenCode's local server did not become ready.".to_string())
}

fn sse_frames(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut values = Vec::new();
    loop {
        let lf = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|position| (position, 2));
        let crlf = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| (position, 4));
        let Some((end, delimiter_length)) = (match (lf, crlf) {
            (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
            (Some(found), None) | (None, Some(found)) => Some(found),
            (None, None) => None,
        }) else {
            break;
        };
        let frame = buffer.drain(..end + delimiter_length).collect::<Vec<_>>();
        let Ok(frame) = std::str::from_utf8(&frame) else {
            continue;
        };
        let data = frame
            .lines()
            .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if !data.is_empty() && data != "[DONE]" {
            if let Ok(value) = serde_json::from_str(&data) {
                values.push(value);
            }
        }
    }
    values
}

#[derive(Default)]
struct OpenCodeStreamState {
    assistant_messages: HashSet<String>,
    emitted_usage: HashSet<String>,
    text_by_part: HashMap<String, String>,
    observed_activity: bool,
    awaiting_busy_after_permission: bool,
    pending_permission_count: usize,
}

fn open_code_event_session_id(value: &Value) -> Option<&str> {
    value
        .pointer("/properties/sessionID")
        .or_else(|| value.pointer("/properties/info/sessionID"))
        .or_else(|| value.pointer("/properties/part/sessionID"))
        .and_then(Value::as_str)
}

fn open_code_event_error(value: &Value) -> String {
    let candidate = value
        .pointer("/properties/error/data/message")
        .or_else(|| value.pointer("/properties/error/message"))
        .or_else(|| value.pointer("/properties/error/name"))
        .and_then(Value::as_str)
        .unwrap_or("OpenCode execution failed.");
    safe_error_message(candidate, "OpenCode execution failed.")
}

fn handle_open_code_event(
    app: &AppHandle,
    channel: &str,
    run_id: &str,
    session_id: &str,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    permission_mode: &str,
    value: &Value,
    state: &mut OpenCodeStreamState,
) -> bool {
    if open_code_event_session_id(value).is_some_and(|candidate| candidate != session_id) {
        return false;
    }
    match value.get("type").and_then(Value::as_str) {
        Some("message.updated") => {
            let info = value.pointer("/properties/info").unwrap_or(&Value::Null);
            let message_id = info.get("id").and_then(Value::as_str).unwrap_or_default();
            if info.get("role").and_then(Value::as_str) == Some("assistant") {
                state.observed_activity = true;
                state.awaiting_busy_after_permission = false;
                state.assistant_messages.insert(message_id.to_string());
                if info.get("error").is_some_and(|error| !error.is_null()) {
                    let message =
                        open_code_event_error(&json!({"properties":{"error":info.get("error")}}));
                    let _ = app.emit(channel, json!({"type":"error","message":message}));
                    let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
                    return true;
                }
                if info.pointer("/time/completed").is_some()
                    && state.emitted_usage.insert(message_id.to_string())
                {
                    let input = info
                        .pointer("/tokens/input")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    let output = info
                        .pointer("/tokens/output")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    let cost = info.get("cost").and_then(Value::as_f64);
                    if input > 0 || output > 0 || cost.is_some() {
                        let _ = app.emit(channel, json!({"type":"usage","inputTokens":input,"outputTokens":output,"costUsd":cost}));
                    }
                }
            }
        }
        Some("message.part.delta") => {
            let message_id = value
                .pointer("/properties/messageID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.assistant_messages.contains(message_id)
                && value.pointer("/properties/field").and_then(Value::as_str) == Some("text")
            {
                let part_id = value
                    .pointer("/properties/partID")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let delta = value
                    .pointer("/properties/delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !delta.is_empty() {
                    state.observed_activity = true;
                    state.awaiting_busy_after_permission = false;
                    state
                        .text_by_part
                        .entry(part_id.to_string())
                        .or_default()
                        .push_str(delta);
                    let _ = app.emit(channel, json!({"type":"text-delta","text":delta}));
                }
            }
        }
        Some("message.part.updated") => {
            let part = value.pointer("/properties/part").unwrap_or(&Value::Null);
            let message_id = part
                .get("messageID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.assistant_messages.contains(message_id)
                && part.get("type").and_then(Value::as_str) == Some("text")
                && part.get("synthetic").and_then(Value::as_bool) != Some(true)
            {
                let part_id = part.get("id").and_then(Value::as_str).unwrap_or_default();
                let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
                let previous = state
                    .text_by_part
                    .get(part_id)
                    .map(String::as_str)
                    .unwrap_or_default();
                let delta = text.strip_prefix(previous).unwrap_or_default();
                if !delta.is_empty() {
                    state.observed_activity = true;
                    state.awaiting_busy_after_permission = false;
                    let _ = app.emit(channel, json!({"type":"text-delta","text":delta}));
                }
                state
                    .text_by_part
                    .insert(part_id.to_string(), text.to_string());
            }
        }
        Some("permission.asked") => {
            state.observed_activity = true;
            let properties = value.get("properties").unwrap_or(&Value::Null);
            let permission_id = properties
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if permission_id.is_empty() {
                return false;
            }
            let permission = properties
                .get("permission")
                .and_then(Value::as_str)
                .unwrap_or("other");
            let call_id = properties
                .pointer("/tool/callID")
                .and_then(Value::as_str)
                .unwrap_or(permission_id);
            let detail = json!({
                "patterns":properties.get("patterns").cloned().unwrap_or_else(|| json!([])),
                "metadata":properties.get("metadata").cloned().unwrap_or_else(|| json!({}))
            });
            let title = format!("use {permission}");
            let payload = managed_approval_payload(
                "opencode",
                run_id,
                permission_id,
                call_id,
                provider_tool_kind(permission),
                &title,
                &detail,
                permission_mode,
            );
            if let Ok(mut map) = permissions.lock() {
                if map
                    .insert(permission_id.to_string(), PendingPermission::OpenCode)
                    .is_none()
                {
                    state.pending_permission_count += 1;
                }
            }
            let _ = app.emit(channel, payload);
        }
        Some("permission.replied") => {
            if let Some(permission_id) = value
                .pointer("/properties/requestID")
                .and_then(Value::as_str)
            {
                if let Ok(mut map) = permissions.lock() {
                    map.remove(permission_id);
                }
            }
            state.pending_permission_count = state.pending_permission_count.saturating_sub(1);
            state.awaiting_busy_after_permission =
                value.pointer("/properties/reply").and_then(Value::as_str) != Some("reject");
        }
        Some("session.error") => {
            let message = open_code_event_error(value);
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
            return true;
        }
        Some("session.status") => {
            let status = value
                .pointer("/properties/status/type")
                .and_then(Value::as_str);
            if status == Some("busy") {
                state.observed_activity = true;
                state.awaiting_busy_after_permission = false;
            } else if status == Some("idle")
                && state.observed_activity
                && !state.awaiting_busy_after_permission
                && state.pending_permission_count == 0
            {
                let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
                return true;
            }
        }
        Some("session.idle")
            if state.observed_activity
                && !state.awaiting_busy_after_permission
                && state.pending_permission_count == 0 =>
        {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
            return true;
        }
        _ => {}
    }
    false
}

fn start_opencode_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    if request.provider_id != "opencode" {
        return Err("This provider does not use the OpenCode server adapter.".into());
    }
    let path = find_executable("opencode")
        .ok_or_else(|| "Install the official OpenCode runtime first.".to_string())?;
    let workspace = workspace_dir(&app, &user_id, "opencode")?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Mivlet could not reserve a local OpenCode port.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Mivlet could not reserve a local OpenCode port.".to_string())?
        .port();
    drop(listener);
    let password = open_code_password()?;
    let authorization = format!(
        "Basic {}",
        BASE64_STANDARD.encode(format!("opencode:{password}"))
    );
    let control = OpenCodeControl {
        base_url: format!("http://127.0.0.1:{port}"),
        authorization,
        directory: workspace.to_string_lossy().into_owned(),
    };
    let mut command = command_for_provider(&app, &user_id, "opencode", &path)?;
    command
        .env("OPENCODE_SERVER_PASSWORD", password)
        .arg("serve")
        .arg("--pure")
        .arg("--hostname=127.0.0.1")
        .arg(format!("--port={port}"))
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start OpenCode's local server.".to_string())?;
    let stdout = process.stdout.take();
    let stderr = process.stderr.take();
    let child = Arc::new(Mutex::new(process));
    let session_id = Arc::new(Mutex::new(None));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the OpenCode turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                provider_id: "opencode".to_string(),
                stdin: None,
                child: child.clone(),
                session_id: session_id.clone(),
                permissions: permissions.clone(),
                opencode: Some(control.clone()),
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/opencode/{request_id}");
    tauri::async_runtime::spawn(async move {
        let stdout_thread =
            stdout.map(|stdout| thread::spawn(move || read_limited(stdout, MAX_COMMAND_OUTPUT)));
        let stderr_thread =
            stderr.map(|stderr| thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT)));
        let outcome = async {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .build()
                .map_err(|_| "Mivlet could not prepare the OpenCode client.".to_string())?;
            wait_for_open_code(&client, &control).await?;
            let event_url = open_code_endpoint(&control.base_url, &["event"])?;
            let events = client
                .get(event_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .send()
                .await
                .map_err(|_| "Mivlet could not subscribe to OpenCode events.".to_string())?;
            if !events.status().is_success() {
                return Err(
                    open_code_error(events, "OpenCode rejected its event subscription.").await,
                );
            }
            let session_url = open_code_endpoint(&control.base_url, &["session"])?;
            let created = client
                .post(session_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .json(&json!({"title":"Mivlet conversation","permission":open_code_rules()}))
                .send()
                .await
                .map_err(|_| "Mivlet could not create an OpenCode session.".to_string())?;
            if !created.status().is_success() {
                return Err(open_code_error(created, "OpenCode rejected session creation.").await);
            }
            let created: Value = created
                .json()
                .await
                .map_err(|_| "OpenCode returned an invalid session.".to_string())?;
            let sid = created
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "OpenCode returned no session id.".to_string())?
                .to_string();
            if let Ok(mut current) = session_id.lock() {
                *current = Some(sid.clone());
            }
            let prompt_url =
                open_code_endpoint(&control.base_url, &["session", &sid, "prompt_async"])?;
            let prompt = prompt_text(&request.request, &request.options);
            let mut body = json!({"parts":[{"type":"text","text":prompt}]});
            if let Some((provider_id, model_id)) = request.request.model.split_once('/') {
                if !provider_id.trim().is_empty() && !model_id.trim().is_empty() {
                    body["model"] = json!({"providerID":provider_id,"modelID":model_id});
                }
            }
            let accepted = client
                .post(prompt_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .json(&body)
                .send()
                .await
                .map_err(|_| "Mivlet could not submit the OpenCode prompt.".to_string())?;
            if !accepted.status().is_success() {
                return Err(open_code_error(accepted, "OpenCode rejected the prompt.").await);
            }
            let mut bytes = events.bytes_stream();
            let mut buffer = Vec::new();
            let mut state = OpenCodeStreamState::default();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk
                    .map_err(|_| "OpenCode's event stream stopped unexpectedly.".to_string())?;
                buffer.extend_from_slice(&chunk);
                for event in sse_frames(&mut buffer) {
                    if handle_open_code_event(
                        &app,
                        &channel,
                        &request_id,
                        &sid,
                        &permissions,
                        request
                            .options
                            .permission_mode
                            .as_deref()
                            .unwrap_or("trusted-scope"),
                        &event,
                        &mut state,
                    ) {
                        return Ok(());
                    }
                }
                if buffer.len() > MAX_COMMAND_OUTPUT {
                    return Err("OpenCode sent an oversized event frame.".to_string());
                }
            }
            Err("OpenCode's event stream ended before the turn completed.".to_string())
        }
        .await;
        if let Err(message) = outcome {
            let message = safe_error_message(&message, "OpenCode execution failed.");
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut server) = child.lock() {
            let _ = server.kill();
        }
        let _ = child.lock().ok().and_then(|mut server| server.wait().ok());
        let _ = stdout_thread.map(|reader| reader.join());
        let _ = stderr_thread.map(|reader| reader.join());
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}

#[tauri::command]
pub fn start_managed_runtime_turn(
    app: AppHandle,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    validate_provider_id(&request.provider_id)?;
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
        PendingPermission::Claude { tool_use_id, input } => {
            let stdin = stdin
                .as_ref()
                .ok_or_else(|| "This Claude run no longer accepts approvals.".to_string())?;
            let response = if request.approved {
                json!({"behavior":"allow","updatedInput":input,"toolUseID":tool_use_id})
            } else {
                json!({"behavior":"deny","message":"Denied in Mivlet.","interrupt":false,"toolUseID":tool_use_id})
            };
            write_json(
                stdin,
                "claude",
                &json!({
                    "type":"control_response",
                    "response":{
                        "subtype":"success",
                        "request_id":request.approval_request_id,
                        "response":response
                    }
                }),
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
        if let Some(stdin) = stdin.as_ref() {
            write_json(
                stdin,
                "claude",
                &json!({"type":"control_request","request_id":format!("mivlet-interrupt-{request_id}"),"request":{"subtype":"interrupt","cancel_queued":true}}),
            )?;
        }
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
mod tests {
    use super::*;

    #[test]
    fn parses_grok_login_and_model_output_without_account_details() {
        let (authenticated, models) = parse_grok_models(
            "You are logged in with grok.com.\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
        );
        assert_eq!(authenticated, Some(true));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "grok-4.6");
    }

    #[test]
    fn parses_only_bounded_opencode_model_identifiers() {
        let models =
            parse_opencode_models("openai/gpt-5.5\nanthropic/claude-sonnet-4-6\nnot-a-model\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].id, "anthropic/claude-sonnet-4-6");
    }

    #[test]
    fn acp_model_discovery_supports_standard_session_state() {
        let models = extract_acp_models(&json!({
            "result": {
                "models": {
                    "currentModelId": "example-1",
                    "availableModels": [{"modelId":"example-1","name":"Example 1"}]
                }
            }
        }));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label, "Example 1");
    }

    #[test]
    fn approval_payload_redacts_secret_fields() {
        let request = json!({"params":{"toolCall":{"toolCallId":"call-1","title":"Run command","kind":"execute","rawInput":{"token":"super-secret-value","command":"status"}},"options":[{"optionId":"allow-once","kind":"allow_once"},{"optionId":"reject-once","kind":"reject_once"}]}});
        let (payload, pending) =
            acp_approval_payload("cursor", "run-1", "7", &request, "full-access");
        let encoded = payload.to_string();
        assert!(!encoded.contains("super-secret-value"));
        assert!(encoded.contains("approve cursor action"));
        assert!(matches!(
            pending,
            Some(PendingPermission::Acp { allow_option, .. }) if allow_option == "allow-once"
        ));
    }

    #[test]
    fn claude_permission_payload_preserves_native_reply_without_exposing_secrets() {
        let request = json!({
            "type":"control_request",
            "request_id":"permission-1",
            "request":{
                "subtype":"can_use_tool",
                "tool_name":"Bash",
                "tool_use_id":"tool-1",
                "input":{"command":"status","api_key":"super-secret-value"}
            }
        });
        let (payload, pending) =
            claude_approval_payload("run-1", "permission-1", &request, "trusted-scope")
                .expect("valid Claude permission");
        assert_eq!(
            payload.get("tool").and_then(Value::as_str),
            Some("claude:execute")
        );
        assert!(!payload.to_string().contains("super-secret-value"));
        assert!(matches!(
            pending,
            PendingPermission::Claude { tool_use_id, input }
                if tool_use_id == "tool-1" && input["api_key"] == "super-secret-value"
        ));
    }

    #[test]
    fn parses_fragmented_open_code_sse_frames() {
        let mut buffer = b"data: {\"type\":\"session.status\",\"properties\":{".to_vec();
        assert!(sse_frames(&mut buffer).is_empty());
        buffer.extend_from_slice(b"\"status\":{\"type\":\"busy\"}}}\n\ndata: [DONE]\n\n");
        let events = sse_frames(&mut buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("type").and_then(Value::as_str),
            Some("session.status")
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn open_code_endpoints_encode_provider_owned_identifiers() {
        let endpoint = open_code_endpoint(
            "http://127.0.0.1:4096",
            &["permission", "permission/with spaces", "reply"],
        )
        .expect("valid endpoint");
        assert_eq!(
            endpoint,
            "http://127.0.0.1:4096/permission/permission%2Fwith%20spaces/reply"
        );
    }

    #[test]
    fn provider_errors_are_redacted_before_crossing_the_native_boundary() {
        assert_eq!(
            safe_error_message("Authorization: Bearer secret-value", "Provider failed."),
            "[redacted]"
        );
        assert_eq!(
            safe_error_message("Request failed safely", "Provider failed."),
            "Request failed safely"
        );
    }
}
