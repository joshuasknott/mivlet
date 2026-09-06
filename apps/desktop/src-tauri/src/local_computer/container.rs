//! Docker/WSL-backed local teammate computer.
//!
//! Docker is invoked directly with argument arrays; no host shell participates.
//! Every container and volume is deterministically named and label-bound to one
//! opaque Fable scope before it may be reused or replaced.

use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use url::Url;

use super::{ComputerScope, LocalComputerShellResult};

pub(super) const IMAGE_TAG: &str = "fable-local-computer:0.1.0-v4";
const OWNER_LABEL: &str = "com.fable.local-computer";
const SCOPE_LABEL: &str = "com.fable.scope";
const RUNTIME_CONFIG_LABEL: &str = "com.fable.runtime-config";
const RUNTIME_CONFIG_VERSION: &str = "1";
const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;
const MAX_SHELL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_SHELL_COMMAND_CHARACTERS: usize = 16 * 1024;
const MAX_DESKTOP_FRAME_BYTES: usize = 4 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(90);

static IMAGE_BUILD_GATE: OnceLock<Mutex<()>> = OnceLock::new();
static LIFECYCLE_GATE: OnceLock<Mutex<()>> = OnceLock::new();
const MAX_RUNNING_COMPUTERS: usize = 2;
static GATEWAY_ENDPOINTS: OnceLock<Mutex<HashMap<String, GatewayEndpoint>>> = OnceLock::new();

/// Native credentials: deliberately no Debug/Serialize implementation.
#[derive(Clone)]
pub(super) struct GatewayEndpoint {
    pub origin: String,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ContainerStatus {
    pub engine_available: bool,
    pub image_available: bool,
    pub container_exists: bool,
    pub running: bool,
    pub suspended: bool,
    pub healthy: bool,
}

#[derive(Debug)]
struct ContainerInspection {
    running: bool,
    suspended: bool,
    healthy: bool,
    image: String,
    image_id: String,
    runtime_config: String,
    owner_label: String,
    scope_label: String,
}

pub(super) fn status(scope: &ComputerScope) -> ContainerStatus {
    let engine_available = docker_succeeds(["info", "--format", "{{.ServerVersion}}"]);
    if !engine_available {
        return ContainerStatus {
            engine_available,
            image_available: false,
            container_exists: false,
            running: false,
            suspended: false,
            healthy: false,
        };
    }
    let image_available = image_exists();
    let inspection = inspect_container(scope).ok().flatten();
    ContainerStatus {
        engine_available,
        image_available,
        container_exists: inspection.is_some(),
        running: inspection.as_ref().is_some_and(|value| value.running),
        suspended: inspection.as_ref().is_some_and(|value| value.suspended),
        healthy: inspection.as_ref().is_some_and(|value| value.healthy),
    }
}

pub(super) fn ensure_running(scope: &ComputerScope, image_context: &Path) -> Result<(), String> {
    // Serialize admission with stop/update so concurrent starts cannot overrun
    // the installation budget. Paused desktops still reserve their RAM slot.
    let _lifecycle = LIFECYCLE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The computer lifecycle is unavailable.")?;
    if !docker_succeeds(["info", "--format", "{{.ServerVersion}}"]) {
        return Err(
            "Start Docker Desktop with its WSL 2 Linux engine before setting up this computer."
                .into(),
        );
    }
    ensure_start_capacity(scope)?;
    ensure_image(image_context)?;
    let image_id = installed_image_id()?;
    ensure_volume(scope)?;
    ensure_agent_volume(scope)?;

    if let Some(inspection) = inspect_container(scope)? {
        validate_owned_container(scope, &inspection)?;
        // Existing installations also move to on-demand startup.
        checked_quiet(
            vec![
                "container".into(),
                "update".into(),
                "--restart=no".into(),
                container_name(scope).into(),
            ],
            "Fable could not apply on-demand computer startup.",
        )?;
        if inspection.suspended {
            unpause(scope)?;
        }
        if inspection.image != IMAGE_TAG
            || inspection.image_id != image_id
            || inspection.runtime_config != RUNTIME_CONFIG_VERSION
        {
            checked(
                vec![
                    "container".into(),
                    "stop".into(),
                    container_name(scope).into(),
                ],
                "Fable could not stop the previous agent computer.",
            )?;
            checked(
                vec![
                    "container".into(),
                    "rm".into(),
                    container_name(scope).into(),
                ],
                "Fable could not replace the previous agent computer.",
            )?;
            create_container(scope)?;
        } else if !inspection.running {
            checked(
                vec![
                    "container".into(),
                    "start".into(),
                    container_name(scope).into(),
                ],
                "Fable could not start the agent computer.",
            )?;
        }
    } else {
        create_container(scope)?;
    }

    wait_until_ready(scope)?;
    if let Ok(mut endpoints) = GATEWAY_ENDPOINTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        endpoints.remove(&scope.key);
    }
    Ok(())
}

