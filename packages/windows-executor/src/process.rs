use crate::{
    files, runtime,
    security::{self, wide, Attributes, Capability, Handle, Profile},
    setup, Binding, CompletedRun, ExecutionMode, Limits, OutputLog, Receipt,
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    mem::{size_of, zeroed},
    os::windows::io::FromRawHandle,
    path::{Path, PathBuf},
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{JobObjects::*, Pipes::*, StationsAndDesktops::*, Threading::*},
};

struct Job(Handle);
impl Job {
    fn create(limits: Limits, seconds: u64) -> Result<Self, String> {
        let handle = Handle::checked(
            unsafe { CreateJobObjectW(ptr::null(), ptr::null()) },
            "Create execution supervisor",
        )?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_JOB_TIME
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        info.BasicLimitInformation.ActiveProcessLimit = limits.processes;
        info.BasicLimitInformation.PerJobUserTimeLimit = (seconds * 10_000_000) as i64;
        info.JobMemoryLimit = limits.memory_bytes;
        if unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                ptr::addr_of!(info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(security::error("Set execution resource limits"));
        }
        // Desktop/clipboard/global-atom access is prohibited independently from
        // the AppContainer token; no interactive Computer Use grant is added.
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };
        if unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectBasicUIRestrictions,
                ptr::addr_of!(ui).cast(),
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        } == 0
        {
            return Err(security::error("Set execution UI boundary"));
        }
        Ok(Self(handle))
    }
    fn stop(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.0 .0, 1) } == 0 {
            return Err(security::error("Stop execution descendants"));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.0 .0,
                    JobObjectBasicAccountingInformation,
                    ptr::addr_of_mut!(info).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(security::error("Verify stopped execution"));
            }
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Execution termination could not be confirmed. No outputs may be imported; inspect recovery state.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.0 .0, 1);
        }
    }
}

struct Desktop(HDESK);
impl Desktop {
    fn create(id: &str, package: &str) -> Result<(Self, Vec<u16>), String> {
        let name = format!("MivletExecution-{id}");
        // A private desktop owned by the creating logon. AppContainer window
        // isolation and job UI limits apply even if a child loads user32.
        let owner = security::user_sid()?;
        let sddl = wide(format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{owner})(A;;0x120083;;;{package})S:(ML;;NW;;;LW)"
        ));
        let mut sd = ptr::null_mut();
        if unsafe {
            windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, ptr::null_mut())
        } == 0
        {
            return Err(security::error("Prepare private desktop access"));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let raw = unsafe {
            CreateDesktopW(
                wide(&name).as_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS,
                &attributes,
            )
        };
        unsafe {
            LocalFree(sd.cast());
        }
        if raw.is_null() {
            return Err(security::error("Create private execution desktop"));
        }
        Ok((Self(raw), wide(format!("winsta0\\{name}"))))
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.0);
        }
    }
}

