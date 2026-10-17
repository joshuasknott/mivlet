use super::*;
use crate::security::{self, wide, Handle};
use std::{
    fs::File,
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{
        Authorization::ConvertStringSidToSidW, Isolation::GetAppContainerNamedObjectPath, *,
    },
    Storage::FileSystem::*,
    System::{JobObjects::*, Pipes::*, Threading::*, IO::*},
};

#[derive(Clone)]
pub(super) struct Endpoint {
    writer: Option<Arc<Mutex<File>>>,
    job: Arc<Mutex<Handle>>,
    profile: String,
}
fn duplicate(handle: HANDLE) -> Result<Handle, String> {
    let mut copy = ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(security::error("Duplicate restricted session custody"));
    }
    Handle::checked(copy, "Retain restricted session custody")
}
impl Endpoint {
    pub(super) fn new(writer: Option<Handle>, job: &Handle, profile: &str) -> Result<Self, String> {
        let job = duplicate(job.0)?;
        let writer = writer.map(|writer| {
            // The child's explicit handle list contains only its stdin reader.
            unsafe {
                SetHandleInformation(writer.0, HANDLE_FLAG_INHERIT, 0);
            }
            let file = unsafe { File::from_raw_handle(writer.0) };
            std::mem::forget(writer);
            Arc::new(Mutex::new(file))
        });
        Ok(Self {
            writer,
            job: Arc::new(Mutex::new(job)),
            profile: profile.into(),
        })
    }
    pub(super) fn stop(&self) {
        if let Ok(job) = self.job.lock() {
            unsafe {
                TerminateJobObject(job.0, 1);
            }
        }
    }
    pub(super) fn write_input(
        &self,
        control: SessionControl,
        text: String,
    ) -> Result<InputDelivery, String> {
        let writer = self
            .writer
            .clone()
            .ok_or("This session has no approved stdin.")?;
        let owner = control.clone();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("mivlet-session-input".into())
            .spawn(move || {
                let result = (|| {
                    let mut writer = writer.lock().map_err(|_| "Session input is unavailable.")?;
                    owner.check(&owner.0.binding)?;
                    writer
                        .write_all(text.as_bytes())
                        .map_err(|_| "Session input delivery is uncertain.".to_owned())
                })();
                let _ = send.send(result);
            })
            .map_err(|_| "Cannot start the bounded session writer.")?;
        if matches!(receive.recv_timeout(Duration::from_secs(2)), Ok(Ok(())))
            && control.check(&control.0.binding).is_ok()
        {
            Ok(InputDelivery::Accepted)
        } else {
            control.0.cancel.store(true, Ordering::Release);
            self.stop();
            Ok(InputDelivery::Uncertain)
        }
    }
    pub(super) fn open_preview(
        &self,
        spec: &PreviewSpec,
        control: SessionControl,
    ) -> Result<PreviewStream, String> {
        // LOCAL is relative to the creating AppContainer, not the desktop
        // broker. Resolve its exact native namespace from our retained SID.
        let leaf = spec
            .pipe_name
            .strip_prefix(r"\\.\pipe\LOCAL\")
            .ok_or("The private preview pipe identity is invalid.")?;
        let mut sid = ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(wide(&self.profile).as_ptr(), &mut sid) } == 0 {
            return Err(security::error(
                "Resolve private preview namespace identity",
            ));
        }
        let mut object_path = vec![0u16; 4096];
        let mut length = 0;
        let resolved = unsafe {
            GetAppContainerNamedObjectPath(
                ptr::null_mut(),
                sid,
                object_path.len() as u32,
                object_path.as_mut_ptr(),
                &mut length,
            )
        };
        unsafe {
            LocalFree(sid.cast());
        }
        if resolved == 0 || length == 0 || length as usize > object_path.len() {
            return Err(security::error("Resolve private preview namespace"));
        }
        let end = object_path
            .iter()
            .position(|unit| *unit == 0)
            .ok_or("The private preview namespace is invalid.")?;
        let object_path = String::from_utf16(&object_path[..end])
            .map_err(|_| "The private preview namespace is invalid.")?;
        if !object_path.starts_with('\\') || !object_path.ends_with(&self.profile) {
            return Err("The private preview namespace changed identity.".into());
        }
        let name = wide(format!(r"\\.\pipe{object_path}\{leaf}"));
        unsafe {
            WaitNamedPipeW(name.as_ptr(), 200);
        }
        let raw = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        };
        let handle = Handle::checked(raw, "Open the approved private HTTP preview")?;
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(handle.0, &mut pid) } == 0 || pid == 0 {
            return Err("The private preview server identity is unavailable.".into());
        }
        // Hold the process identity through both pipe PID observations. No PID
        // lookup or renderer URL can establish command-session membership.
        let process = Handle::checked(
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) },
            "Verify the private preview server",
        )?;
        let mut member = 0;
        let job = self
            .job
            .lock()
            .map_err(|_| "Preview Job custody is unavailable.")?;
        if unsafe { IsProcessInJob(process.0, job.0, &mut member) } == 0
            || member != 1
            || unsafe { WaitForSingleObject(process.0, 0) } != WAIT_TIMEOUT
        {
            return Err("The preview server does not belong to this active restricted Job.".into());
        }
        drop(job);
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) } == 0 {
            return Err(security::error("Verify preview AppContainer"));
        }
        let token = Handle::checked(token, "Read preview AppContainer")?;
        let mut is_container = 0u32;
        let mut token_size = 0;
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenIsAppContainer,
                ptr::addr_of_mut!(is_container).cast(),
                size_of::<u32>() as u32,
                &mut token_size,
            )
        } == 0
            || is_container != 1
        {
            return Err("The preview server is not an AppContainer process.".into());
        }
        let mut bytes = 0;
        unsafe {
            GetTokenInformation(
                token.0,
                TokenAppContainerSid,
                ptr::null_mut(),
                0,
                &mut bytes,
            );
        }
        if bytes == 0 || bytes > 4096 {
            return Err("The preview AppContainer identity is invalid.".into());
        }
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenAppContainerSid,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            )
        } == 0
        {
            return Err(security::error("Read preview AppContainer"));
        }
        let sid = unsafe {
            (*(buffer.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>())).TokenAppContainer
        };
        if sid.is_null() || security::sid_text(sid)? != self.profile {
            return Err("The preview AppContainer changed.".into());
        }
        security::verify_lpac(token.0, &self.profile)?;
        let mut current_pid = 0;
        if unsafe { GetNamedPipeServerProcessId(handle.0, &mut current_pid) } == 0
            || current_pid != pid
        {
            return Err("The private preview peer changed during verification.".into());
        }
        let file = unsafe { File::from_raw_handle(handle.0) };
        std::mem::forget(handle);
        Ok(PreviewStream { file, control })
    }
}

