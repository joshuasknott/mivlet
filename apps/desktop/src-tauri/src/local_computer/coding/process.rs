//! Trusted Git/publication programs and the shared restricted Windows executor.
use super::super::authority::OperationTicket;
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const LIMIT: usize = 64 * 1024;

#[cfg(all(test, windows))]
pub(in crate::local_computer) struct NativeSentinel(std::process::Child);
#[cfg(all(test, windows))]
impl NativeSentinel {
    pub(in crate::local_computer) fn new() -> Self {
        Self(
            Command::new(execution_resources().unwrap().join("node/node.exe"))
                .args(["-e", "setTimeout(()=>{},120000)"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
    pub(in crate::local_computer) fn assert_alive(&mut self) {
        assert!(
            self.0.try_wait().unwrap().is_none(),
            "Stop killed an unrelated sentinel process"
        );
    }
}
#[cfg(all(test, windows))]
impl Drop for NativeSentinel {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[cfg(all(test, windows))]
pub(in crate::local_computer) fn native_work(
    binding: &mivlet_windows_executor::Binding,
) -> Option<PathBuf> {
    let expected = serde_json::to_value(binding).unwrap();
    std::fs::read_dir(mivlet_windows_executor::setup::ready().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::read(path.join("prepared.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|value| value["binding"] == expected)
        })
        .map(|path| path.join("work"))
}
#[cfg(all(test, windows))]
pub(in crate::local_computer) fn stop_after_native_ready(
    binding: &mivlet_windows_executor::Binding,
    stop: impl FnOnce(),
) {
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    let deadline = Instant::now() + Duration::from_secs(90);
    let (work, pid) = loop {
        if let Some(work) = native_work(binding) {
            if let Ok(bytes) = std::fs::read(work.join("native-stop-ready.json")) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    break (work, value["pid"].as_u64().unwrap() as u32);
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "Native command never signalled actual execution"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    // Retain the exact child's handle before Stop; PID reuse cannot turn this
    // into a probe of an unrelated process. This helper never kills by PID.
    let descendant = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    assert!(
        !descendant.is_null(),
        "Cannot observe the actual detached descendant"
    );
    stop();
    let status = unsafe { WaitForSingleObject(descendant, 5000) };
    unsafe {
        CloseHandle(descendant);
    }
    assert_eq!(status, WAIT_OBJECT_0, "Detached descendant survived Stop");
    std::thread::sleep(Duration::from_secs(4));
    assert!(!work.join("late.txt").exists());
}
#[cfg(all(test, windows))]
pub(in crate::local_computer) const NATIVE_STOP_SCRIPT: &str = r#"const fs=require('fs'),cp=require('child_process'); const child=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('late.txt','escape'),4000)"],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync('native-stop-ready.json',JSON.stringify({pid:child.pid}));setTimeout(()=>{},60000);"#;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub interrupted: bool,
    #[serde(default)]
    pub redacted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<serde_json::Value>,
}

pub fn command(program: &str, cwd: &Path) -> Result<Command, String> {
    if !matches!(program, "git" | "gh") {
        return Err("Unsupported native coding program.".into());
    }
    // Never search the project cwd for an executable planted by repository code.
    let name = if cfg!(windows) && !program.ends_with(".exe") {
        format!("{program}.exe")
    } else {
        program.into()
    };
    let executable = std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .filter(|part| part.is_absolute())
                .map(|part| part.join(&name))
                .find(|path| path.is_file())
        })
        .ok_or_else(|| {
            format!("Install {program} and restart Mivlet so it is available on PATH.")
        })?;
    let mut command = Command::new(executable);
    command.current_dir(cwd).env_clear();
    for key in ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

pub fn run(
    command: Command,
    ticket: &OperationTicket,
    timeout: u64,
) -> Result<CommandResult, String> {
    let mut result = capture(command, ticket, timeout)?;
    let safe = crate::secret_redaction::redact_secret_text_or_omit(&result.output);
    result.redacted = safe != result.output;
    result.output = safe;
    Ok(result)
}

// Only the publication adapter may consume this private, bounded credential pipe.
// It is never persisted, logged or returned as a tool result.
pub(super) fn credential(command: Command, ticket: &OperationTicket) -> Result<String, String> {
    let result = capture(command, ticket, 30)?;
    if result.interrupted
        || result.truncated
        || result.exit_code != Some(0)
        || result.output.trim().is_empty()
        || result.output.len() > 4096
        || !result
            .output
            .trim()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(
            "GitHub CLI login is unavailable or interrupted. Sign in with gh auth login.".into(),
        );
    }
    Ok(result.output.trim().to_owned())
}

fn capture(
    mut command: Command,
    ticket: &OperationTicket,
    timeout: u64,
) -> Result<CommandResult, String> {
    ticket.check()?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)?;
    drop(child.stdin.take());
    let output = Arc::new(Mutex::new((Vec::new(), false)));
    let readers: Vec<_> = [
        Box::new(child.stdout.take().ok_or("Missing stdout")?) as Box<dyn Read + Send>,
        Box::new(child.stderr.take().ok_or("Missing stderr")?) as Box<dyn Read + Send>,
    ]
    .into_iter()
    .map(|mut pipe| {
        let output = output.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(size) = pipe.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                if let Ok(mut out) = output.lock() {
                    let remaining = LIMIT.saturating_sub(out.0.len());
                    out.0.extend_from_slice(&buffer[..size.min(remaining)]);
                    out.1 |= size > remaining;
                }
            }
        })
    })
    .collect();
    let start = Instant::now();
    let (exit_code, interrupted) = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Command status is unavailable.")?
        {
            break (status.code(), false);
        }
        if ticket.check().is_err() || start.elapsed() >= Duration::from_secs(timeout) {
            child.terminate();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    for reader in readers {
        let _ = reader.join();
    }
    let out = output
        .lock()
        .map_err(|_| "Command output is unavailable.")?;
    Ok(CommandResult {
        exit_code,
        interrupted,
        truncated: out.1,
        redacted: false,
        output: String::from_utf8_lossy(&out.0).into_owned(),
        execution: None,
    })
}

pub fn checked(command: Command, ticket: &OperationTicket) -> Result<String, String> {
    let result = run(command, ticket, 120)?;
    if result.interrupted {
        return Err("Operation interrupted. Inspect repository status before retrying; effects may have occurred.".into());
    }
    if result.exit_code != Some(0) {
        return Err(format!("Operation failed: {}", result.output));
    }
    if result.truncated {
        return Err("Operation output exceeded its limit; narrow the request.".into());
    }
    if result.redacted {
        return Err("Operation output contains credential markers and cannot be used for Git or publication decisions.".into());
    }
    Ok(result.output.trim().to_owned())
}

static EXECUTION_RESOURCES: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn configure_execution_resources(path: PathBuf) -> Result<(), String> {
    if let Some(existing) = EXECUTION_RESOURCES.get() {
        if existing != &path {
            return Err("Native execution resources changed during this process.".into());
        }
    } else {
        let _ = EXECUTION_RESOURCES.set(path);
    }
    Ok(())
}

pub(crate) fn execution_resources() -> Result<PathBuf, String> {
    if let Some(path) = EXECUTION_RESOURCES.get() {
        return Ok(path.clone());
    }
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/execution-runtime/runtime"))
    } else {
        Err("Native execution resources are unavailable. Repair Mivlet.".into())
    }
}

pub(in crate::local_computer) fn native_run(
    root: &Path,
    script: &str,
    network: bool,
    timeout: u64,
    files: bool,
    ticket: &OperationTicket,
) -> Result<(CommandResult, mivlet_windows_executor::CompletedRun), String> {
    ticket.check()?;
    let completed = mivlet_windows_executor::run(
        &execution_resources()?,
        root,
        script,
        network,
        timeout,
        if files {
            mivlet_windows_executor::Limits::ANALYSIS
        } else {
            mivlet_windows_executor::Limits::CODING
        },
        ticket.execution_binding(),
        || ticket.check().is_ok(),
        |launch| ticket.with_current(launch),
    )?;
    let receipt = completed.receipt();
    let safe = crate::secret_redaction::redact_secret_text_or_omit(&receipt.output);
    let redacted = safe != receipt.output;
    let mut metadata =
        serde_json::to_value(receipt).map_err(|_| "Invalid native execution receipt.")?;
    if let Some(object) = metadata.as_object_mut() {
        object.remove("output");
    }
    let result = CommandResult {
        exit_code: receipt.exit_code,
        output: safe,
        truncated: receipt.truncated,
        interrupted: receipt.interrupted,
        redacted,
        execution: Some(metadata),
    };
    Ok((result, completed))
}
