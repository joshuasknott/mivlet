//! Google Antigravity ACP boundary.
//!
//! Mivlet installs and supervises Google's published Antigravity ACP agent. The
//! agent owns Google authentication inside an account-scoped profile; Mivlet
//! only observes connection state, model metadata, streamed text, and explicit
//! permission requests. OAuth material never crosses the Tauri boundary.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use crate::provider_process::SupervisedChild;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use url::Url;

use crate::models::{BackendModel, BackendVerifyResult};

pub const PROVIDER_ID: &str = "antigravity";
const VERSION: &str = "1.1.1";
const ARCHIVE_URL: &str = "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip";
const ARCHIVE_SHA256: &str = "47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8";
const ARCHIVE_BYTES: u64 = 468_238_392;
const SERVER_BYTES: u64 = 430_801_616;
const HARNESS_BYTES: u64 = 130_971_800;
const AUTH_PREFIX: &str = "Open the following link to authenticate the ACP server: ";
const START_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy)]
enum BrowserBehavior {
    OpenValidated,
    Suppress,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityStatus {
    pub(crate) installed: bool,
    pub(crate) authenticated: bool,
    pub(crate) version: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityInstallResult {
    provider_id: &'static str,
    version: &'static str,
    installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginResult {
    provider_id: &'static str,
    outcome: &'static str,
    message: &'static str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityTurnRequest {
    request_id: String,
    provider_id: String,
    request: AntigravityAgentRequest,
    options: AntigravityTurnOptions,
}

#[derive(Clone, Debug, Deserialize)]
struct AntigravityAgentRequest {
    model: String,
    messages: Vec<AntigravityMessage>,
}

#[derive(Clone, Debug, Deserialize)]
struct AntigravityMessage {
    role: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityTurnOptions {
    context_prefix: Option<String>,
    permission_mode: Option<String>,
    #[serde(rename = "runId")]
    _run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityApprovalResponse {
    request_id: String,
    approval_request_id: String,
    approved: bool,
}

struct PendingPermission {
    allow_option: Option<String>,
    reject_option: Option<String>,
}

struct ActiveRun {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<SupervisedChild>>,
    session_id: Arc<Mutex<Option<String>>>,
    permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveRun>>> = OnceLock::new();

fn active_runs() -> &'static Mutex<HashMap<String, ActiveRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn account_hash(user_id: &str) -> String {
    hex::encode(Sha256::digest(user_id.as_bytes()))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir(app)?.join("antigravity"))
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join("runtime").join(VERSION))
}

fn server_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join("agy_acp_server.exe"))
}

fn harness_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join("localharness_external.exe"))
}

fn profile_dir(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join("profiles").join(account_hash(user_id)))
}

fn workspace_dir(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join("workspaces").join(account_hash(user_id)))
}

fn models_path(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    Ok(profile_dir(app, user_id)?.join("models.json"))
}

fn runtime_installed(app: &AppHandle) -> bool {
    let Ok(server) = server_path(app) else {
        return false;
    };
    let Ok(harness) = harness_path(app) else {
        return false;
    };
    fs::metadata(server)
        .map(|m| m.len() == SERVER_BYTES)
        .unwrap_or(false)
        && fs::metadata(harness)
            .map(|m| m.len() == HARNESS_BYTES)
            .unwrap_or(false)
}

pub(crate) fn status_for(app: &AppHandle, authenticated: bool) -> AntigravityStatus {
    let installed = runtime_installed(app);
    AntigravityStatus {
        installed,
        authenticated: installed && authenticated,
        version: installed.then(|| VERSION.to_string()),
        message: (!installed).then(|| {
            "Install Google's official Antigravity ACP runtime from Mivlet, then continue with Google.".to_string()
        }),
    }
}