/// One private byte stream, with bounded overlapped operations. Cloning retains
/// the verified connection; it never reopens a path or trusts a reported PID.
pub struct PreviewStream {
    file: File,
    control: SessionControl,
}
impl PreviewStream {
    pub fn try_clone(&self) -> io::Result<Self> {
        self.control
            .check(&self.control.0.binding)
            .map_err(io::Error::other)?;
        Ok(Self {
            file: self.file.try_clone()?,
            control: self.control.clone(),
        })
    }
    fn transfer(&self, read: bool, buffer: *mut u8, size: usize) -> io::Result<usize> {
        self.control
            .check(&self.control.0.binding)
            .map_err(|_| io::Error::from(io::ErrorKind::ConnectionAborted))?;
        if size == 0 {
            return Ok(0);
        }
        let event = Handle::checked(
            unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) },
            "Observe private preview I/O",
        )
        .map_err(io::Error::other)?;
        let mut operation: OVERLAPPED = unsafe { zeroed() };
        operation.hEvent = event.0;
        let raw = self.file.as_raw_handle() as HANDLE;
        let amount = size.min(64 * 1024) as u32;
        let mut transferred = 0;
        let started = unsafe {
            if read {
                ReadFile(raw, buffer, amount, &mut transferred, &mut operation)
            } else {
                WriteFile(
                    raw,
                    buffer.cast_const(),
                    amount,
                    &mut transferred,
                    &mut operation,
                )
            }
        };
        if started != 0 {
            return Ok(transferred as usize);
        }
        if unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        let timed_out = unsafe { WaitForSingleObject(event.0, 2000) } != WAIT_OBJECT_0;
        if timed_out {
            unsafe {
                CancelIoEx(raw, &operation);
            }
        }
        // Reap this exact OVERLAPPED before its stack buffer/event can drop.
        // Named-pipe cancellation does not close or poison the duplex stream.
        let completed = unsafe { GetOverlappedResult(raw, &operation, &mut transferred, 1) };
        if completed != 0 || transferred > 0 {
            return Ok(transferred as usize);
        }
        if timed_out {
            Err(io::ErrorKind::TimedOut.into())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}
impl Read for PreviewStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.transfer(true, buffer.as_mut_ptr(), buffer.len())
    }
}
impl Write for PreviewStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.transfer(false, buffer.as_ptr().cast_mut(), buffer.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