fn pipe() -> Result<(Handle, Handle), String> {
    let mut read = ptr::null_mut();
    let mut write = ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(security::error("Create execution output pipe"));
    }
    let read = Handle::checked(read, "Read execution output")?;
    let write = Handle::checked(write, "Write execution output")?;
    if unsafe { SetHandleInformation(write.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(security::error("Prepare isolated output handle"));
    }
    Ok((read, write))
}
fn environment(root: &Path, system: &Path) -> Vec<u16> {
    let mut values = BTreeMap::new();
    let path = |name: &str| launch_path(&root.join(name)).to_string_lossy().into_owned();
    values.insert("APPDATA", path("home/appdata"));
    values.insert("LOCALAPPDATA", path("home/local"));
    values.insert("USERPROFILE", path("home"));
    values.insert("HOME", path("home"));
    values.insert("TEMP", path("tmp"));
    values.insert("TMP", path("tmp"));
    values.insert(
        "PATH",
        format!(
            "{};{};{}",
            path("runtime/node"),
            path("runtime/python"),
            system.join("System32").display()
        ),
    );
    values.insert(
        "COMSPEC",
        launch_path(&system.join("System32/cmd.exe"))
            .to_string_lossy()
            .into_owned(),
    );
    values.insert("SystemRoot", system.to_string_lossy().into_owned());
    values.insert("WINDIR", system.to_string_lossy().into_owned());
    values.insert("PATHEXT", ".EXE;.CMD;.BAT".into());
    values.insert("CI", "1".into());
    values.insert("NPM_CONFIG_CACHE", path("home/npm-cache"));
    values.insert("NPM_CONFIG_USERCONFIG", path("home/empty-npmrc"));
    values.insert("NPM_CONFIG_GLOBALCONFIG", path("home/empty-global-npmrc"));
    values.insert("PIP_CONFIG_FILE", "NUL".into());
    values.insert("PIP_DISABLE_PIP_VERSION_CHECK", "1".into());
    values.insert("PYTHONDONTWRITEBYTECODE", "1".into());
    let mut block = Vec::new();
    for (key, value) in values {
        block.extend(wide(format!("{key}={value}")));
    }
    block.push(0);
    block
}
fn launch_path(path: &Path) -> PathBuf {
    // Custody uses canonical extended paths. cmd.exe treats their prefix as UNC
    // and silently changes cwd, so pass the already verified local drive path.
    let value = path.to_string_lossy();
    PathBuf::from(
        value
            .strip_prefix(r"\\?\")
            .unwrap_or(&value)
            .replace('/', "\\"),
    )
}
fn system_directory() -> Result<PathBuf, String> {
    use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
    let mut buffer = [0u16; 32768];
    let len = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if len == 0 || len as usize >= buffer.len() {
        return Err(security::error("Resolve Windows system runtime"));
    }
    files::strict_path(&PathBuf::from(String::from_utf16_lossy(
        &buffer[..len as usize],
    )))
    .map(|p| launch_path(&p))
}
fn boundary(token: HANDLE, profile: &Profile) -> Result<(), String> {
    {
        let class = TokenIsAppContainer;
        let mut value = 0u32;
        let mut size = 0;
        if unsafe {
            GetTokenInformation(
                token,
                class,
                ptr::addr_of_mut!(value).cast(),
                size_of::<u32>() as u32,
                &mut size,
            )
        } == 0
            || value != 1
        {
            return Err(format!("Windows did not establish the required restricted execution token (class {class}, value {value}, size {size}, error {}). No command was started.", unsafe { GetLastError() }));
        }
    }
    let mut value: TOKEN_APPCONTAINER_INFORMATION = unsafe { zeroed() };
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenAppContainerSid,
            ptr::addr_of_mut!(value).cast(),
            size_of::<TOKEN_APPCONTAINER_INFORMATION>() as u32,
            &mut size,
        )
    } == 0
    {
        // TokenAppContainerSid contains inline SID data and usually requires a
        // larger buffer. Query it again with a bounded aligned allocation.
        if size == 0 || size > 4096 {
            return Err("Invalid execution token identity.".into());
        }
        let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token,
                TokenAppContainerSid,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        } == 0
            || unsafe {
                EqualSid(
                    (*(buffer.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>())).TokenAppContainer,
                    profile.sid,
                )
            } == 0
        {
            return Err("Execution token identity changed.".into());
        }
    } else if unsafe { EqualSid(value.TokenAppContainer, profile.sid) } == 0 {
        return Err("Execution token identity changed.".into());
    }
    security::verify_lpac(token, &profile.text)
}
fn readers(handles: [Handle; 2], output: OutputLog) -> Vec<std::thread::JoinHandle<()>> {
    use crate::output::OutputStream;
    handles
        .into_iter()
        .zip([OutputStream::Stdout, OutputStream::Stderr])
        .map(|(handle, stream)| {
            // Move ownership into File; no handle is inherited by the reader thread.
            let file = unsafe { File::from_raw_handle(handle.0) };
            std::mem::forget(handle);
            let output = output.clone();
            std::thread::spawn(move || {
                let mut file = file;
                let mut buffer = [0u8; 4096];
                while let Ok(size) = file.read(&mut buffer) {
                    if size == 0 {
                        break;
                    }
                    output.push(stream, &buffer[..size]);
                }
                output.end(stream);
            })
        })
        .collect()
}
fn protect_tree(root: &Path, sid: &str, rights: &str) -> Result<(), String> {
    // Every descendant was freshly created by native custody and has an
    // unprotected inherited DACL. Windows propagates the OI/CI grants once;
    // resetting every directory would repeatedly rewalk the entire tree.
    files::strict_path(root)?;
    security::protect(root, sid, rights)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    resources: &Path,
    input: &Path,
    script: &str,
    network: bool,
    seconds: u64,
    limits: Limits,
    binding: Binding,
    mode: ExecutionMode,
    output: OutputLog,
    current: impl Fn() -> bool,
    launch: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<CompletedRun, String> {
    if !cfg!(target_arch = "x86_64") {
        return Err("Native execution supports Windows x64.".into());
    }
    if unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() } != 0 {
        return Err("Run Mivlet without administrator privileges for ordinary execution.".into());
    }
    if !current() {
        return Err("Execution generation changed before launch.".into());
    }
    let installation = setup::ready()?;
    let id = security::random_id()?;
    crate::custody::recover()?;
    let command_id = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                script,
                network,
                seconds,
                mode == ExecutionMode::Persistent,
                &binding,
            ))
            .map_err(|_| "Invalid command identity.")?,
        ))
    };
    let (directory, lease) = crate::custody::prepare_run(
        &installation,
        &id,
        &binding,
        &command_id,
        network,
        mode == ExecutionMode::Persistent,
    )?;
    let root = directory.path();
    setup::ready()?;
    let work = root.join("work");
    let runtime_dir = root.join("runtime");
    for path in [
        &work,
        &runtime_dir,
        &root.join("tmp"),
        &root.join("home/appdata"),
        &root.join("home/local"),
    ] {
        fs::create_dir_all(path).map_err(|_| "Cannot prepare native execution directories.")?;
    }
    fs::write(root.join("home/empty-npmrc"), b"")
        .map_err(|_| "Cannot prepare isolated package configuration.")?;
    fs::write(root.join("home/empty-global-npmrc"), b"")
        .map_err(|_| "Cannot prepare isolated global package configuration.")?;
    let runtime_id = runtime::stage(resources, &runtime_dir, &current)?;
    let input_id = files::copy_tree_current(input, &work, limits, &current)?;
    // This exact batch file is outside the writable work tree. cmd /D prevents
    // registry AutoRun; /S /C receives only a fixed, quoted script path.
    fs::write(
        root.join("command.cmd"),
        format!("@echo off\r\n{script}\r\n"),
    )
    .map_err(|_| "Cannot stage native execution command.")?;
    let profile = Profile::create(&id)?;
    security::protect(root, &profile.text, "0x1000a0")?;
    protect_tree(&work, &profile.text, "0x1301bf")?;
    protect_tree(&root.join("tmp"), &profile.text, "0x1301bf")?;
    protect_tree(&root.join("home"), &profile.text, "0x1301bf")?;
    protect_tree(&runtime_dir, &profile.text, "0x1200a9")?;
    security::protect(&root.join("command.cmd"), &profile.text, "0x1200a9")?;
    let owner = security::user_sid()?;
    let traverse = setup::traversal(&owner)?;
    let registry = Capability::derive("registryRead")?;
    let internet = if network {
        Some(Capability::derive("internetClient")?)
    } else {
        None
    };
    let mut capability_entries = vec![
        SID_AND_ATTRIBUTES {
            Sid: traverse.sid(),
            Attributes: 4,
        },
        SID_AND_ATTRIBUTES {
            Sid: registry.sid(),
            Attributes: 4,
        },
    ];
    if let Some(internet) = &internet {
        capability_entries.push(SID_AND_ATTRIBUTES {
            Sid: internet.sid(),
            Attributes: 4,
        });
    }
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: capability_entries.as_mut_ptr(),
        CapabilityCount: capability_entries.len() as u32,
        Reserved: 0,
    };
    let policy: u32 = 1;
    let job = Job::create(limits, seconds)?;
    let (stdout, stdout_write) = pipe()?;
    let (stderr, stderr_write) = pipe()?;
    let (stdin, stdin_write) = pipe()?;
    // Read-only empty stdin is the only input handle. No host handle, job handle,
    // provider IPC, process token, workspace store or secret file is inherited.
    drop(stdin_write);
    unsafe {
        SetHandleInformation(stdin.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    let handles = [stdin.0, stdout_write.0, stderr_write.0];
    let jobs = [job.0 .0];
    let mut attributes = Attributes::new(4)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &policy,
    )?;
    attributes.handles(&handles)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let (_desktop, mut desktop_name) = Desktop::create(&id, &profile.text)?;
    let system = system_directory()?;
    let exe = launch_path(&system.join("System32/cmd.exe"));
    // Windows services its own binaries through WinSxS hard links. This fixed
    // OS path is not an untrusted snapshot/runtime file; reparse ancestry is
    // still rejected and the image stays locked against replacement/writes.
    files::strict_path(&exe)?;
    use std::os::windows::fs::OpenOptionsExt;
    let _image = fs::OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(&exe)
        .map_err(|_| "The Windows command interpreter is unavailable.")?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.list;
    startup.StartupInfo.lpDesktop = desktop_name.as_mut_ptr();
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.0;
    startup.StartupInfo.hStdOutput = stdout_write.0;
    startup.StartupInfo.hStdError = stderr_write.0;
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    let mut command = wide(format!(
        "\"{}\" /D /S /C \"\"{}\"\"",
        exe.display(),
        launch_path(&root.join("command.cmd")).display()
    ));
    let env = environment(root, &system);
    if !current() {
        return Err("Execution generation changed before launch.".into());
    }
    // Job membership and security attributes are atomic at creation. The first
    // instruction stays suspended until its actual token has been verified.
    if unsafe {
        CreateProcessW(
            wide(&exe).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            env.as_ptr().cast(),
            wide(launch_path(&work)).as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(security::error("Launch restricted native command"));
    }
    let process = Handle::checked(info.hProcess, "Supervise native command")?;
    let thread = Handle::checked(info.hThread, "Start native command")?;
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) } == 0 {
        return Err(security::error("Verify execution token"));
    }
    let token = Handle::checked(token, "Verify execution token")?;
    boundary(token.0, &profile)?;
    drop(stdin);
    drop(stdout_write);
    drop(stderr_write);
    let readers = readers([stdout, stderr], output.clone());
    let start = Instant::now();
    let mut resumed = false;
    let launched = launch(&mut || {
        if resumed {
            return Err("The native launch action is single-use.".into());
        }
        resumed = true;
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err(security::error("Resume restricted command"));
        }
        Ok(())
    });
    if let Err(error) = launched.and_then(|_| {
        resumed
            .then_some(())
            .ok_or_else(|| "Native launch was not dispatched.".to_owned())
    }) {
        job.stop()?;
        for reader in readers {
            let _ = reader.join();
        }
        return Err(error);
    }
    let deadline = start + Duration::from_secs(seconds);
    let control = || {
        if !current() {
            Err("stopped or stale generation".to_owned())
        } else if Instant::now() >= deadline {
            Err("timeout".to_owned())
        } else {
            Ok(())
        }
    };
    let mut reason = None;
    let mut code = None;
    let mut last_scan = Instant::now();
    loop {
        if let Err(error) = control() {
            reason = Some(error);
            break;
        }
        let status = unsafe { WaitForSingleObject(process.0, 25) };
        if status == WAIT_OBJECT_0 {
            let mut actual = 0;
            if unsafe { GetExitCodeProcess(process.0, &mut actual) } == 0 {
                return Err(security::error("Read actual command exit status"));
            }
            code = Some(actual as i32);
            break;
        }
        if status == WAIT_FAILED {
            return Err(security::error("Observe native command"));
        }
        if last_scan.elapsed() >= Duration::from_millis(250) {
            if let Err(error) = usage(root, limits, &control) {
                reason = Some(error);
                break;
            }
            last_scan = Instant::now();
        }
    }
    // Always end surviving descendants, including detached processes whose
    // parent has returned zero, before sealing outputs or joining pipe readers.
    job.stop()?;
    for reader in readers {
        reader
            .join()
            .map_err(|_| "Command output reader stopped unexpectedly.")?;
    }
    // Fast commands may finish before the first 250 ms sample. Inspect all
    // writable storage once more after descendants have stopped, under the
    // same cancellation/deadline control, before permitting a successful seal.
    if reason.is_none() {
        if let Err(error) = usage(root, limits, &control) {
            reason = Some(error);
        }
    }
    output.close();
    let (text, truncated) = output.summary()?;
    let output_id = if mode == ExecutionMode::Command && reason.is_none() && code == Some(0) {
        match files::tree_id_current(&work, limits, &|| control().is_ok()) {
            Ok(id) if control().is_ok() => Some(id),
            result => {
                reason = Some(control().err().unwrap_or_else(|| {
                    result
                        .err()
                        .unwrap_or_else(|| "Output sealing interrupted.".into())
                }));
                None
            }
        }
    } else {
        None
    };
    let receipt = Receipt {
        run_id: id,
        executor: "windows-lpac-v1".into(),
        runtime_id,
        input_id,
        output_id,
        exit_code: code,
        output: text,
        truncated,
        interrupted: reason.is_some(),
        reason,
        elapsed_ms: start.elapsed().as_millis().min(u64::MAX as u128) as u64,
        network,
        command_id,
        binding,
        persistent: mode == ExecutionMode::Persistent,
    };
    crate::custody::seal(&installation, &receipt)?;
    drop(token);
    drop(thread);
    drop(process);
    if let Err(error) = profile.remove() {
        let _retained = directory.keep();
        return Err(error);
    }
    drop(profile);
    Ok(CompletedRun {
        receipt,
        directory,
        work,
        limits,
        _lease: lease,
    })
}
#[cfg(test)]
thread_local! { static IN_STORAGE_SCAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
pub(crate) fn in_storage_scan() -> bool {
    IN_STORAGE_SCAN.with(|active| active.get())
}
#[cfg(test)]
struct ScanGuard;
#[cfg(test)]
impl Drop for ScanGuard {
    fn drop(&mut self) {
        IN_STORAGE_SCAN.with(|active| active.set(false));
    }
}
fn usage(
    root: &Path,
    limits: Limits,
    control: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(test)]
    let _scan = {
        IN_STORAGE_SCAN.with(|active| active.set(true));
        ScanGuard
    };
    let mut stack = vec![root.join("work"), root.join("tmp"), root.join("home")];
    let mut bytes = 0u64;
    let mut count = 0usize;
    while let Some(path) = stack.pop() {
        control()?;
        files::strict_path(&path)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "Execution storage is unavailable.")?;
        count += 1;
        if count > limits.file_count {
            return Err("file count limit".into());
        }
        if metadata.is_dir() {
            let mut entries =
                fs::read_dir(path).map_err(|_| "Execution storage is unavailable.")?;
            loop {
                control()?;
                let Some(entry) = entries.next() else { break };
                stack.push(
                    entry
                        .map_err(|_| "Execution storage is unavailable.")?
                        .path(),
                );
                // Bound queued entries as well as visited metadata under churn.
                if count.saturating_add(stack.len()) > limits.file_count {
                    return Err("file count limit".into());
                }
            }
        } else {
            bytes = bytes.saturating_add(metadata.len());
            if metadata.len() > limits.file_bytes || bytes > limits.tree_bytes {
                return Err("storage limit".into());
            }
        }
    }
    control()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn stop_and_deadline_interrupt_a_wide_storage_scan() {
        let root = tempfile::tempdir().unwrap();
        for name in ["work", "home", "tmp"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        // Cancellation is triggered during enumeration, before all entries are
        // even queued. A per-directory-only check cannot pass this regression.
        for index in 0..8192 {
            fs::write(root.path().join("home").join(index.to_string()), b"x").unwrap();
        }
        for reason in ["stopped or stale generation", "timeout"] {
            let polls = Cell::new(0usize);
            let error = usage(root.path(), Limits::CODING, &|| {
                polls.set(polls.get() + 1);
                if polls.get() == 128 {
                    Err(reason.into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert_eq!(error, reason);
            assert_eq!(polls.get(), 128);
        }
        usage(root.path(), Limits::CODING, &|| Ok(())).unwrap();
    }
}
