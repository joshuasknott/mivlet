//! Docker/WSL-backed local teammate computer.
//!
//! Docker is invoked directly with argument arrays; no host shell participates.
//! Every container and volume is deterministically named and label-bound to one
//! opaque Fable scope before it may be reused or replaced.

use std::{
    ffi::{OsStr, OsString},
    io::Read,
    path::Path,
    process::{Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use url::Url;

use super::{ComputerScope, LocalComputerShellResult};

pub(super) const IMAGE_TAG: &str = "fable-local-computer:0.1.0-v3";
const OWNER_LABEL: &str = "com.fable.local-computer";
const SCOPE_LABEL: &str = "com.fable.scope";
const MAX_DIAGNOSTIC_BYTES: usize = 4 * 1024;
const MAX_SHELL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_SHELL_COMMAND_CHARACTERS: usize = 16 * 1024;
const MAX_DESKTOP_FRAME_BYTES: usize = 4 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(90);

static IMAGE_BUILD_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ContainerStatus {
    pub engine_available: bool,
    pub image_available: bool,
    pub container_exists: bool,
    pub running: bool,
    pub healthy: bool,
}

#[derive(Debug)]
struct ContainerInspection {
    running: bool,
    healthy: bool,
    image: String,
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
        healthy: inspection.as_ref().is_some_and(|value| value.healthy),
    }
}

pub(super) fn ensure_running(scope: &ComputerScope, image_context: &Path) -> Result<(), String> {
    if !docker_succeeds(["info", "--format", "{{.ServerVersion}}"]) {
        return Err(
            "Start Docker Desktop with its WSL 2 Linux engine before setting up this computer."
                .into(),
        );
    }
    ensure_image(image_context)?;
    ensure_volume(scope)?;

    if let Some(inspection) = inspect_container(scope)? {
        validate_owned_container(scope, &inspection)?;
        if inspection.image != IMAGE_TAG {
            checked(
                vec![
                    "container".into(),
                    "stop".into(),
                    container_name(scope).into(),
                ],
                "Fable could not stop the previous teammate computer.",
            )?;
            checked(
                vec![
                    "container".into(),
                    "rm".into(),
                    container_name(scope).into(),
                ],
                "Fable could not replace the previous teammate computer.",
            )?;
            create_container(scope)?;
        } else if !inspection.running {
            checked(
                vec![
                    "container".into(),
                    "start".into(),
                    container_name(scope).into(),
                ],
                "Fable could not start the teammate computer.",
            )?;
        }
    } else {
        create_container(scope)?;
    }

    wait_until_ready(scope)
}

pub(super) fn debugger_websocket_url(scope: &ComputerScope) -> Result<String, String> {
    let output = checked(
        vec![
            "exec".into(),
            container_name(scope).into(),
            "curl".into(),
            "--fail".into(),
            "--silent".into(),
            "--show-error".into(),
            "http://127.0.0.1:9222/json/version".into(),
        ],
        "Fable could not reach Chromium inside the teammate computer.",
    )?;
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The teammate computer returned invalid browser metadata.".to_string())?;
    let raw = value
        .get("webSocketDebuggerUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The teammate computer did not expose its browser session.".to_string())?;
    let port = published_debug_port(scope)?;
    let mut url = Url::parse(raw)
        .map_err(|_| "The teammate computer returned an invalid browser session.".to_string())?;
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| "The teammate computer browser session is invalid.".to_string())?;
    url.set_port(Some(port))
        .map_err(|_| "The teammate computer browser port is invalid.".to_string())?;
    Ok(url.to_string())
}

pub(super) fn capture_desktop(scope: &ComputerScope) -> Result<Vec<u8>, String> {
    let output = checked(
        vec![
            "exec".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-screenshot".into(),
        ],
        "Fable could not capture the teammate computer.",
    )?;
    if output.stdout.is_empty() || output.stdout.len() > MAX_DESKTOP_FRAME_BYTES {
        return Err("The teammate computer returned an invalid desktop frame.".into());
    }
    Ok(output.stdout)
}

pub(super) fn pointer(
    scope: &ComputerScope,
    x: u32,
    y: u32,
    action: &str,
    delta_y: Option<f64>,
) -> Result<(), String> {
    let mut args = vec![
        "exec".into(),
        container_name(scope).into(),
        "/usr/local/bin/fable-input".into(),
        "pointer".into(),
        action.into(),
        x.to_string().into(),
        y.to_string().into(),
    ];
    if action == "scroll" {
        args.push(delta_y.unwrap_or_default().round().to_string().into());
    }
    checked(
        args,
        "The teammate computer could not apply that pointer action.",
    )?;
    Ok(())
}