pub(super) fn debugger_websocket_url(scope: &ComputerScope) -> Result<String, String> {
    let endpoint = gateway_endpoint(scope)?;
    Ok(format!(
        "ws://{}/{}/cdp",
        endpoint.origin.trim_start_matches("http://"),
        endpoint.token
    ))
}

fn capacity_available(active_scopes: &[String], requested: &str) -> bool {
    active_scopes.iter().any(|scope| scope == requested)
        || active_scopes.len() < MAX_RUNNING_COMPUTERS
}

#[cfg(test)]
mod lifecycle_budget_tests {
    use super::capacity_available;
    #[test]
    fn budget_reserves_suspended_slots_but_allows_reusing_an_existing_computer() {
        assert!(capacity_available(&[], "a"));
        assert!(capacity_available(&["a".into()], "b"));
        assert!(!capacity_available(&["a".into(), "b".into()], "c"));
        assert!(capacity_available(&["a".into(), "b".into()], "a"));
    }
}

fn ensure_start_capacity(scope: &ComputerScope) -> Result<(), String> {
    let output = checked_quiet(
        vec![
            "container".into(),
            "ls".into(),
            "--filter".into(),
            format!("label={OWNER_LABEL}=true").into(),
            "--format".into(),
            "{{.Label \"com.fable.scope\"}}".into(),
        ],
        "Fable could not check the computer resource budget.",
    )?;
    let active: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    if !capacity_available(&active, &scope.key) {
        return Err("Two computers are already open. Stop one from its Computer options before starting another.".into());
    }
    Ok(())
}

fn invalidate_gateway(scope: &ComputerScope) {
    if let Ok(mut endpoints) = GATEWAY_ENDPOINTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        endpoints.remove(&scope.key);
    }
}

fn unpause(scope: &ComputerScope) -> Result<(), String> {
    checked_quiet(
        vec![
            "container".into(),
            "unpause".into(),
            container_name(scope).into(),
        ],
        "Fable could not wake the sleeping computer.",
    )?;
    invalidate_gateway(scope);
    Ok(())
}

/// Caller must revoke and drain authority before stopping or replacing a desktop.
/// Container removal deliberately does not include `--volumes`.
pub(super) fn stop_owned(scope: &ComputerScope, replace_system: bool) -> Result<(), String> {
    let _lifecycle = LIFECYCLE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The computer lifecycle is unavailable.")?;
    if !docker_succeeds(["info", "--format", "{{.ServerVersion}}"]) {
        return Err("Docker Desktop is unavailable. Start its Linux engine before stopping or updating this computer.".into());
    }
    let Some(inspection) = inspect_container(scope)? else {
        return Ok(());
    };
    validate_owned_container(scope, &inspection)?;
    if inspection.suspended {
        unpause(scope)?;
    }
    if inspection.running {
        checked_quiet(
            vec![
                "container".into(),
                "stop".into(),
                "--timeout".into(),
                "15".into(),
                container_name(scope).into(),
            ],
            "Fable could not stop the computer. Its files have been kept.",
        )?;
    }
    if replace_system {
        checked_quiet(
            vec![
                "container".into(),
                "rm".into(),
                container_name(scope).into(),
            ],
            "Fable could not replace the computer system. Its files have been kept.",
        )?;
    }
    invalidate_gateway(scope);
    Ok(())
}

/// Freeze CPU activity while keeping application memory, home volumes and files.
pub(super) fn suspend_owned(scope: &ComputerScope) -> Result<(), String> {
    let _lifecycle = LIFECYCLE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "The computer lifecycle is unavailable.")?;
    let Some(inspection) = inspect_container(scope)? else {
        return Ok(());
    };
    validate_owned_container(scope, &inspection)?;
    if inspection.running && !inspection.suspended {
        checked_quiet(
            vec![
                "container".into(),
                "pause".into(),
                container_name(scope).into(),
            ],
            "Fable could not put the idle computer to sleep.",
        )?;
    }
    invalidate_gateway(scope);
    Ok(())
}

pub(super) fn wake_owned(scope: &ComputerScope) -> Result<(), String> {
    let Some(inspection) = inspect_container(scope)? else {
        return Ok(());
    };
    validate_owned_container(scope, &inspection)?;
    if inspection.suspended {
        unpause(scope)?;
    }
    Ok(())
}