#[tauri::command]
pub fn antigravity_status(app: AppHandle) -> Result<AntigravityStatus, String> {
    let user_id = crate::backends::require_current_internal_user()?;
    let connected = crate::backends::connected_providers_for(&user_id)?;
    Ok(status_for(
        &app,
        connected.iter().any(|id| id == PROVIDER_ID),
    ))
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
#[tauri::command]
pub async fn install_antigravity_runtime(
    _app: AppHandle,
) -> Result<AntigravityInstallResult, String> {
    Err("The managed Antigravity installer currently supports Windows x64 only.".into())
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
#[tauri::command]
pub async fn install_antigravity_runtime(
    app: AppHandle,
) -> Result<AntigravityInstallResult, String> {
    if runtime_installed(&app) {
        return Ok(AntigravityInstallResult {
            provider_id: PROVIDER_ID,
            version: VERSION,
            installed: true,
        });
    }
    let base = root(&app)?;
    fs::create_dir_all(&base)
        .map_err(|_| "Mivlet could not prepare the Antigravity runtime directory.".to_string())?;
    let archive_path = base.join(format!("antigravity-{VERSION}.download"));
    let mut response = reqwest::Client::new()
        .get(ARCHIVE_URL)
        .send()
        .await
        .map_err(|_| "Mivlet could not download the Antigravity runtime.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Google returned HTTP {} for the Antigravity runtime.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != ARCHIVE_BYTES)
    {
        return Err("The Antigravity download size did not match the pinned release.".into());
    }
    let mut archive = fs::File::create(&archive_path)
        .map_err(|_| "Mivlet could not create the Antigravity download file.".to_string())?;
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The Antigravity download was interrupted.".to_string())?
    {
        total = total.saturating_add(chunk.len() as u64);
        if total > ARCHIVE_BYTES {
            let _ = fs::remove_file(&archive_path);
            return Err("The Antigravity download exceeded the pinned release size.".into());
        }
        hash.update(&chunk);
        archive
            .write_all(&chunk)
            .map_err(|_| "Mivlet could not save the Antigravity download.".to_string())?;
    }
    archive
        .flush()
        .map_err(|_| "Mivlet could not finish the Antigravity download.".to_string())?;
    drop(archive);
    let digest = hex::encode(hash.finalize());
    if total != ARCHIVE_BYTES || digest != ARCHIVE_SHA256 {
        let _ = fs::remove_file(&archive_path);
        return Err("The Antigravity download did not match the pinned Google release.".into());
    }

    let staging = base.join(format!("runtime-{VERSION}-staging"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|_| {
            "Mivlet could not replace an incomplete Antigravity install.".to_string()
        })?;
    }
    fs::create_dir_all(&staging)
        .map_err(|_| "Mivlet could not prepare the Antigravity install.".to_string())?;
    let file = fs::File::open(&archive_path)
        .map_err(|_| "Mivlet could not reopen the Antigravity download.".to_string())?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "Google's Antigravity archive was not a valid ZIP file.".to_string())?;
    for (name, expected) in [
        ("agy_acp_server.exe", SERVER_BYTES),
        ("localharness_external.exe", HARNESS_BYTES),
    ] {
        let mut entry = zip
            .by_name(name)
            .map_err(|_| format!("Google's Antigravity archive did not contain {name}."))?;
        if entry.size() != expected {
            return Err(format!("{name} did not match the pinned release."));
        }
        let mut output = fs::File::create(staging.join(name))
            .map_err(|_| format!("Mivlet could not install {name}."))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|_| format!("Mivlet could not extract {name}."))?;
    }
    let final_dir = runtime_dir(&app)?;
    if let Some(parent) = final_dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Mivlet could not prepare the runtime folder.".to_string())?;
    }
    if final_dir.exists() {
        fs::remove_dir_all(&final_dir)
            .map_err(|_| "Mivlet could not replace the Antigravity runtime.".to_string())?;
    }
    fs::rename(&staging, &final_dir)
        .map_err(|_| "Mivlet could not finish installing Antigravity.".to_string())?;
    let _ = fs::remove_file(&archive_path);
    Ok(AntigravityInstallResult {
        provider_id: PROVIDER_ID,
        version: VERSION,
        installed: true,
    })
}

fn prepare_profile(app: &AppHandle, user_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let profile = profile_dir(app, user_id)?;
    let workspace = workspace_dir(app, user_id)?;
    fs::create_dir_all(profile.join("antigravity-acp"))
        .and_then(|_| fs::create_dir_all(&workspace))
        .map_err(|_| "Mivlet could not prepare the private Antigravity profile.".to_string())?;
    fs::write(
        profile.join("antigravity-acp").join("settings.json"),
        b"{\"auth\":{\"type\":\"oauth-personal\"}}",
    )
    .map_err(|_| "Mivlet could not configure Antigravity personal Google sign-in.".to_string())?;
    Ok((profile, workspace))
}

