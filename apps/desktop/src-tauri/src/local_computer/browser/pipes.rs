//! Already-connected local pipe pairs. Main-process handles are never inheritable.
//! Overlapped parent I/O keeps native Stop independent of a stalled browser.
use std::{
    fs::File,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{Pipes::*, Threading::*, IO::*},
};

const FAILURE: &str = "The private browser pipe failed. No browser input was retried.";
const MAX_FRAME: usize = 1024 * 1024;

#[cfg(test)]
#[path = "pipes_tests.rs"]
mod tests;

pub(super) struct Pair {
    pub parent: File,
    pub child: File,
}
impl Pair {
    pub(super) fn new(parent_reads: bool) -> Result<Self, String> {
        let mut nonce = [0u8; 32];
        getrandom::fill(&mut nonce)
            .map_err(|_| "The private browser pipe identity is unavailable.")?;
        let name: Vec<u16> = format!("\\\\.\\pipe\\mivlet-browser-{}", hex::encode(nonce))
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let server = CreateNamedPipeW(
                name.as_ptr(),
                FILE_FLAG_FIRST_PIPE_INSTANCE
                    | FILE_FLAG_OVERLAPPED
                    | if parent_reads {
                        PIPE_ACCESS_INBOUND
                    } else {
                        PIPE_ACCESS_OUTBOUND
                    },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                std::ptr::null(),
            );
            if server == INVALID_HANDLE_VALUE {
                return Err(FAILURE.into());
            }
            let parent = File::from_raw_handle(server);
            let mut connection = Pending::new(&parent)?;
            let connected = ConnectNamedPipe(server, &mut connection.overlapped) != 0;
            if !connected && GetLastError() != ERROR_IO_PENDING {
                return Err(FAILURE.into());
            }
            connection.pending = !connected;
            let client = CreateFileW(
                name.as_ptr(),
                if parent_reads {
                    GENERIC_WRITE
                } else {
                    GENERIC_READ
                },
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            );
            if client == INVALID_HANDLE_VALUE {
                return Err(FAILURE.into());
            }
            let child = File::from_raw_handle(client);
            connection.wait(Instant::now() + Duration::from_secs(2), &|| Ok(()))?;
            let mut peer = 0;
            if GetNamedPipeClientProcessId(server, &mut peer) == 0 || peer != GetCurrentProcessId()
            {
                return Err("The private browser pipe connected to a different process.".into());
            }
            drop(connection);
            Ok(Self { parent, child })
        }
    }
    pub(super) fn child_id(&self) -> usize {
        self.child.as_raw_handle() as usize
    }
}

struct Pending<'a> {
    file: &'a File,
    _event: OwnedHandle,
    overlapped: OVERLAPPED,
    pending: bool,
}
impl<'a> Pending<'a> {
    fn new(file: &'a File) -> Result<Self, String> {
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(FAILURE.into());
        }
        Ok(Self {
            file,
            _event: unsafe { OwnedHandle::from_raw_handle(event) },
            overlapped: OVERLAPPED {
                hEvent: event,
                ..Default::default()
            },
            pending: false,
        })
    }
    fn wait(
        &mut self,
        deadline: Instant,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<u32, String> {
        loop {
            check()?;
            if Instant::now() >= deadline {
                return Err("The private browser pipe timed out.".into());
            }
            let mut count = 0;
            unsafe {
                if GetOverlappedResultEx(
                    self.file.as_raw_handle(),
                    &self.overlapped,
                    &mut count,
                    25,
                    0,
                ) != 0
                {
                    self.pending = false;
                    return Ok(count);
                }
                if !matches!(GetLastError(), WAIT_TIMEOUT | ERROR_IO_INCOMPLETE) {
                    return Err(FAILURE.into());
                }
            }
        }
    }
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.pending {
            unsafe {
                CancelIoEx(self.file.as_raw_handle(), &self.overlapped);
                let mut count = 0;
                // Kernel ownership of the buffer/OVERLAPPED must end before either is freed.
                // No authority, lease or response lock is held during cancellation cleanup.
                GetOverlappedResult(self.file.as_raw_handle(), &self.overlapped, &mut count, 1);
            }
        }
    }
}