pub(super) fn gateway_endpoint(scope: &ComputerScope) -> Result<GatewayEndpoint, String> {
    let cache = GATEWAY_ENDPOINTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(value) = cache
        .lock()
        .map_err(|_| "The local computer gateway is unavailable.")?
        .get(&scope.key)
    {
        return Ok(value.clone());
    }
    let inspection = inspect_container(scope)?.ok_or("The agent computer is not running.")?;
    validate_owned_container(scope, &inspection)?;
    let output = checked_quiet(
        vec![
            "exec".into(),
            "--user".into(),
            "root".into(),
            container_name(scope).into(),
            "cat".into(),
            "/run/fable-private/gateway-token".into(),
        ],
        "Fable could not authenticate the local computer gateway.",
    )?;
    let token = String::from_utf8(output.stdout)
        .map_err(|_| "The local computer gateway credential is invalid.")?;
    let token = token.trim().to_owned();
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("The local computer gateway credential is invalid.".into());
    }
    let port = published_debug_port(scope)?;
    let endpoint = GatewayEndpoint {
        origin: format!("http://127.0.0.1:{port}"),
        token,
    };
    cache
        .lock()
        .map_err(|_| "The local computer gateway is unavailable.")?
        .insert(scope.key.clone(), endpoint.clone());
    Ok(endpoint)
}

pub(super) fn capture_desktop(scope: &ComputerScope) -> Result<Vec<u8>, String> {
    let output = checked(
        vec![
            "exec".into(),
            "--user".into(),
            "fable".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-screenshot".into(),
        ],
        "Fable could not capture the agent computer.",
    )?;
    if output.stdout.is_empty() || output.stdout.len() > MAX_DESKTOP_FRAME_BYTES {
        return Err("The agent computer returned an invalid desktop frame.".into());
    }
    Ok(output.stdout)
}

pub(super) fn desktop_privacy_check(scope: &ComputerScope) -> Result<(), String> {
    // The guest helper has its own four-second alarm. No window metadata or
    // diagnostic is permitted to cross this native privacy boundary.
    checked_quiet(
        vec!["exec".into(), "--user".into(), "fable".into(), container_name(scope).into(),
            "/usr/bin/timeout".into(), "5".into(), "/usr/local/bin/fable-desktop-privacy".into()],
        "The desktop may contain a private sign-in or dialog. Take control to finish it, then return control.",
    )?;
    Ok(())
}

pub(super) fn pointer(
    scope: &ComputerScope,
    x: u32,
    y: u32,
    action: &str,
    delta_y: Option<f64>,
) -> Result<(), String> {
    desktop_input(
        scope,
        &serde_json::json!({ "type": "pointer", "action": action,
        "x": x, "y": y, "deltaY": delta_y.unwrap_or_default() }),
    )
}

pub(super) fn key(scope: &ComputerScope, value: &str) -> Result<(), String> {
    desktop_input(scope, &serde_json::json!({ "type": "key", "key": value }))
}

pub(super) fn launch_application(scope: &ComputerScope, application: &str) -> Result<(), String> {
    checked(
        vec![
            "exec".into(),
            "--user".into(),
            "fable".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-launch-app".into(),
            application.into(),
        ],
        "The agent computer could not open that application.",
    )?;
    Ok(())
}

pub(super) fn focus_browser(scope: &ComputerScope) -> Result<(), String> {
    launch_application(scope, "browser")
}

pub(super) fn run_shell_cancellable(
    scope: &ComputerScope,
    command: &str,
    cancellation: Arc<AtomicBool>,
) -> Result<LocalComputerShellResult, String> {
    if command.trim().is_empty() || command.chars().count() > MAX_SHELL_COMMAND_CHARACTERS {
        return Err("The terminal command must be between 1 and 16384 characters.".into());
    }
    if command.chars().any(|character| character == '\0') {
        return Err("The terminal command contains an invalid character.".into());
    }
    if cancellation.load(Ordering::SeqCst) {
        return Err("The agent command was cancelled before it started.".into());
    }

    let mut process = docker_command();
    process.args([
        OsStr::new("exec"),
        OsStr::new("--interactive"),
        OsStr::new("--user"),
        OsStr::new("root"),
        OsStr::new(&container_name(scope)),
        OsStr::new("/usr/local/bin/fable-agent-shell"),
        OsStr::new("run"),
    ]);
    let mut child = process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Fable could not start the isolated terminal command.".to_string())?;
    child
        .stdin
        .take()
        .ok_or("Fable could not send the isolated command.")?
        .write_all(command.as_bytes())
        .map_err(|_| "Fable could not send the isolated command.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Fable could not capture isolated terminal output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Fable could not capture isolated terminal errors.".to_string())?;
    let stdout_thread = thread::spawn(move || drain(stdout, MAX_SHELL_OUTPUT_BYTES + 1));
    let stderr_thread = thread::spawn(move || drain(stderr, MAX_SHELL_OUTPUT_BYTES + 1));
    let started = Instant::now();
    let mut cancelled = false;
    let mut last_cancel = None;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Fable could not finish the isolated terminal command.")?
        {
            break status;
        }
        if (cancellation.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(65))
            && last_cancel
                .is_none_or(|instant: Instant| instant.elapsed() >= Duration::from_millis(100))
        {
            cancel_agent_processes(scope)?;
            cancelled = true;
            last_cancel = Some(Instant::now());
        }
        if started.elapsed() > Duration::from_secs(75) {
            let _ = child.kill();
            return Err("The isolated command did not disconnect after cancellation.".into());
        }
        thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = stdout_thread
        .join()
        .map_err(|_| "Fable could not collect isolated terminal output.".to_string())?
        .map_err(|_| "Fable could not read isolated terminal output.".to_string())?;
    let mut stderr = stderr_thread
        .join()
        .map_err(|_| "Fable could not collect isolated terminal errors.".to_string())?
        .map_err(|_| "Fable could not read isolated terminal errors.".to_string())?;
    let truncated = stdout.len() > MAX_SHELL_OUTPUT_BYTES || stderr.len() > MAX_SHELL_OUTPUT_BYTES;
    stdout.truncate(MAX_SHELL_OUTPUT_BYTES);
    stderr.truncate(MAX_SHELL_OUTPUT_BYTES);
    if cancelled || cancellation.load(Ordering::SeqCst) {
        return Err("The agent command was cancelled and its processes were stopped.".into());
    }
    Ok(LocalComputerShellResult {
        exit_code: status.code().unwrap_or(137),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        truncated,
    })
}