fn browser_helper_command(behavior: BrowserBehavior) -> Result<String, String> {
    let current_exe = std::env::current_exe()
        .map_err(|_| "Mivlet could not locate its browser helper.".to_string())?;
    // Python's browser helper parser uses POSIX-style command splitting even
    // on Windows. Forward slashes keep an absolute Windows path intact.
    let helper = current_exe.to_string_lossy().replace('\\', "/");
    let path_separator = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    if helper.contains(['"', '\r', '\n', '\0', path_separator]) || helper.contains("%s") {
        return Err("Mivlet's runtime path cannot safely launch Google sign-in.".into());
    }
    let mode = match behavior {
        BrowserBehavior::OpenValidated => "--antigravity-browser-open",
        BrowserBehavior::Suppress => "--antigravity-browser-suppress",
    };
    Ok(format!("\"{helper}\" {mode} %s"))
}

fn command(
    app: &AppHandle,
    user_id: &str,
    browser_behavior: BrowserBehavior,
) -> Result<Command, String> {
    if !runtime_installed(app) {
        return Err("Install the Antigravity ACP runtime before connecting Google.".into());
    }
    let (profile, _) = prepare_profile(app, user_id)?;
    let mut command = Command::new(server_path(app)?);
    for key in [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GCLOUD_PROJECT",
        "CLOUDSDK_CORE_PROJECT",
        "AGY_ACP_CCPA_PROJECT",
        "AGY_ACP_ENABLE_OAUTH",
        "GEMINI_HOME",
        "AGY_ACP_FORCE_FILE_STORAGE",
        "ANTIGRAVITY_HARNESS_PATH",
        "BROWSER",
        "PYTHONUNBUFFERED",
        "ELECTRON_RUN_AS_NODE",
    ] {
        command.env_remove(key);
    }
    command
        .env("GEMINI_HOME", profile)
        .env("AGY_ACP_FORCE_FILE_STORAGE", "1")
        .env("ANTIGRAVITY_HARNESS_PATH", harness_path(app)?)
        .env("BROWSER", browser_helper_command(browser_behavior)?)
        .env("PYTHONUNBUFFERED", "1")
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    Ok(command)
}

fn write_json(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut input = stdin
        .lock()
        .map_err(|_| "Antigravity stdin is unavailable.".to_string())?;
    serde_json::to_writer(&mut *input, value)
        .map_err(|_| "Mivlet could not encode an ACP request.".to_string())?;
    input
        .write_all(b"\n")
        .and_then(|_| input.flush())
        .map_err(|_| "Mivlet could not write to Antigravity ACP.".to_string())
}

fn initialize_request(id: u64) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"Mivlet","title":"Mivlet","version":env!("CARGO_PKG_VERSION")}}})
}