fn transfer(
    file: &File,
    buffer: &mut [u8],
    write: bool,
    deadline: Instant,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<usize, String> {
    check()?;
    let mut operation = Pending::new(file)?;
    let mut count = 0;
    let completed = unsafe {
        if write {
            WriteFile(
                file.as_raw_handle(),
                buffer.as_ptr(),
                buffer.len() as u32,
                &mut count,
                &mut operation.overlapped,
            )
        } else {
            ReadFile(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut count,
                &mut operation.overlapped,
            )
        }
    };
    if completed == 0 {
        if unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(FAILURE.into());
        }
        operation.pending = true;
        count = operation.wait(deadline, check)?;
    }
    check()?;
    if count == 0 || count as usize > buffer.len() {
        return Err(FAILURE.into());
    }
    Ok(count as usize)
}

pub(super) struct Framed {
    file: File,
    buffered: Vec<u8>,
}
impl Framed {
    pub(super) fn new(file: File) -> Self {
        Self {
            file,
            buffered: Vec::new(),
        }
    }
    pub(super) fn read(
        &mut self,
        deadline: Instant,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        loop {
            check()?;
            if let Some(end) = self.buffered.iter().position(|byte| *byte == 0) {
                let rest = self.buffered.split_off(end + 1);
                let mut result = std::mem::replace(&mut self.buffered, rest);
                result.pop();
                return Ok(result);
            }
            if self.buffered.len() >= MAX_FRAME {
                return Err("The private browser response exceeded its limit.".into());
            }
            let mut chunk = [0u8; 4096];
            let size = transfer(&self.file, &mut chunk, false, deadline, check)?;
            self.buffered.extend_from_slice(&chunk[..size]);
            if self.buffered.len() > MAX_FRAME {
                return Err("The private browser response exceeded its limit.".into());
            }
        }
    }
}
pub(super) fn write(
    file: &File,
    message: &[u8],
    deadline: Instant,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    if message.len() > 4096 || message.contains(&0) {
        return Err("The private browser request exceeded its limit.".into());
    }
    let mut frame = message.to_vec();
    frame.push(0);
    let mut offset = 0;
    while offset < frame.len() {
        offset += transfer(file, &mut frame[offset..], true, deadline, check)?;
    }
    Ok(())
}

/// Start exactly one framed write under the native dispatch fence. No waiting,
/// loop, flush or partial-write retry can hold its Stop/authority locks.
fn write_once(
    file: &File,
    message: &[u8],
    deadline: Instant,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    if message.len() > 4096 || message.contains(&0) {
        return Err("The private browser request exceeded its limit.".into());
    }
    let mut frame = message.to_vec();
    frame.push(0);
    let mut operation = Pending::new(file)?;
    let mut count = 0;
    check()?;
    dispatch(&mut || {
        let completed = unsafe {
            WriteFile(
                file.as_raw_handle(),
                frame.as_ptr(),
                frame.len() as u32,
                &mut count,
                &mut operation.overlapped,
            )
        };
        if completed == 0 {
            if unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(FAILURE.into());
            }
            operation.pending = true;
        }
        Ok(())
    })?;
    if operation.pending {
        count = operation.wait(deadline, check)?;
    }
    check()?;
    if count as usize != frame.len() {
        return Err("The navigation write was not confirmed. Its outcome is uncertain; input was not retried.".into());
    }
    Ok(())
}

pub(super) struct ControlPipe {
    pub input: File,
    pub output: Framed,
    sequence: u32,
    interrupted: bool,
}