pub(super) fn cancel_agent_processes(scope: &ComputerScope) -> Result<(), String> {
    let Some(inspection) = inspect_container(scope)? else {
        return Ok(());
    };
    validate_owned_container(scope, &inspection)?;
    if !inspection.running {
        return Ok(());
    }
    checked_quiet(
        vec![
            "exec".into(),
            "--user".into(),
            "root".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-agent-shell".into(),
            "cancel".into(),
        ],
        "Fable could not stop the agent processes. Keep the computer paused and restart it.",
    )?;
    Ok(())
}

/// The native caller has already read and approved the scoped artifact. Copy
/// those exact bytes to a root-owned file before Chromium receives its path,
/// so a workspace symlink swap cannot change what the browser uploads.
pub(super) fn stage_browser_upload(
    scope: &ComputerScope,
    name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if name.is_empty()
        || name.chars().count() > 240
        || matches!(name, "." | "..")
        || name
            .chars()
            .any(|value| value.is_control() || "/\\:".contains(value))
        || bytes.len() > 32 * 1024 * 1024
    {
        return Err("The browser upload name or size is invalid.".into());
    }
    let mut child = docker_command()
        .args([
            "exec",
            "--interactive",
            "--user",
            "root",
            &container_name(scope),
            "/usr/local/bin/fable-stage-upload",
            name,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Fable could not stage the browser upload.")?;
    child
        .stdin
        .take()
        .ok_or("The upload transport is unavailable.")?
        .write_all(bytes)
        .map_err(|_| "Fable could not copy the browser upload.")?;
    let output = child
        .wait_with_output()
        .map_err(|_| "The browser upload did not finish.")?;
    if !output.status.success() {
        return Err(
            "The browser upload could not be staged. The temporary upload limit may be full."
                .into(),
        );
    }
    let path =
        String::from_utf8(output.stdout).map_err(|_| "The browser upload path is invalid.")?;
    let path = path.trim();
    let prefix = "/tmp/fable-uploads/";
    let valid = path
        .strip_prefix(prefix)
        .and_then(|suffix| suffix.split_once('/'))
        .is_some_and(|(nonce, filename)| {
            nonce.len() == 32
                && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
                && filename == name
        });
    if !valid {
        return Err("The browser upload path is invalid.".into());
    }
    Ok(path.to_owned())
}

/// The caller holds Fable's current operation/lease ticket. The gateway is only
/// a bounded transport; it never decides who may act.
pub(super) fn desktop_input(
    scope: &ComputerScope,
    value: &serde_json::Value,
) -> Result<(), String> {
    let payload = serde_json::to_vec(value).map_err(|_| "The computer input is invalid.")?;
    if payload.len() > 20 * 1024 {
        return Err("The computer input is too large.".into());
    }
    gateway_post(scope, "input", &payload)
}

pub(super) fn cancel_browser_downloads(scope: &ComputerScope) -> Result<(), String> {
    gateway_post(scope, "cancel-downloads", &[]).map_err(|_| {
        "Fable could not stop the computer downloads. Reconnect before continuing.".into()
    })
}

fn gateway_post(scope: &ComputerScope, route: &str, payload: &[u8]) -> Result<(), String> {
    gateway_request(scope, "POST", route, payload).map(|_| ())
}

pub(super) fn download_status(scope: &ComputerScope) -> Result<serde_json::Value, String> {
    let body = gateway_request(scope, "GET", "downloads", &[])
        .map_err(|_| "Fable could not read the computer download status.")?;
    serde_json::from_slice(&body).map_err(|_| "The computer download status is unavailable.".into())
}

fn gateway_request(
    scope: &ComputerScope,
    method: &str,
    route: &str,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let endpoint = gateway_endpoint(scope)?;
    let url =
        Url::parse(&endpoint.origin).map_err(|_| "The computer input transport is invalid.")?;
    let address: SocketAddr = format!(
        "127.0.0.1:{}",
        url.port().ok_or("The computer input port is invalid.")?
    )
    .parse()
    .map_err(|_| "The computer input transport is invalid.")?;
    let mut connection = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "Reconnect to the agent computer before sending input.")?;
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    connection
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok();
    write!(connection, "{} /{}/{} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", method, endpoint.token, route, payload.len())
        .and_then(|()| connection.write_all(payload))
        .map_err(|_| "The computer input connection was interrupted.")?;
    let mut response = Vec::new();
    connection
        .take(32 * 1024)
        .read_to_end(&mut response)
        .map_err(|_| "The computer did not acknowledge the input.")?;
    if !response.starts_with(b"HTTP/1.1 200 ") {
        return Err(
            "The agent computer rejected that input. Refresh the view and try again.".into(),
        );
    }
    let body = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or("The computer response is unavailable.")?;
    Ok(response[body + 4..].to_vec())
}

fn ensure_image(image_context: &Path) -> Result<(), String> {
    if image_exists() {
        return Ok(());
    }
    let gate = IMAGE_BUILD_GATE.get_or_init(|| Mutex::new(()));
    let _guard = gate
        .lock()
        .map_err(|_| "The agent computer image build state is unavailable.".to_string())?;
    if image_exists() {
        return Ok(());
    }
    if !image_context.join("Dockerfile").is_file() {
        return Err("Fable's local computer image is missing from this installation.".into());
    }
    checked_quiet(
        vec![
            "build".into(),
            "--quiet".into(),
            "--tag".into(),
            IMAGE_TAG.into(),
            image_context.as_os_str().to_owned(),
        ],
        "Fable could not build the local computer image.",
    )?;
    Ok(())
}

fn image_exists() -> bool {
    docker_succeeds(["image", "inspect", IMAGE_TAG])
}

fn installed_image_id() -> Result<String, String> {
    let output = checked_quiet(
        vec![
            "image".into(),
            "inspect".into(),
            "--format".into(),
            "{{.Id}}".into(),
            IMAGE_TAG.into(),
        ],
        "Fable could not verify the computer system image.",
    )?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !id
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("The computer system image has an invalid identifier.".into());
    }
    Ok(id)
}