pub(super) fn key(scope: &ComputerScope, value: &str) -> Result<(), String> {
    checked(
        vec![
            "exec".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-input".into(),
            "key".into(),
            value.into(),
        ],
        "The teammate computer could not apply that key.",
    )?;
    Ok(())
}

pub(super) fn launch_application(scope: &ComputerScope, application: &str) -> Result<(), String> {
    checked(
        vec![
            "exec".into(),
            container_name(scope).into(),
            "/usr/local/bin/fable-launch-app".into(),
            application.into(),
        ],
        "The teammate computer could not open that application.",
    )?;
    Ok(())
}

pub(super) fn focus_browser(scope: &ComputerScope) -> Result<(), String> {
    launch_application(scope, "browser")
}

pub(super) fn run_shell(
    scope: &ComputerScope,
    command: &str,
) -> Result<LocalComputerShellResult, String> {
    if command.trim().is_empty() || command.chars().count() > MAX_SHELL_COMMAND_CHARACTERS {
        return Err("The terminal command must be between 1 and 16384 characters.".into());
    }
    if command.chars().any(|character| character == '\0') {
        return Err("The terminal command contains an invalid character.".into());
    }

    let mut process = docker_command();
    process.args([
        OsStr::new("exec"),
        OsStr::new("--user"),
        OsStr::new("fable"),
        OsStr::new("--workdir"),
        OsStr::new("/home/fable/Workspace"),
        OsStr::new(&container_name(scope)),
        OsStr::new("timeout"),
        OsStr::new("--signal=KILL"),
        OsStr::new("60s"),
        OsStr::new("/bin/bash"),
        OsStr::new("--noprofile"),
        OsStr::new("--norc"),
        OsStr::new("-lc"),
        OsStr::new(command),
    ]);
    let mut child = process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Fable could not start the isolated terminal command.".to_string())?;
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
    let status = child
        .wait()
        .map_err(|_| "Fable could not finish the isolated terminal command.".to_string())?;
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
    Ok(LocalComputerShellResult {
        exit_code: status.code().unwrap_or(137),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        truncated,
    })
}

fn ensure_image(image_context: &Path) -> Result<(), String> {
    if image_exists() {
        return Ok(());
    }
    let gate = IMAGE_BUILD_GATE.get_or_init(|| Mutex::new(()));
    let _guard = gate
        .lock()
        .map_err(|_| "The teammate computer image build state is unavailable.".to_string())?;
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

fn ensure_volume(scope: &ComputerScope) -> Result<(), String> {
    let name = volume_name(scope);
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
            name.into(),
        ],
        "Fable could not create persistent storage for the teammate computer.",
    )?;
    Ok(())
}

fn create_container(scope: &ComputerScope) -> Result<(), String> {
    let workspace = scope.directory.join("workspace");
    let mount = format!(
        "type=bind,source={},target=/home/fable/Workspace",
        workspace.display()
    );
    let home = format!(
        "type=volume,source={},target=/home/fable",
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
            format!("{OWNER_LABEL}=true").into(),
            "--label".into(),
            format!("{SCOPE_LABEL}={}", scope.key).into(),
            "--mount".into(),
            home.into(),
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
            // Debian Chromium's SUID helper needs these four bounded
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
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,size=512m".into(),
            "--tmpfs".into(),
            "/run:rw,nosuid,nodev,size=64m".into(),
            "--restart".into(),
            "unless-stopped".into(),
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
        "Fable could not create the teammate computer.",
    )?;
    Ok(())
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
    Err("The teammate computer did not become ready in time.".into())
}

fn inspect_container(scope: &ComputerScope) -> Result<Option<ContainerInspection>, String> {
    let output = docker_output([
        OsStr::new("container"),
        OsStr::new("inspect"),
        OsStr::new("--format"),
        OsStr::new("{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Config.Image}}|{{ index .Config.Labels \"com.fable.local-computer\" }}|{{ index .Config.Labels \"com.fable.scope\" }}"),
        OsStr::new(&container_name(scope)),
    ])
    .map_err(|_| "Fable could not inspect the teammate computer.".to_string())?;
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
    if fields.next().is_some() {
        return Err("The teammate computer returned invalid lifecycle metadata.".into());
    }
    Ok(Some(ContainerInspection {
        running,
        healthy: running && matches!(health, "healthy" | "none"),
        image,
        owner_label,
        scope_label,
    }))
}

fn validate_owned_container(
    scope: &ComputerScope,
    inspection: &ContainerInspection,
) -> Result<(), String> {
    if inspection.owner_label != "true" || inspection.scope_label != scope.key {
        return Err("The teammate computer name is already owned by another resource.".into());
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
        "Fable could not resolve the teammate browser port.",
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    let port = text
        .lines()
        .find_map(|line| line.trim().rsplit_once(':').map(|(_, port)| port))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "The teammate browser port is invalid.".to_string())?;
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
}
