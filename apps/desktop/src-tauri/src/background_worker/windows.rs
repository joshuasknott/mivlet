//! Windows logon-session IPC. Both peers verify the other process image before
//! exchanging a bounded frame. No bearer token is exposed to a WebView.
use super::{Status, PROTOCOL};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    mem::size_of,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::{JobObjects::*, Pipes::*, RemoteDesktop::ProcessIdToSessionId, Threading::*},
};

const LIMIT: usize = 4096;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

pub(super) struct Handle(usize);
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: uniquely owned, checked kernel handle; not inherited.
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

pub(crate) struct Owner {
    _file: File,
    _job: Handle,
}

fn file_lock(root: &Path, name: &str) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(root.join(name))
}

pub(crate) fn lock(root: &Path) -> std::io::Result<File> {
    file_lock(root, "background-owner.lock")
}

pub(crate) fn ready_lock(root: &Path) -> std::io::Result<File> {
    file_lock(root, "background-ready.lock")
}

pub(crate) fn ready(root: &Path) -> bool {
    matches!(ready_lock(root), Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32))
}

pub(crate) fn owner_alive(root: &Path) -> bool {
    // Only a sharing violation means another process holds the owner. Errors
    // other than this are not evidence of a live authenticated worker.
    matches!(lock(root), Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32))
}

impl Owner {
    pub(crate) fn acquire(root: &Path) -> Result<Self, String> {
        let file = lock(root)
            .map_err(|_| "Another background owner is active or its lock is unavailable.")?;
        // An inherited job can terminate this process when its launcher exits.
        // Do not claim detached ownership or request a containment breakaway.
        let mut inherited_job = 0;
        if unsafe { IsProcessInJob(GetCurrentProcess(), ptr::null_mut(), &mut inherited_job) } == 0
            || inherited_job != 0
        {
            return Err("This launch environment cannot detach a background worker. Start the installed app directly.".into());
        }
        // A job containing the worker and all descendants provides crash
        // containment, including embedded hosts and restricted command jobs.
        // Nested per-provider jobs retain their existing narrower limits.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err("Windows background supervision is unavailable.".into());
        }
        let job = Handle(job as usize);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 48;
        limits.JobMemoryLimit = 3 * 1024 * 1024 * 1024;
        // SAFETY: exact structure size and checked process/job handles.
        if unsafe {
            SetInformationJobObject(
                job.0 as HANDLE,
                JobObjectExtendedLimitInformation,
                ptr::addr_of!(limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job.0 as HANDLE, GetCurrentProcess()) == 0
        } {
            return Err("Windows could not contain the background process tree.".into());
        }
        Ok(Self {
            _file: file,
            _job: job,
        })
    }
}

pub(super) fn pipe_name(root: &Path) -> String {
    let key = Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes());
    format!(r"\\.\pipe\mivlet-background-{}", hex::encode(key))
}

fn logon_sid() -> Result<String, String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("Windows session identity is unavailable.".into());
    }
    let token = Handle(token as usize);
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.0 as HANDLE,
            TokenLogonSid,
            ptr::null_mut(),
            0,
            &mut length,
        );
    }
    if length == 0 || length > 65536 {
        return Err("Invalid Windows session identity.".into());
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0 as HANDLE,
            TokenLogonSid,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err("Windows session identity is unavailable.".into());
    }
    let groups = unsafe { &*(buffer.as_ptr().cast::<TOKEN_GROUPS>()) };
    if groups.GroupCount != 1 {
        return Err("Invalid Windows logon identity.".into());
    }
    let mut sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(groups.Groups[0].Sid, &mut sid) } == 0 {
        return Err("Windows session identity is unavailable.".into());
    }
    let mut count = 0;
    unsafe {
        while *sid.add(count) != 0 {
            count += 1;
        }
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid, count) });
    unsafe {
        LocalFree(sid.cast());
    }
    Ok(result)
}

