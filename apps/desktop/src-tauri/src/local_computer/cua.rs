//! Pinned, private stdio transport. No Cua method or process handle crosses IPC.
//! One request is outstanding at a time. Stop never waits for its response lock.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::Duration,
};

pub(super) const VERSION: &str = "0.25.0";
const EXE_SHA256: &str = "57919fe31bf91b7ff8af35630fdb3d31ed92fd1c333b9e9678a508cecd476719";
const MAX_FRAME: usize = 12 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const INPUT_TOOLS: &[&str] = &[
    "get_window_state",
    "click",
    "type_text",
    "scroll",
    "press_key",
];

pub(super) struct Driver {
    _image: File,
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Mutex<Option<ProcessJob>>,
    stdin: Mutex<ChildStdin>,
    replies: Mutex<mpsc::Receiver<Result<Value, String>>>,
    serial: Mutex<()>,
    next_id: AtomicU64,
    stopped: AtomicBool,
    terminated: Arc<AtomicBool>,
    #[cfg(test)]
    dispatched: AtomicU64,
    _directory: tempfile::TempDir,
}

pub(super) fn verified_executable(directory: &Path) -> Result<File, String> {
    let path = directory.join("cua-driver.exe");
    crate::paths::strict_canonicalize(&path).map_err(|_| {
        "The bundled Windows computer runtime is missing. Repair the Mivlet installation."
            .to_string()
    })?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "The Windows computer runtime cannot be opened.")?;
    let size = file
        .metadata()
        .map_err(|_| "The Windows runtime cannot be inspected.")?
        .len();
    if size > 80 * 1024 * 1024 {
        return Err("The bundled Windows runtime is invalid.".into());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "The Windows runtime cannot be verified.")?;
    if hex::encode(Sha256::digest(bytes)) != EXE_SHA256 {
        return Err("The Windows computer runtime checksum does not match this Mivlet release. Repair the installation.".into());
    }
    Ok(file)
}

pub(super) fn bounded_manifest((pid, window_id): (u32, u64)) -> Value {
    json!({
        "version":3,"expires_after":"30m","idle_timeout":"5m",
        "resources":{"desktop":{"windows":[{"pid":pid,"window_id":window_id}]}},
        "allow":{"tools":INPUT_TOOLS}
    })
}

