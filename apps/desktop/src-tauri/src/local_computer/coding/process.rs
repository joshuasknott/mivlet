//! Fixed native programs only. Repository commands run exclusively in Bubblewrap.
use super::super::authority::OperationTicket;
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const LIMIT: usize = 64 * 1024;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub interrupted: bool,
    #[serde(default)]
    pub redacted: bool,
}

pub fn command(program: &str, cwd: &Path) -> Result<Command, String> {
    if !matches!(program, "git" | "gh" | "wsl.exe") {
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
    // Closing this pipe also stops the Linux process tree via the fixed supervisor.
    let input = child.stdin.take();
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
            drop(input);
            // Give the Linux supervisor time to reap its namespace before terminating WSL.
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
                std::thread::sleep(Duration::from_millis(25));
            }
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

// stdin is a private lifetime pipe, not model input. EOF on Stop/crash kills the
// PID namespace; children cannot detach from it. No WSL host shell is invoked.
const SUPERVISOR: &str = "import os,subprocess,sys,threading\np=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL)\ndef stop():\n os.read(0,1)\n try: p.kill()\n except ProcessLookupError: pass\nthreading.Thread(target=stop,daemon=True).start()\nsys.exit(p.wait())\n";

pub fn sandbox(
    root: &Path,
    script: &str,
    network: bool,
    ticket: &OperationTicket,
) -> Result<Command, String> {
    if !cfg!(windows) {
        return Err("Repository execution currently requires Windows with WSL Ubuntu, Bubblewrap and Python 3.".into());
    }
    // Native launchers also stay outside the project cwd (including Windows
    // DLL search); only the Linux sandbox changes directory into /repo.
    let native_cwd = root.parent().ok_or("Invalid managed checkout path.")?;
    let mut convert = command("wsl.exe", native_cwd)?;
    let windows_path = root.to_string_lossy();
    convert
        .args([
            "--distribution",
            "Ubuntu",
            "--exec",
            "/usr/bin/wslpath",
            "-u",
        ])
        .arg(
            windows_path
                .strip_prefix("\\\\?\\")
                .unwrap_or(&windows_path),
        );
    let linux = checked(convert, ticket).map_err(|_| "Install WSL Ubuntu with bubblewrap, python3 and your project's Linux build tools. No Windows shell fallback is available.")?;
    let mut cmd = command("wsl.exe", native_cwd)?;
    cmd.args([
        "--distribution",
        "Ubuntu",
        "--exec",
        "/usr/bin/python3",
        "-I",
        "-c",
        SUPERVISOR,
        "/usr/bin/bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/home",
        "--dir",
        "/home/agent",
        "--clearenv",
        "--setenv",
        "HOME",
        "/home/agent",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "CI",
        "1",
        "--bind",
        &linux,
        "/repo",
        "--chdir",
        "/repo",
    ]);
    if network {
        cmd.args([
            "--share-net",
            "--ro-bind",
            "/etc/resolv.conf",
            "/etc/resolv.conf",
            "--ro-bind",
            "/etc/ssl/certs",
            "/etc/ssl/certs",
        ]);
    }
    cmd.args(["--", "/bin/sh", "-c", script]);
    Ok(cmd)
}