pub(crate) fn server(root: &Path) -> Result<NamedPipeServer, String> {
    server_named(&pipe_name(root), true, 1, LIMIT)
}

pub(super) fn server_named(
    name: &str,
    first: bool,
    instances: usize,
    limit: usize,
) -> Result<NamedPipeServer, String> {
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})", logon_sid()?)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("Windows refused the private background IPC permissions.".into());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: the descriptor remains alive through CreateNamedPipe. Only the
    // current Windows logon SID is admitted; remote clients are rejected.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(instances)
            .in_buffer_size(limit as u32)
            .out_buffer_size(limit as u32)
            .create_with_security_attributes_raw(name, ptr::addr_of!(attributes).cast_mut().cast())
    };
    unsafe {
        LocalFree(descriptor);
    }
    result.map_err(|_| "The authenticated background endpoint is unavailable.".into())
}

pub(super) fn peer(pipe: HANDLE, is_server: bool) -> Result<Handle, String> {
    let mut pid = 0;
    let ok = unsafe {
        if is_server {
            GetNamedPipeClientProcessId(pipe, &mut pid)
        } else {
            GetNamedPipeServerProcessId(pipe, &mut pid)
        }
    };
    if ok == 0 || pid == 0 {
        return Err("Background IPC peer could not be authenticated.".into());
    }
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return Err("Background IPC peer is unavailable.".into());
    }
    let process = Handle(process as usize);
    let mut session = 0;
    let mut own_session = 0;
    let mut image = vec![0u16; 32768];
    let mut size = image.len() as u32;
    if unsafe {
        ProcessIdToSessionId(pid, &mut session) == 0
            || ProcessIdToSessionId(GetCurrentProcessId(), &mut own_session) == 0
            || session != own_session
            || WaitForSingleObject(process.0 as HANDLE, 0) != WAIT_TIMEOUT
            || QueryFullProcessImageNameW(process.0 as HANDLE, 0, image.as_mut_ptr(), &mut size)
                == 0
    } {
        return Err("Background IPC peer belongs to another session or has exited.".into());
    }
    let expected =
        std::env::current_exe().map_err(|_| "Mivlet executable identity is unavailable.")?;
    let actual = std::path::PathBuf::from(String::from_utf16_lossy(&image[..size as usize]));
    let expected = crate::paths::strict_canonicalize(&expected)
        .map_err(|_| "Mivlet executable is unavailable.")?;
    let actual = crate::paths::strict_canonicalize(&actual)
        .map_err(|_| "Background executable is unavailable.")?;
    if !actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
    {
        return Err("Background IPC accepts only this installed Mivlet executable.".into());
    }
    Ok(process)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
    Status,
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    account: String,
    action: Action,
}

async fn read<S: AsyncReadExt + Unpin, T: serde::de::DeserializeOwned>(
    stream: &mut S,
) -> Result<T, String> {
    read_frame(stream, LIMIT).await
}
pub(super) async fn read_frame<S: AsyncReadExt + Unpin, T: serde::de::DeserializeOwned>(
    stream: &mut S,
    limit: usize,
) -> Result<T, String> {
    let length = stream
        .read_u32_le()
        .await
        .map_err(|_| "Background IPC disconnected.")? as usize;
    if length == 0 || length > limit {
        return Err("Background IPC frame is too large.".into());
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| "Background IPC disconnected.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Background IPC frame is invalid.".into())
}
async fn write<S: AsyncWriteExt + Unpin, T: Serialize>(
    stream: &mut S,
    value: &T,
) -> Result<(), String> {
    write_frame(stream, value, LIMIT).await
}
pub(super) async fn write_frame<S: AsyncWriteExt + Unpin, T: Serialize>(
    stream: &mut S,
    value: &T,
    limit: usize,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Background IPC encoding failed.")?;
    if bytes.len() > limit {
        return Err("Background IPC frame is too large.".into());
    }
    stream
        .write_u32_le(bytes.len() as u32)
        .await
        .map_err(|_| "Background IPC disconnected.")?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| "Background IPC disconnected.".into())
}