fn validate_initialize(value: &Value) -> Result<(), String> {
    let name = value
        .pointer("/result/agentInfo/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = value
        .pointer("/result/agentInfo/version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let protocol = value
        .pointer("/result/protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let supports_personal = value
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods.iter().any(|method| {
                method.as_str() == Some("oauth-personal")
                    || method.get("id").and_then(Value::as_str) == Some("oauth-personal")
            })
        });
    let version_matches =
        version == VERSION || version.strip_prefix("agy_acp_server_") == Some(VERSION);
    if name == "antigravity-acp" && version_matches && protocol == 1 && supports_personal {
        Ok(())
    } else {
        Err("The installed process did not identify as the pinned Antigravity ACP agent with personal Google sign-in.".into())
    }
}

fn authentication_error(value: &Value) -> String {
    let reason = value
        .pointer("/error/data/reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if reason == "onboarding_failed" || message.contains("ineligible") {
        return "Google sign-in completed, but Antigravity could not finish account setup. Check that this Google account is eligible for Antigravity and has any required age verification, then try again.".into();
    }
    if message.contains("access_denied") || message.contains("cancel") {
        return "Google sign-in was cancelled. Try again when you're ready.".into();
    }
    "Antigravity could not complete Google sign-in. Try again or choose a different Google account."
        .into()
}

fn validate_auth_url(raw: &str) -> Result<String, String> {
    if raw.len() > 8192 {
        return Err("Antigravity returned an invalid Google sign-in address.".into());
    }
    let url = Url::parse(raw)
        .map_err(|_| "Antigravity returned an invalid Google sign-in address.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("accounts.google.com")
        || url.path() != "/o/oauth2/v2/auth"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Antigravity returned an untrusted Google sign-in address.".into());
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    for required in ["state", "redirect_uri"] {
        if pairs.iter().filter(|(key, _)| key == required).count() != 1 {
            return Err("Antigravity returned an incomplete Google sign-in address.".into());
        }
    }
    if !pairs
        .iter()
        .any(|(key, value)| key == "response_type" && value == "code")
    {
        return Err("Antigravity returned an unsupported Google sign-in flow.".into());
    }
    let redirect = pairs
        .iter()
        .find(|(key, _)| key == "redirect_uri")
        .map(|(_, value)| value.as_ref())
        .unwrap_or_default();
    let callback = Url::parse(redirect)
        .map_err(|_| "Antigravity returned an invalid loopback callback.".to_string())?;
    if callback.scheme() != "http"
        || callback.host_str() != Some("127.0.0.1")
        || callback.port().unwrap_or(0) < 1024
        || callback.path() != "/"
        || callback.query().is_some()
        || callback.fragment().is_some()
    {
        return Err("Antigravity returned an unsafe Google sign-in callback.".into());
    }
    Ok(url.to_string())
}

fn extract_models(value: &Value) -> Vec<BackendModel> {
    let result = value.get("result").unwrap_or(value);
    let direct = result
        .pointer("/models/availableModels")
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
            if id.is_empty() {
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

fn cache_models(app: &AppHandle, user_id: &str, models: &[BackendModel]) -> Result<(), String> {
    if models.is_empty() {
        return Ok(());
    }
    let path = models_path(app, user_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Mivlet could not prepare the Antigravity model cache.".to_string())?;
    }
    let bytes = serde_json::to_vec(models)
        .map_err(|_| "Mivlet could not encode Antigravity models.".to_string())?;
    fs::write(path, bytes).map_err(|_| "Mivlet could not cache Antigravity models.".to_string())
}

pub(crate) fn cached_models(app: &AppHandle, user_id: &str) -> Vec<BackendModel> {
    models_path(app, user_id)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn connect_process(
    app: &AppHandle,
    user_id: &str,
    open_browser: bool,
) -> Result<Vec<BackendModel>, String> {
    let browser_behavior = if open_browser {
        BrowserBehavior::OpenValidated
    } else {
        BrowserBehavior::Suppress
    };
    let mut child = SupervisedChild::spawn(command(app, user_id, browser_behavior)?)?;
    let stdin =
        Arc::new(Mutex::new(child.child.stdin.take().ok_or_else(|| {
            "Antigravity stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .child
        .stdout
        .take()
        .ok_or_else(|| "Antigravity stdout was unavailable.".to_string())?;
    let result = (|| -> Result<Vec<BackendModel>, String> {
        write_json(&stdin, &initialize_request(1))?;
        let started = Instant::now();
        let mut initialized = false;
        let mut authenticated = false;
        let mut session_sent = false;
        let mut models = Vec::new();
        let (line_tx, line_rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line_tx
                    .send(line.map_err(|_| "Antigravity ACP stopped unexpectedly.".to_string()))
                    .is_err()
                {
                    break;
                }
            }
        });
        loop {
            let limit = if initialized {
                AUTH_TIMEOUT
            } else {
                START_TIMEOUT
            };
            let remaining = limit.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err("Antigravity sign-in timed out.".into());
            }
            let line = match line_rx.recv_timeout(remaining) {
                Ok(line) => line?,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err("Antigravity sign-in timed out.".into())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if let Some(raw_url) = line.strip_prefix(AUTH_PREFIX) {
                if !open_browser {
                    return Err("Google sign-in is required.".into());
                }
                validate_auth_url(raw_url.trim())?;
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = value.get("id").and_then(Value::as_u64);
            if id == Some(1) {
                validate_initialize(&value)?;
                initialized = true;
                write_json(
                    &stdin,
                    &json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"oauth-personal"}}),
                )?;
            } else if id == Some(2) {
                if value.get("error").is_some() {
                    return Err(authentication_error(&value));
                }
                authenticated = true;
                let (_, workspace) = prepare_profile(app, user_id)?;
                write_json(
                    &stdin,
                    &json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":workspace,"mcpServers":[]}}),
                )?;
                session_sent = true;
            } else if id == Some(3) {
                if value.get("error").is_some() {
                    return Err("Antigravity could not create an ACP session.".into());
                }
                models = extract_models(&value);
                break;
            }
        }
        if !initialized || !authenticated || !session_sent {
            return Err("Antigravity did not complete Google authentication.".into());
        }
        cache_models(app, user_id, &models)?;
        Ok(models)
    })();
    child.terminate();
    result
}

#[tauri::command]
pub async fn start_antigravity_browser_login(
    app: AppHandle,
) -> Result<AntigravityLoginResult, String> {
    let user_id = crate::backends::require_current_internal_user()?;
    let app_for_task = app.clone();
    let user_for_task = user_id.clone();
    let models =
        tokio::task::spawn_blocking(move || connect_process(&app_for_task, &user_for_task, true))
            .await
            .map_err(|_| "Antigravity sign-in stopped unexpectedly.".to_string())??;
    if models.is_empty() {
        return Err(
            "Google sign-in completed, but Antigravity returned no selectable models.".into(),
        );
    }
    crate::backends::record_connected_provider(&user_id, PROVIDER_ID)?;
    Ok(AntigravityLoginResult {
        provider_id: PROVIDER_ID,
        outcome: "ready",
        message: "Antigravity connected through Google.",
    })
}

#[tauri::command]
pub async fn check_antigravity_connection(app: AppHandle) -> Result<BackendVerifyResult, String> {
    let user_id = crate::backends::require_current_internal_user()?;
    if !runtime_installed(&app) {
        return Ok(BackendVerifyResult {
            provider_id: PROVIDER_ID.into(),
            outcome: "unsupported".into(),
            message: Some("Install the Antigravity ACP runtime first.".into()),
        });
    }
    let app_for_task = app.clone();
    let user_for_task = user_id.clone();
    match tokio::task::spawn_blocking(move || connect_process(&app_for_task, &user_for_task, false))
        .await
    {
        Ok(Ok(_)) => {
            crate::backends::record_connected_provider(&user_id, PROVIDER_ID)?;
            Ok(BackendVerifyResult {
                provider_id: PROVIDER_ID.into(),
                outcome: "ready".into(),
                message: Some("Antigravity is connected through Google.".into()),
            })
        }
        Ok(Err(message)) if message == "Google sign-in is required." => {
            let _ = crate::backends::remove_connected_provider(&user_id, PROVIDER_ID);
            Ok(BackendVerifyResult {
                provider_id: PROVIDER_ID.into(),
                outcome: "auth-failed".into(),
                message: Some(message),
            })
        }
        Ok(Err(message)) => Ok(BackendVerifyResult {
            provider_id: PROVIDER_ID.into(),
            outcome: "failed".into(),
            message: Some(message),
        }),
        Err(_) => Ok(BackendVerifyResult {
            provider_id: PROVIDER_ID.into(),
            outcome: "failed".into(),
            message: Some("Antigravity stopped while checking the connection.".into()),
        }),
    }
}

#[tauri::command]
pub fn list_antigravity_models(app: AppHandle) -> Result<Vec<BackendModel>, String> {
    let user_id = crate::backends::require_current_internal_user()?;
    Ok(cached_models(&app, &user_id))
}

fn prompt_text(request: &AntigravityAgentRequest, options: &AntigravityTurnOptions) -> String {
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

fn approval_payload(
    run_id: &str,
    request_id: &str,
    value: &Value,
    mode: &str,
) -> (String, Value, PendingPermission) {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let call_id = tool
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or(request_id)
        .to_string();
    let title = crate::paths::truncate_characters(
        &crate::paths::normalize_spaces(
            tool.get("title")
                .and_then(Value::as_str)
                .unwrap_or("Antigravity action"),
        ),
        120,
    );
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("other");
    let args = crate::store::repos::action_history::redact_safe_detail(
        &tool.get("rawInput").cloned().unwrap_or_else(|| json!({})),
    );
    let args_text = crate::paths::truncate_characters(&args.to_string(), 2_000);
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
                Some("allow_once") | Some("allow_always")
            )
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let reject = options
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some("reject_once"))
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let permission_mode = if mode == "read-only" {
        "read-only"
    } else if mode == "full-access" {
        "full-access"
    } else {
        "trusted-scope"
    };
    let payload = json!({
        "type":"approval-request", "requestId":request_id, "callId":call_id, "tool":format!("antigravity:{kind}"), "arguments":args_text.clone(),
        "approval": {"id":crate::paths::truncate_characters(&format!("antigravity-{run_id}-{request_id}-{call_id}"),120),"service":"antigravity","action":title.clone(),"mode":permission_mode,"riskLevel":if permission_mode == "full-access" { "high" } else { "medium" },"dataUsed":[args_text],"consequence":format!("Allow Antigravity to {title}."),"requestedAt":chrono::Utc::now().to_rfc3339(),"decisions":["once","deny"],"confirmationPhrase":if permission_mode == "full-access" { Value::String("approve antigravity action".into()) } else { Value::Null }}
    });
    (
        call_id,
        payload,
        PendingPermission {
            allow_option: allow,
            reject_option: reject,
        },
    )
}

fn handle_turn_line(
    app: &AppHandle,
    channel: &str,
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
        let (_, payload, pending) = approval_payload(run_id, &request_id, &value, permission_mode);
        if pending.allow_option.is_none() || pending.reject_option.is_none() {
            let _ = write_json(
                stdin,
                &json!({"jsonrpc":"2.0","id":value.get("id").cloned().unwrap_or(Value::Null),"result":{"outcome":{"outcome":"cancelled"}}}),
            );
        } else {
            if let Ok(mut map) = permissions.lock() {
                map.insert(request_id, pending);
            }
            let _ = app.emit(channel, payload);
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
    if value.get("id").and_then(Value::as_u64) == Some(prompt_id) {
        if let Some(error) = value.pointer("/error/message").and_then(Value::as_str) {
            let _ = app.emit(channel, json!({"type":"error","message":error}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
        } else {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
        }
        return true;
    }
    false
}

#[tauri::command]
pub fn start_antigravity_acp_turn(
    app: AppHandle,
    request: AntigravityTurnRequest,
) -> Result<(), String> {
    if request.provider_id != PROVIDER_ID {
        return Err("Antigravity ACP received the wrong provider route.".into());
    }
    let user_id = crate::backends::require_current_internal_user()?;
    if !crate::backends::connected_providers_for(&user_id)?
        .iter()
        .any(|id| id == PROVIDER_ID)
    {
        return Err("Connect Antigravity with Google before starting a turn.".into());
    }
    let (_, workspace) = prepare_profile(&app, &user_id)?;
    let mut child = SupervisedChild::spawn(command(&app, &user_id, BrowserBehavior::Suppress)?)?;
    let stdin =
        Arc::new(Mutex::new(child.child.stdin.take().ok_or_else(|| {
            "Antigravity stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .child
        .stdout
        .take()
        .ok_or_else(|| "Antigravity stdout was unavailable.".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let session_id = Arc::new(Mutex::new(None));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the Antigravity turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                stdin: stdin.clone(),
                child: child.clone(),
                session_id: session_id.clone(),
                permissions: permissions.clone(),
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://antigravity/{request_id}");
    thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            write_json(&stdin, &initialize_request(1))?;
            let reader = BufReader::new(stdout);
            let prompt_id = 5_u64;
            for line in reader.lines() {
                let line = line.map_err(|_| "Antigravity ACP stopped unexpectedly.".to_string())?;
                if line.starts_with(AUTH_PREFIX) {
                    return Err("Google sign-in expired. Reconnect Antigravity.".into());
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match value.get("id").and_then(Value::as_u64) {
                    Some(1) => {
                        validate_initialize(&value)?;
                        write_json(
                            &stdin,
                            &json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"oauth-personal"}}),
                        )?;
                    }
                    Some(2) if value.get("error").is_none() => write_json(
                        &stdin,
                        &json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":workspace,"mcpServers":[]}}),
                    )?,
                    Some(3) if value.get("error").is_none() => {
                        let sid = value
                            .pointer("/result/sessionId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                "Antigravity did not return an ACP session id.".to_string()
                            })?
                            .to_string();
                        *session_id.lock().map_err(|_| {
                            "Antigravity session state is unavailable.".to_string()
                        })? = Some(sid.clone());
                        let models = extract_models(&value);
                        let _ = cache_models(&app, &user_id, &models);
                        write_json(
                            &stdin,
                            &json!({"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":sid,"configId":"model","value":request.request.model}}),
                        )?;
                    }
                    Some(4) if value.get("error").is_none() => {
                        let sid = session_id
                            .lock()
                            .ok()
                            .and_then(|guard| guard.clone())
                            .ok_or_else(|| {
                                "Antigravity session state is unavailable.".to_string()
                            })?;
                        let text = prompt_text(&request.request, &request.options);
                        write_json(
                            &stdin,
                            &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":text}]}}),
                        )?;
                    }
                    Some(2..=4) => {
                        return Err(value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Antigravity ACP setup failed.")
                            .to_string())
                    }
                    _ => {}
                }
                if handle_turn_line(
                    &app,
                    &channel,
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
            child.terminate();
        }
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}

#[tauri::command]
pub fn respond_antigravity_acp_approval(
    request: AntigravityApprovalResponse,
) -> Result<(), String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Antigravity turn state is unavailable.".to_string())?;
    let run = runs
        .get(&request.request_id)
        .ok_or_else(|| "The Antigravity turn is no longer active.".to_string())?;
    let pending = run
        .permissions
        .lock()
        .map_err(|_| "Antigravity permission state is unavailable.".to_string())?
        .remove(&request.approval_request_id)
        .ok_or_else(|| "This Antigravity permission is no longer pending.".to_string())?;
    let id: Value = request
        .approval_request_id
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(request.approval_request_id.clone()));
    let outcome = if request.approved {
        pending
            .allow_option
            .map(|option_id| json!({"outcome":"selected","optionId":option_id}))
            .unwrap_or_else(|| json!({"outcome":"cancelled"}))
    } else {
        pending
            .reject_option
            .map(|option_id| json!({"outcome":"selected","optionId":option_id}))
            .unwrap_or_else(|| json!({"outcome":"cancelled"}))
    };
    write_json(
        &run.stdin,
        &json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}}),
    )
}

#[tauri::command]
pub fn interrupt_antigravity_acp_turn(request_id: String) -> Result<(), String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Antigravity turn state is unavailable.".to_string())?;
    let Some(run) = runs.get(&request_id) else {
        return Ok(());
    };
    if let Some(session_id) = run.session_id.lock().ok().and_then(|guard| guard.clone()) {
        write_json(
            &run.stdin,
            &json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session_id}}),
        )?;
    }
    Ok(())
}

