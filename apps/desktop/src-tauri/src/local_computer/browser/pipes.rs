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

pub(super) struct ControlPipe {
    pub input: File,
    pub output: Framed,
    sequence: u32,
    interrupted: bool,
}

/// This is the complete native read surface. No method name comes from an agent.
pub(super) enum ReadCommand {
    Version,
    Targets,
    Window,
    Attach,
    Frames,
    Accessibility,
    DescribeNode,
    #[cfg(debug_assertions)]
    FixtureNavigate,
}
impl ReadCommand {
    fn method(&self) -> &'static str {
        match self {
            Self::Version => "Browser.getVersion",
            Self::Targets => "Target.getTargets",
            Self::Window => "Browser.getWindowForTarget",
            Self::Attach => "Target.attachToTarget",
            Self::Frames => "Page.getFrameTree",
            Self::Accessibility => "Accessibility.getFullAXTree",
            Self::DescribeNode => "DOM.describeNode",
            #[cfg(debug_assertions)]
            Self::FixtureNavigate => "Page.navigate",
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
        command: ReadCommand,
        params: serde_json::Value,
        session: Option<&str>,
        check: &dyn Fn() -> Result<(), String>,
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
            write(&self.input, message.to_string().as_bytes(), deadline, check)?;
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
        let response =
            self.read_command(ReadCommand::Version, serde_json::json!({}), None, check)?;
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