fn ensure_volume(scope: &ComputerScope) -> Result<(), String> {
    ensure_named_volume(scope, volume_name(scope))
}

fn ensure_agent_volume(scope: &ComputerScope) -> Result<(), String> {
    ensure_named_volume(scope, format!("{}-agent", volume_name(scope)))
}

fn ensure_named_volume(scope: &ComputerScope, name: String) -> Result<(), String> {
    let inspection = docker_output([
        OsStr::new("volume"),
        OsStr::new("inspect"),
        OsStr::new("--format"),
        OsStr::new("{{ index .Labels \"com.fable.local-computer\" }}|{{ index .Labels \"com.fable.scope\" }}"),
        OsStr::new(&name),
    ])
    .map_err(|_| "Fable could not inspect local computer storage.".to_string())?;
    if inspection.status.success() {
        let labels = String::from_utf8_lossy(&inspection.stdout);
        if labels.trim() != format!("true|{}", scope.key) {
            return Err(
                "The local computer storage name is already owned by another resource.".into(),
            );
        }
        return Ok(());
    }
    checked(
        vec![
            "volume".into(),
            "create".into(),
            "--label".into(),
            format!("{OWNER_LABEL}=true").into(),
            "--label".into(),
            format!("{SCOPE_LABEL}={}", scope.key).into(),
            "--label".into(),
            format!("com.fable.test-resource={}", cfg!(test)).into(),
            name.into(),
        ],
        "Fable could not create persistent storage for the agent computer.",
    )?;
    Ok(())
}