pub(crate) fn shutdown_account() {
    let ids: Vec<_> = active_runs()
        .lock()
        .map(|runs| runs.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = shutdown_antigravity_acp_turn(id);
    }
}

#[tauri::command]
pub fn shutdown_antigravity_acp_turn(request_id: String) -> Result<(), String> {
    let run = active_runs()
        .lock()
        .map_err(|_| "Antigravity turn state is unavailable.".to_string())?
        .remove(&request_id);
    if let Some(run) = run {
        run.child
            .lock()
            .map_err(|_| "Antigravity process state is unavailable.".to_string())?
            .terminate();
    }
    Ok(())
}

#[tauri::command]
pub fn logout_antigravity(app: AppHandle) -> Result<(), String> {
    let user_id = crate::backends::require_current_internal_user()?;
    crate::backends::remove_connected_provider(&user_id, PROVIDER_ID)?;
    let profile = profile_dir(&app, &user_id)?;
    if profile.exists() {
        fs::remove_dir_all(profile)
            .map_err(|_| "Mivlet could not clear the private Antigravity profile.".to_string())?;
    }
    Ok(())
}

/// Browser helper entrypoint used only by an explicit Antigravity sign-in.
/// The separate suppress mode in `main.rs` remains inert for background checks
/// and ordinary turns whose provider session has expired.
pub fn open_validated_browser_helper(raw_url: &str) -> bool {
    let Ok(url) = validate_auth_url(raw_url) else {
        return false;
    };
    crate::oauth_loopback::open_browser(&url);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_google_loopback_oauth_urls() {
        let good = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2F";
        assert!(validate_auth_url(good).is_ok());
        assert!(validate_auth_url("https://evil.example/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2F").is_err());
        assert!(validate_auth_url("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=abc&redirect_uri=http%3A%2F%2Flocalhost%3A4567%2F").is_err());
    }

    #[test]
    fn extracts_models_from_acp_session_response() {
        let models = extract_models(
            &json!({"result":{"models":{"availableModels":[{"modelId":"gemini-2.5-pro","name":"Gemini 2.5 Pro"}]}}}),
        );
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-2.5-pro");
    }

    #[test]
    fn validates_the_exact_agent_and_auth_method() {
        let initialized = json!({"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"authMethods":[{"id":"oauth-personal"}]}});
        assert!(validate_initialize(&initialized).is_ok());
        let wrong = json!({"result":{"protocolVersion":1,"agentInfo":{"name":"other","version":"agy_acp_server_1.1.1"},"authMethods":[{"id":"oauth-personal"}]}});
        assert!(validate_initialize(&wrong).is_err());
    }

    #[test]
    fn accepts_only_the_pinned_runtime_version_forms() {
        for version in [VERSION, "agy_acp_server_1.1.1"] {
            let initialized = json!({"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":version},"authMethods":[{"id":"oauth-personal"}]}});
            assert!(validate_initialize(&initialized).is_ok());
        }
        let wrong = json!({"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.2"},"authMethods":[{"id":"oauth-personal"}]}});
        assert!(validate_initialize(&wrong).is_err());
    }

    #[test]
    fn reports_authentication_failures_without_waiting_for_a_timeout() {
        let ineligible = json!({"error":{"message":"Onboarding failed: user is ineligible","data":{"reason":"onboarding_failed"}}});
        assert!(authentication_error(&ineligible).contains("eligible for Antigravity"));

        let cancelled = json!({"error":{"message":"access_denied: cancelled"}});
        assert!(authentication_error(&cancelled).contains("cancelled"));

        let unknown = json!({"error":{"message":"provider failure with private detail"}});
        let safe = authentication_error(&unknown);
        assert!(!safe.contains("private detail"));
        assert!(safe.contains("could not complete Google sign-in"));
    }

    #[test]
    fn browser_helper_modes_are_distinct() {
        let interactive = browser_helper_command(BrowserBehavior::OpenValidated).unwrap();
        let background = browser_helper_command(BrowserBehavior::Suppress).unwrap();
        assert!(interactive.contains("--antigravity-browser-open %s"));
        assert!(background.contains("--antigravity-browser-suppress %s"));
        assert_ne!(interactive, background);
    }

    #[cfg(windows)]
    #[test]
    fn windows_supervisor_terminates_provider_descendants() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let directory = tempfile::tempdir().unwrap();
        let descendant_started = directory.path().join("descendant-started.txt");
        let survived = directory.path().join("survived.txt");
        let quote = |path: &std::path::Path| path.to_string_lossy().replace('\'', "''");
        let child_script = format!(
            "Set-Content -LiteralPath '{}' -Value started; Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath '{}' -Value survived",
            quote(&descendant_started),
            quote(&survived),
        );
        let encoded = STANDARD.encode(
            child_script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let parent_script = format!(
            "$null = Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','{encoded}'); Start-Sleep -Seconds 30",
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &parent_script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = SupervisedChild::spawn(command).unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if descendant_started.exists() {
                break;
            }
            if let Some(status) = child.child.try_wait().unwrap() {
                panic!("the provider launcher exited before its descendant was ready: {status}");
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            descendant_started.exists(),
            "the provider descendant did not signal readiness within 20 seconds"
        );
        child.terminate();
        thread::sleep(Duration::from_secs(2));
        assert!(
            !survived.exists(),
            "a provider descendant survived after its Mivlet job closed"
        );
    }

    #[test]
    fn approval_payload_redacts_secret_fields() {
        let request = json!({"params":{"toolCall":{"toolCallId":"call-1","title":"Run command","kind":"execute","rawInput":{"token":"super-secret-value","command":"status"}},"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"}]}});
        let (_, payload, _) = approval_payload("run-1", "7", &request, "full-access");
        let encoded = payload.to_string();
        assert!(!encoded.contains("super-secret-value"));
        assert!(encoded.contains("approve antigravity action"));
    }
}