/// Closed native protocol surface. Navigation additionally requires the native
/// dispatch fence; no method name comes from an agent.
#[derive(Clone, Copy)]
pub(super) enum Command {
    Version,
    Targets,
    Window,
    Attach,
    Frames,
    Accessibility,
    DescribeNode,
    Navigate,
    Activate,
    Quads,
    Layout,
    Hit,
    Click,
    Scroll,
    IsolatedWorld,
    Visibility,
}
impl Command {
    fn method(&self) -> &'static str {
        match self {
            Self::Version => "Browser.getVersion",
            Self::Targets => "Target.getTargets",
            Self::Window => "Browser.getWindowForTarget",
            Self::Attach => "Target.attachToTarget",
            Self::Frames => "Page.getFrameTree",
            Self::Accessibility => "Accessibility.getFullAXTree",
            Self::DescribeNode => "DOM.describeNode",
            Self::Navigate => "Page.navigate",
            Self::Activate => "Target.activateTarget",
            Self::Quads => "DOM.getContentQuads",
            Self::Layout => "Page.getLayoutMetrics",
            Self::Hit => "DOM.getNodeForLocation",
            Self::Click => "Input.synthesizeTapGesture",
            Self::Scroll => "Input.dispatchMouseEvent",
            Self::IsolatedWorld => "Page.createIsolatedWorld",
            Self::Visibility => "Runtime.evaluate",
        }
    }
}
impl ControlPipe {
    pub(super) fn new(input: File, output: File) -> Self {
        Self {
            input,
            output: Framed::new(output),
            sequence: 0,
            interrupted: false,
        }
    }
    pub(super) fn read_command(
        &mut self,
        command: Command,
        params: serde_json::Value,
        session: Option<&str>,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<serde_json::Value, String> {
        if matches!(
            command,
            Command::Navigate | Command::Activate | Command::Click | Command::Scroll
        ) {
            return Err("Browser input requires the native dispatch fence.".into());
        }
        if matches!(command, Command::IsolatedWorld | Command::Visibility) {
            return Err("Only the fixed native visibility probe may create or evaluate its private context.".into());
        }
        self.exchange(command, params, session, check, None)
    }

    /// Only this fixed read may evaluate code. It exposes no caller expression,
    /// command-line API, user gesture, page values, CSP bypass or universal access.
    pub(super) fn visible(
        &mut self,
        frame: &str,
        session: &str,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<bool, String> {
        let world = self.exchange(
            Command::IsolatedWorld,
            serde_json::json!({"frameId":frame,"worldName":"mivlet-native-visibility-v1", "grantUniveralAccess":false,
                "contentSecurityPolicy":"default-src 'none'; script-src 'none'"}),
            Some(session), check, None,
        )?;
        let context = world["executionContextId"]
            .as_u64()
            .filter(|id| *id > 0 && *id <= i32::MAX as u64)
            .ok_or("The browser visibility context is unavailable.")?;
        let result = self.exchange(
            Command::Visibility,
            serde_json::json!({"expression":"document.visibilityState","contextId":context,
                "returnByValue":true,"includeCommandLineAPI":false,"silent":true,"userGesture":false,
                "awaitPromise":false,"throwOnSideEffect":true,"timeout":100,"disableBreaks":true,
                "replMode":false,"allowUnsafeEvalBlockedByCSP":false}),
            Some(session), check, None,
        )?;
        visibility(&result)
    }

    pub(super) fn navigate(
        &mut self,
        params: serde_json::Value,
        session: &str,
        check: &dyn Fn() -> Result<(), String>,
        dispatch: &super::super::super::control::NativeDispatch<'_>,
    ) -> Result<serde_json::Value, String> {
        self.exchange(
            Command::Navigate,
            params,
            Some(session),
            check,
            Some(dispatch),
        )
    }
    pub(super) fn activate(
        &mut self,
        target: &str,
        check: &dyn Fn() -> Result<(), String>,
        dispatch: &super::super::super::control::NativeDispatch<'_>,
    ) -> Result<serde_json::Value, String> {
        self.exchange(
            Command::Activate,
            serde_json::json!({"targetId":target}),
            None,
            check,
            Some(dispatch),
        )
    }

    pub(super) fn click(
        &mut self,
        params: serde_json::Value,
        session: &str,
        check: &dyn Fn() -> Result<(), String>,
        dispatch: &super::super::super::control::NativeDispatch<'_>,
    ) -> Result<serde_json::Value, String> {
        self.exchange(Command::Click, params, Some(session), check, Some(dispatch))
    }

    pub(super) fn scroll(
        &mut self,
        params: serde_json::Value,
        session: &str,
        check: &dyn Fn() -> Result<(), String>,
        dispatch: &super::super::super::control::NativeDispatch<'_>,
    ) -> Result<serde_json::Value, String> {
        self.exchange(
            Command::Scroll,
            params,
            Some(session),
            check,
            Some(dispatch),
        )
    }

    fn exchange(
        &mut self,
        command: Command,
        params: serde_json::Value,
        session: Option<&str>,
        check: &dyn Fn() -> Result<(), String>,
        dispatch: Option<&super::super::super::control::NativeDispatch<'_>>,
    ) -> Result<serde_json::Value, String> {
        if self.interrupted {
            return Err("The browser's private connection was interrupted. The page remains yours; close its window and open a fresh Mivlet browser to resume agent reads.".into());
        }
        let result = (|| {
            self.sequence = self.sequence.checked_add(1).ok_or(FAILURE)?;
            let mut message =
                serde_json::json!({"id":self.sequence,"method":command.method(),"params":params});
            if let Some(session) = session {
                message["sessionId"] = session.into();
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let message = message.to_string();
            if let Some(dispatch) = dispatch {
                write_once(&self.input, message.as_bytes(), deadline, check, dispatch)?;
            } else {
                write(&self.input, message.as_bytes(), deadline, check)?;
            }
            // Protocol events are private and bounded; only the exact reply is consumed.
            for _ in 0..64 {
                let mut response: serde_json::Value =
                    serde_json::from_slice(&self.output.read(deadline, check)?)
                        .map_err(|_| FAILURE)?;
                if response.get("id").is_none() && response["method"].is_string() {
                    continue;
                }
                if response["id"]
                    .as_u64()
                    .is_some_and(|id| id < self.sequence.into())
                {
                    continue;
                }
                if response["id"].as_u64() != Some(self.sequence.into())
                    || response.get("error").is_some()
                    || response["sessionId"].as_str() != session
                    || !response["result"].is_object()
                {
                    return Err(FAILURE.into());
                }
                check()?;
                return Ok(response["result"].take());
            }
            Err(FAILURE.into())
        })();
        if result.is_err() {
            // A cancelled partial frame cannot be replayed or reused by a later turn.
            // Keep both handles alive so loss of control does not close the user's page.
            self.interrupted = true;
        }
        result
    }
    /// Only a fixed native readiness probe; no public CDP method or JavaScript surface.
    pub(super) fn verify(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        let response = self.read_command(Command::Version, serde_json::json!({}), None, check)?;
        let product = response["product"].as_str().unwrap_or("");
        if response["protocolVersion"] != "1.3"
            || product.len() > 100
            || !product.starts_with("Chrome/")
        {
            return Err(
                "The installed browser did not prove a supported private pipe protocol.".into(),
            );
        }
        check()
    }
}

fn visibility(value: &serde_json::Value) -> Result<bool, String> {
    if value.get("exceptionDetails").is_some() || value["result"]["type"] != "string" {
        return Err(
            "The browser could not verify its visible tab. No input was dispatched.".into(),
        );
    }
    match value["result"]["value"].as_str() {
        Some("visible") => Ok(true),
        Some("hidden") => Ok(false),
        _ => Err(
            "The browser returned an unsupported visibility state. No input was dispatched.".into(),
        ),
    }
}