fn create_container(scope: &ComputerScope) -> Result<(), String> {
    let workspace = scope.directory.join("workspace");
    let source = docker_mount_source(&workspace)?;
    // Docker parses --mount as CSV even when the process receives one argument.
    let source_field = format!("source={source}");
    let source_field = if source_field.contains([',', '"']) {
        format!("\"{}\"", source_field.replace('"', "\"\""))
    } else {
        source_field
    };
    let mount = format!("type=bind,{source_field},target=/home/fable/Workspace");
    let home = format!(
        "type=volume,source={},target=/home/fable",
        volume_name(scope)
    );
    let agent_home = format!(
        "type=volume,source={}-agent,target=/home/agent",
        volume_name(scope)
    );
    checked_quiet(
        vec![
            "run".into(),
            "--detach".into(),
            "--name".into(),
            container_name(scope).into(),
            "--hostname".into(),
            "fable-computer".into(),
            "--label".into(),
            format!("{RUNTIME_CONFIG_LABEL}={RUNTIME_CONFIG_VERSION}").into(),
            "--label".into(),
            format!("{OWNER_LABEL}=true").into(),
            "--label".into(),
            format!("{SCOPE_LABEL}={}", scope.key).into(),
            "--label".into(),
            format!("com.fable.test-resource={}", cfg!(test)).into(),
            "--mount".into(),
            home.into(),
            "--mount".into(),
            agent_home.into(),
            "--mount".into(),
            mount.into(),
            "--publish".into(),
            "127.0.0.1::9223".into(),
            "--memory".into(),
            "2g".into(),
            "--memory-swap".into(),
            "3g".into(),
            "--cpus".into(),
            "2".into(),
            "--pids-limit".into(),
            "512".into(),
            "--shm-size".into(),
            "512m".into(),
            "--cap-drop".into(),
            "ALL".into(),
            // Debian Chromium's SUID helper needs these bounded
            // capabilities to create its renderer PID/network namespace,
            // chroot it, and return to the unprivileged browser user. Keeping
            // Chromium's own two-layer sandbox is safer than --no-sandbox.
            "--cap-add".into(),
            "SYS_ADMIN".into(),
            "--cap-add".into(),
            "SYS_CHROOT".into(),
            "--cap-add".into(),
            "SETUID".into(),
            "--cap-add".into(),
            "SETGID".into(),
            // The root supervisor needs SETPCAP to remove the complete
            // capability bounding set before entering agent UID 1001.
            "--cap-add".into(),
            "SETPCAP".into(),
            // The root supervisor initializes scoped storage and drains UID
            // 1001 processes on revocation. Agent commands drop this entire
            // bounding set before running, with no-new-privileges enforced.
            "--cap-add".into(),
            "CHOWN".into(),
            "--cap-add".into(),
            "FOWNER".into(),
            "--cap-add".into(),
            "DAC_OVERRIDE".into(),
            "--cap-add".into(),
            "KILL".into(),
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,size=512m".into(),
            "--tmpfs".into(),
            "/run:rw,nosuid,nodev,size=64m".into(),
            "--restart".into(),
            "no".into(),
            "--health-cmd".into(),
            "/usr/local/bin/fable-ready".into(),
            "--health-interval".into(),
            "5s".into(),
            "--health-timeout".into(),
            "3s".into(),
            "--health-retries".into(),
            "12".into(),
            "--health-start-period".into(),
            "30s".into(),
            IMAGE_TAG.into(),
        ],
        "Fable could not create the agent computer.",
    )?;
    Ok(())
}