pub(crate) async fn request(action: Action) -> Result<Status, String> {
    let root = crate::account_session::root()?;
    let mut pipe = ClientOptions::new()
        .open(pipe_name(root))
        .map_err(|_| "The background worker is not connected.")?;
    let _peer = peer(pipe.as_raw_handle() as HANDLE, false)?;
    tokio::time::timeout(TIMEOUT, async {
        write(
            &mut pipe,
            &Request {
                protocol: PROTOCOL,
                account: crate::account_session::binding()?.into(),
                action,
            },
        )
        .await?;
        let status: Status = read(&mut pipe).await?;
        if status.protocol != PROTOCOL {
            return Err("Restart the background worker after updating Mivlet.".into());
        }
        Ok(status)
    })
    .await
    .map_err(|_| "The background worker did not respond in time.".to_string())?
}

pub(crate) async fn serve(_app: tauri::AppHandle, pipe: NamedPipeServer) {
    let mut pipe = pipe;
    while !super::stopping() {
        let connected =
            tokio::time::timeout(std::time::Duration::from_millis(250), pipe.connect()).await;
        if matches!(connected, Ok(Err(_))) {
            super::stop();
            break;
        }
        if let Ok(Ok(())) = connected {
            let _ = tokio::time::timeout(TIMEOUT, async {
                let _peer = peer(pipe.as_raw_handle() as HANDLE, true)?;
                let request: Request = read(&mut pipe).await?;
                crate::account_session::ensure_current()?;
                if request.protocol != PROTOCOL
                    || request.account != crate::account_session::binding()?
                {
                    return Err("Background account or protocol changed.".to_string());
                }
                let status = super::local_status()?;
                write(&mut pipe, &status).await?;
                if matches!(request.action, Action::Stop) {
                    super::stop();
                }
                Ok::<_, String>(())
            })
            .await;
            if pipe.disconnect().is_err() {
                super::stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_process_fixture() {
        let Some(root) = std::env::var_os("MIVLET_BACKGROUND_TEST_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let _owner = lock(&root).unwrap();
        let _ready = ready_lock(&root).unwrap();
        std::fs::write(root.join("ready"), b"ready").unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    #[test]
    fn killed_process_releases_exclusive_owner_and_readiness() {
        use std::os::windows::process::CommandExt;
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = tempfile::tempdir().unwrap();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "background_worker::windows::tests::owner_process_fixture",
                    "--nocapture",
                ])
                .env("MIVLET_BACKGROUND_TEST_ROOT", root.path())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !root.path().join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "owner fixture exited before readiness"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "owner fixture never became ready"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(owner_alive(root.path()));
        assert!(ready(root.path()));
        assert!(lock(root.path()).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(!owner_alive(root.path()));
        assert!(!ready(root.path()));
        let _new_owner = lock(root.path()).unwrap();
    }

    #[test]
    fn exclusive_owner_lock_releases_after_close() {
        let root = tempfile::tempdir().unwrap();
        assert!(!owner_alive(root.path()));
        let held = lock(root.path()).unwrap();
        assert!(owner_alive(root.path()));
        assert!(lock(root.path()).is_err());
        drop(held);
        assert!(!owner_alive(root.path()));
    }
    #[tokio::test]
    async fn pipe_authenticates_native_peers_and_rejects_oversize_before_allocation() {
        let root = tempfile::tempdir().unwrap();
        let server = server(root.path()).unwrap();
        assert!(super::server(root.path()).is_err());
        let mut client = ClientOptions::new().open(pipe_name(root.path())).unwrap();
        server.connect().await.unwrap();
        let _server_identity = peer(client.as_raw_handle() as HANDLE, false).unwrap();
        let _client_identity = peer(server.as_raw_handle() as HANDLE, true).unwrap();
        client.write_u32_le(u32::MAX).await.unwrap();
        assert!(read::<_, Request>(&mut { server }).await.is_err());
    }
}