impl Driver {
    pub(super) fn start(directory: &Path, target: (u32, u64)) -> Result<Arc<Self>, String> {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err("Native computer use currently requires Windows x64.".into());
        }
        let image = verified_executable(directory)?;
        let private = tempfile::Builder::new()
            .prefix("mivlet-cua-")
            .tempdir()
            .map_err(|_| "Mivlet could not prepare its private driver process.")?;
        let manifest = private.path().join("capabilities.json");
        std::fs::write(&manifest, bounded_manifest(target).to_string())
            .map_err(|_| "Mivlet could not bind driver permissions.")?;
        let mut command = Command::new(directory.join("cua-driver.exe"));
        command
            .args(["mcp", "--direct", "--no-overlay"])
            .env_clear()
            .current_dir(private.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // No provider credentials, inherited Cua permissions, plugins, or agent config.
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "false")
            .env("CUA_DRIVER_RS_UPDATE_CHECK", "false")
            .env("CUA_DRIVER_RS_HOME", private.path())
            .env("CUA_DRIVER_TELEMETRY_HOME", private.path())
            .env("CUA_DRIVER_PERMISSION_MODE", "bounded")
            .env("CUA_DRIVER_CAPABILITY_MANIFEST_FILE", &manifest)
            .env("CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED", "true");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Mivlet could not launch the bundled Windows driver.")?;
        #[cfg(windows)]
        let job = match ProcessJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or("The computer driver input pipe is unavailable.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The computer driver output pipe is unavailable.")?;
        let (tx, rx) = mpsc::sync_channel(2);
        std::thread::Builder::new().name("mivlet-cua-output".into()).spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let read = reader.by_ref().take((MAX_FRAME + 1) as u64).read_until(b'\n', &mut bytes);
                if !matches!(read, Ok(n) if n > 0) || bytes.len() > MAX_FRAME || bytes.last() != Some(&b'\n') {
                    let _ = tx.send(Err("The computer driver disconnected or exceeded its output limit. Fresh permission is required.".into()));
                    break;
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) if value.get("id").is_some() => { if tx.send(Ok(value)).is_err() { break; } },
                    Ok(_) => {}, // Protocol notifications cannot execute anything in Mivlet.
                    Err(_) => { let _ = tx.send(Err("The computer driver returned an invalid response.".into())); break; }
                }
            }
        }).map_err(|_| { let _ = child.kill(); "The computer driver reader could not start.".to_string() })?;
        let driver = Arc::new(Self {
            _image: image,
            child: Mutex::new(Some(child)),
            #[cfg(windows)]
            job: Mutex::new(Some(job)),
            stdin: Mutex::new(stdin),
            replies: Mutex::new(rx),
            serial: Mutex::new(()),
            next_id: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
            terminated: Arc::new(AtomicBool::new(false)),
            _directory: private,
            #[cfg(test)]
            dispatched: AtomicU64::new(0),
        });
        let initialized = driver.request("initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Mivlet","version":env!("CARGO_PKG_VERSION")}}))?;
        if initialized
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            != Some(VERSION)
            || initialized
                .pointer("/serverInfo/name")
                .and_then(Value::as_str)
                != Some("cua-driver")
        {
            driver.stop();
            return Err("The Windows computer driver version is incompatible.".into());
        }
        driver.write(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
        Ok(driver)
    }

    pub(super) fn serial(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.serial
            .lock()
            .map_err(|_| "Computer input is unavailable.".into())
    }

    // The per-lease atomic stopped flag is the final dispatch fence after Mivlet's
    // exact target/ticket checks. Stop never waits for the pipe or response locks.
    pub(super) fn dispatch(&self, name: &str, arguments: Value) -> Result<u64, String> {
        if !INPUT_TOOLS.contains(&name) {
            return Err("That driver method is not available to Mivlet.".into());
        }
        let result = self.send("tools/call", json!({"name":name,"arguments":arguments}));
        #[cfg(test)]
        if result.is_ok() {
            self.dispatched.fetch_add(1, Ordering::Release);
        }
        result
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        if !self.alive() {
            return Err("Computer control stopped. Fresh permission is required.".into());
        }
        let bytes = serde_json::to_vec(value).map_err(|_| "The computer request is invalid.")?;
        if bytes.len() > 3000 {
            return Err("The computer request is too large.".into());
        }
        let mut input = self
            .stdin
            .lock()
            .map_err(|_| "Computer input is unavailable.")?;
        if self.stopped.load(Ordering::Acquire) {
            return Err("Computer control stopped. Fresh permission is required.".into());
        }
        input.write_all(&bytes).and_then(|()| input.write_all(b"\n")).and_then(|()| input.flush())
            .map_err(|_| "The computer driver disconnected. The action outcome is uncertain; do not retry the input.".into())
    }

    fn send(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        Ok(id)
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let _serial = self.serial()?;
        let id = self.send(method, params)?;
        self.receive(id)
    }

    pub(super) fn receive(&self, id: u64) -> Result<Value, String> {
        let response = self
            .replies
            .lock()
            .map_err(|_| "Computer output is unavailable.")?
            .recv_timeout(TIMEOUT);
        match response {
            Ok(Ok(value))
                if value.get("id").and_then(Value::as_u64) == Some(id)
                    && value.get("result").is_some() =>
            {
                Ok(value["result"].clone())
            }
            _ => {
                self.stop();
                Err("The computer driver stopped responding. The action outcome is uncertain; do not retry input. Reconnect with fresh permission.".into())
            }
        }
    }

    pub(super) fn alive(&self) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        let running = self.child.lock().is_ok_and(|mut child| {
            child
                .as_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
        });
        if !running {
            self.stop();
        }
        running
    }
    #[cfg(test)]
    pub(super) fn dispatched(&self) -> u64 {
        self.dispatched.load(Ordering::Acquire)
    }

    pub(super) fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        if let Ok(mut job) = self.job.lock() {
            job.take();
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let terminated = self.terminated.clone();
                let _ = std::thread::Builder::new()
                    .name("mivlet-cua-reap".into())
                    .spawn(move || {
                        if child.wait().is_ok() {
                            terminated.store(true, Ordering::Release);
                        }
                    });
            }
        }
    }

    /// Used only by post-Stop window cleanup, never on the native Stop thread.
    pub(super) fn wait_stopped(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while !self.terminated.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.terminated.load(Ordering::Acquire)
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
struct ProcessJob(usize);
#[cfg(windows)]
impl ProcessJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The unnamed job owns only this freshly spawned driver and its descendants.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Mivlet could not create its computer process supervisor.".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                CloseHandle(handle);
                return Err(
                    "Mivlet could not supervise its computer driver. Control remains off.".into(),
                );
            }
            Ok(Self(handle as usize))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_grants_one_window_and_no_files_processes_or_plugins() {
        let value = bounded_manifest((12, 34));
        assert_eq!(
            value["resources"],
            json!({"desktop":{"windows":[{"pid":12,"window_id":34}]}})
        );
        assert_eq!(
            value["allow"]["tools"],
            json!([
                "get_window_state",
                "click",
                "type_text",
                "scroll",
                "press_key"
            ])
        );
        assert!(value.get("ask").is_none());
    }
    #[test]
    fn runtime_pin_agrees_with_packaging_manifest() {
        let value: Value =
            serde_json::from_str(include_str!("../../resources/cua-driver/runtime.json")).unwrap();
        assert_eq!(value["version"], VERSION);
        assert_eq!(value["executableSha256"], EXE_SHA256);
    }
}