fn docker_mount_source(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or("The computer workspace path is not supported by Docker.")?;
    // Rust canonical paths use the Win32 verbatim prefix; Docker Desktop's
    // Linux-engine mount parser rejects that prefix even for valid local disks.
    #[cfg(target_os = "windows")]
    let value = value.strip_prefix(r"\\?\").unwrap_or(value);
    Ok(value.to_owned())
}

fn wait_until_ready(scope: &ComputerScope) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < READY_TIMEOUT {
        if docker_succeeds([
            "exec",
            container_name(scope).as_str(),
            "/usr/local/bin/fable-ready",
        ]) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("The agent computer did not become ready in time.".into())
}

fn inspect_container(scope: &ComputerScope) -> Result<Option<ContainerInspection>, String> {
    let output = docker_output([
        OsStr::new("container"),
        OsStr::new("inspect"),
        OsStr::new("--format"),
        OsStr::new("{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Config.Image}}|{{ index .Config.Labels \"com.fable.local-computer\" }}|{{ index .Config.Labels \"com.fable.scope\" }}|{{.State.Paused}}|{{.Image}}|{{ index .Config.Labels \"com.fable.runtime-config\" }}"),
        OsStr::new(&container_name(scope)),
    ])
    .map_err(|_| "Fable could not inspect the agent computer.".to_string())?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.trim().split('|');
    let running = fields.next() == Some("true");
    let health = fields.next().unwrap_or("none");
    let image = fields.next().unwrap_or_default().to_string();
    let owner_label = fields.next().unwrap_or_default().to_string();
    let scope_label = fields.next().unwrap_or_default().to_string();
    let suspended = fields.next() == Some("true");
    let image_id = fields.next().unwrap_or_default().to_string();
    let runtime_config = fields.next().unwrap_or_default().to_string();
    if fields.next().is_some() {
        return Err("The agent computer returned invalid lifecycle metadata.".into());
    }
    Ok(Some(ContainerInspection {
        running,
        suspended,
        healthy: running && !suspended && health == "healthy",
        image,
        image_id,
        runtime_config,
        owner_label,
        scope_label,
    }))
}

fn validate_owned_container(
    scope: &ComputerScope,
    inspection: &ContainerInspection,
) -> Result<(), String> {
    if inspection.owner_label != "true" || inspection.scope_label != scope.key {
        return Err("The agent computer name is already owned by another resource.".into());
    }
    Ok(())
}

fn published_debug_port(scope: &ComputerScope) -> Result<u16, String> {
    let output = checked(
        vec![
            "port".into(),
            container_name(scope).into(),
            "9223/tcp".into(),
        ],
        "Fable could not resolve the agent browser port.",
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    let port = text
        .lines()
        .find_map(|line| line.trim().rsplit_once(':').map(|(_, port)| port))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "The agent browser port is invalid.".to_string())?;
    Ok(port)
}

fn container_name(scope: &ComputerScope) -> String {
    format!("fable-computer-{}", scope.key)
}

fn volume_name(scope: &ComputerScope) -> String {
    format!("fable-computer-{}", scope.key)
}

fn docker_succeeds<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    docker_output(args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn checked(args: Vec<OsString>, message: &str) -> Result<Output, String> {
    let output = docker_output(args).map_err(|_| message.to_string())?;
    if output.status.success() {
        return Ok(output);
    }
    let detail = bounded_diagnostic(&output.stderr);
    if detail.is_empty() {
        Err(message.to_string())
    } else {
        Err(format!("{message} {detail}"))
    }
}

/// Run a Docker operation whose diagnostic may echo an installation or host
/// workspace path. The native boundary deliberately keeps that detail out of
/// renderer-visible errors.
fn checked_quiet(args: Vec<OsString>, message: &str) -> Result<Output, String> {
    let output = docker_output(args).map_err(|_| message.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(message.to_string())
    }
}

fn docker_output<I, S>(args: I) -> std::io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    docker_command().args(args).stdin(Stdio::null()).output()
}

fn docker_command() -> Command {
    let mut command = Command::new("docker");
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
    command
}

fn bounded_diagnostic(value: &[u8]) -> String {
    let retained = &value[..value.len().min(MAX_DIAGNOSTIC_BYTES)];
    String::from_utf8_lossy(retained)
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn drain(mut stream: impl Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(cap);
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Ok(retained);
        }
        let remaining = cap.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
}

#[cfg(test)]
pub(super) fn cleanup_test_computer(scope: &ComputerScope) -> Result<(), String> {
    let resources = [
        ("container", container_name(scope)),
        ("volume", volume_name(scope)),
        ("volume", format!("{}-agent", volume_name(scope))),
    ];
    // Verify every existing resource before deleting any. Tests cannot remove a
    // production resource merely by constructing its deterministic scope name.
    let mut present = Vec::new();
    for (kind, name) in resources {
        let template = if kind == "container" {
            "{{index .Config.Labels \"com.fable.local-computer\"}}|{{index .Config.Labels \"com.fable.scope\"}}|{{index .Config.Labels \"com.fable.test-resource\"}}"
        } else {
            "{{index .Labels \"com.fable.local-computer\"}}|{{index .Labels \"com.fable.scope\"}}|{{index .Labels \"com.fable.test-resource\"}}"
        };
        let output = docker_output([kind, "inspect", "--format", template, &name])
            .map_err(|_| "Could not inspect test resources.")?;
        if !output.status.success() {
            continue;
        }
        if String::from_utf8_lossy(&output.stdout).trim() != format!("true|{}|true", scope.key) {
            return Err("Refusing to remove a resource not owned by this test scope.".into());
        }
        present.push((kind, name));
    }
    for (kind, name) in present {
        let args = if kind == "container" {
            vec![kind.into(), "rm".into(), "--force".into(), name.into()]
        } else {
            vec![kind.into(), "rm".into(), name.into()]
        };
        checked_quiet(args, "Could not remove an owned test resource.")?;
    }
    if let Ok(mut endpoints) = GATEWAY_ENDPOINTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        endpoints.remove(&scope.key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scope() -> ComputerScope {
        ComputerScope {
            key: "0123456789abcdef0123456789abcdef".into(),
            computer_id: "local-0123456789abcdef01234567".into(),
            directory: PathBuf::from("C:/safe/fable"),
        }
    }

    #[test]
    fn resource_names_are_deterministic_and_scope_bound() {
        let scope = scope();
        assert_eq!(
            container_name(&scope),
            "fable-computer-0123456789abcdef0123456789abcdef"
        );
        assert_eq!(volume_name(&scope), container_name(&scope));
    }

    #[test]
    fn bounded_diagnostics_flatten_and_limit_untrusted_output() {
        let value = vec![b'x'; MAX_DIAGNOSTIC_BYTES + 20];
        assert_eq!(bounded_diagnostic(&value).len(), MAX_DIAGNOSTIC_BYTES);
        assert_eq!(bounded_diagnostic(b"one\r\ntwo"), "one two");
    }

    #[test]
    #[ignore = "requires Docker Desktop and the built local computer image"]
    fn real_container_isolates_commands_cancels_descendants_and_preserves_files() {
        struct Cleanup(ComputerScope);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = cleanup_test_computer(&self.0);
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).unwrap();
        let scope = ComputerScope {
            key: hex::encode(random),
            computer_id: format!("local-test-{}", hex::encode(random)),
            // Exercise the same canonical Windows path used by the native app.
            directory: temp.path().canonicalize().unwrap(),
        };
        std::fs::create_dir_all(scope.directory.join("workspace")).unwrap();
        let _cleanup = Cleanup(scope.clone());
        let image_context =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/local-computer");
        ensure_running(&scope, &image_context).unwrap();
        let execute = |command: &str| {
            run_shell_cancellable(&scope, command, Arc::new(AtomicBool::new(false))).unwrap()
        };
        let result = execute(
            r#"python3 - <<'PY'
import os, socket
from pathlib import Path
from openpyxl import Workbook
from docx import Document
assert os.getuid() == 1001
status = Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\t1' in status
assert 'CapEff:\t0000000000000000' in status
assert 'CapBnd:\t0000000000000000' in status
for path in ('/run/fable-private/gateway-token', '/run/fable-desktop/Xauthority', '/home/fable/.config/chromium', '/tmp/fable-uploads'):
    assert not os.access(path, os.R_OK), path
assert 'DISPLAY' not in os.environ and 'XAUTHORITY' not in os.environ
sock = socket.socket(); sock.settimeout(1)
assert sock.connect_ex(('127.0.0.1', 9222)) != 0
sock.close()
Path('/home/agent/persistence.txt').write_text('persistent agent home')
book = Workbook(); book.active['A1'] = 'Fable'; book.save('sample.xlsx')
document = Document(); document.add_paragraph('Fable'); document.save('sample.docx')
print('isolation and documents passed')
PY
node --version
git --version"#,
        );
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
        assert!(result.stdout.contains("isolation and documents passed"));
        assert!(scope.directory.join("workspace/sample.xlsx").is_file());
        assert!(scope.directory.join("workspace/sample.docx").is_file());
        let staged = stage_browser_upload(&scope, "approved.txt", b"exact approved bytes").unwrap();
        let read = checked_quiet(
            vec![
                "exec".into(),
                "--user".into(),
                "fable".into(),
                container_name(&scope).into(),
                "cat".into(),
                staged.clone().into(),
            ],
            "upload read failed",
        )
        .unwrap();
        assert_eq!(read.stdout, b"exact approved bytes");
        assert_ne!(execute(&format!("cat '{staged}'")).exit_code, 0);
        let write = docker_output([
            "exec",
            "--user",
            "fable",
            &container_name(&scope),
            "test",
            "-w",
            &staged,
        ])
        .unwrap();
        assert!(
            !write.status.success(),
            "browser must not mutate staged uploads"
        );

        let cancellation = Arc::new(AtomicBool::new(false));
        let command_scope = scope.clone();
        let cancel_flag = cancellation.clone();
        let command = thread::spawn(move || {
            run_shell_cancellable(
                &command_scope,
                r#"python3 - <<'PY'
import os, time
from pathlib import Path
Path('started.txt').write_text('started')
if os.fork() == 0:
    os.setsid()
    time.sleep(4)
    Path('escaped.txt').write_text('must never happen')
    os._exit(0)
time.sleep(30)
PY"#,
                cancel_flag,
            )
        });
        let started = Instant::now();
        while !scope.directory.join("workspace/started.txt").is_file() {
            assert!(
                started.elapsed() < Duration::from_secs(8),
                "shell did not start"
            );
            thread::sleep(Duration::from_millis(30));
        }
        // A second wrapper cannot queue an operation behind the running shell.
        assert_ne!(execute("touch queued.txt").exit_code, 0);
        cancellation.store(true, Ordering::SeqCst);
        let revoked = Instant::now();
        assert!(command.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(revoked.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_secs(4));
        assert!(!scope.directory.join("workspace/escaped.txt").exists());
        assert!(!scope.directory.join("workspace/queued.txt").exists());
        assert!(run_shell_cancellable(&scope, "touch late.txt", cancellation).is_err());
        assert!(!scope.directory.join("workspace/late.txt").exists());
        cancel_agent_processes(&scope).unwrap();

        checked_quiet(
            vec!["stop".into(), container_name(&scope).into()],
            "stop test failed",
        )
        .unwrap();
        ensure_running(&scope, &image_context).unwrap();
        let result =
            execute("cat /home/agent/persistence.txt; test -f sample.xlsx && test -f sample.docx");
        assert_eq!(result.exit_code, 0, "{}", result.stderr);
        assert!(result.stdout.contains("persistent agent home"));
        assert!(!capture_desktop(&scope).unwrap().is_empty());
        cleanup_test_computer(&scope).unwrap();
    }
}
