//! Runs before Tauri/account initialization in a separate native process.
//! Only this helper makes debugging pipe handles inheritable, avoiding races
//! with the main app's concurrent Rust provider/MCP process creation.
use super::pipes::{ControlPipe, Framed, Pair};
use super::*;
use std::{
    io::Write,
    os::windows::io::{FromRawHandle, OwnedHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{Diagnostics::ToolHelp::*, Pipes::*},
};

fn canonical(path: &Path) -> Result<PathBuf, String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "The private browser path failed its identity check.".into())
}

pub(super) fn launch(
    image: BrowserImage,
    profile: &Path,
    pins: Vec<File>,
    ticket: &super::super::super::authority::OperationTicket,
    environment_check: &dyn Fn() -> Result<(), String>,
    register: &dyn Fn(std::sync::Arc<dyn super::super::LaunchStop>) -> Result<(), String>,
) -> Result<BrowserProcess, String> {
    let check = &|| {
        ticket.check()?;
        environment_check()
    };
    let input = Pair::new(false)?;
    let output = Pair::new(true)?;
    let ready = Pair::new(true)?;
    let native_path = canonical(
        &std::env::current_exe().map_err(|_| "Mivlet's native browser helper is unavailable.")?,
    )?;
    let native_image = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&native_path)
        .map_err(|_| "Mivlet could not pin its browser helper.")?;
    let arguments = vec![
        "--mivlet-browser-child".into(),
        unsafe { GetCurrentProcessId() }.to_string().into(),
        input.child_id().to_string().into(),
        output.child_id().to_string().into(),
        ready.child_id().to_string().into(),
        profile.as_os_str().to_owned(),
    ];
    check()?;
    // bInheritHandles is FALSE here. Client handles stay non-inheritable in Mivlet.
    let mut process = ticket.with_current(|| {
        environment_check()?;
        BrowserProcess::prepare(
            BrowserImage {
                path: native_path,
                file: native_image,
                product: image.product,
            },
            &arguments,
            profile,
            &[],
        )
    })?;
    register(process.job.clone())?;
    ticket.with_current(|| {
        environment_check()?;
        process.resume()
    })?;
    let owner_handle = process.process;
    let waiting = &|| {
        check()?;
        if unsafe { WaitForSingleObject(owner_handle as HANDLE, 0) } != WAIT_TIMEOUT {
            return Err("The private browser helper exited before readiness was confirmed.".into());
        }
        Ok(())
    };
    let mut readiness = Framed::new(ready.parent);
    let frame = readiness.read(Instant::now() + Duration::from_secs(10), waiting)?;
    if frame.len() > 10 || frame.is_empty() || frame.iter().any(|byte| !byte.is_ascii_digit()) {
        return Err("The native browser helper returned an invalid process identity.".into());
    }
    let pid = std::str::from_utf8(&frame)
        .map_err(|_| "Invalid browser identity.")?
        .parse::<u32>()
        .map_err(|_| "Invalid browser identity.")?;
    let child = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if child.is_null() {
        return Err("The private browser process was unavailable.".into());
    }
    let held = unsafe { OwnedHandle::from_raw_handle(child) };
    let mut in_job = 0;
    if unsafe { IsProcessInJob(child, process.job.0.as_raw_handle(), &mut in_job) } == 0
        || in_job == 0
        || process_image(child)? != image.path
    {
        return Err("The browser escaped its native process boundary.".into());
    }
    process.pid = pid;
    process._browser_process = Some(held);
    process._browser_image = Some(image.file);
    process._profile = pins;
    process._pipe = Some(ControlPipe::new(input.parent, output.parent));
    process._pipe.as_mut().unwrap().verify(waiting)?;
    // Source clients must stay alive until the helper has duplicated/adopted them.
    drop((input.child, output.child, ready.child));
    check()?;
    Ok(process)
}

fn parent_process(expected: u32) -> Result<OwnedHandle, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("The browser helper cannot verify its parent.".into());
        }
        let _snapshot = OwnedHandle::from_raw_handle(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = Process32FirstW(snapshot, &mut entry) != 0;
        while found && entry.th32ProcessID != GetCurrentProcessId() {
            found = Process32NextW(snapshot, &mut entry) != 0;
        }
        if !found || entry.th32ParentProcessID != expected || expected == 0 {
            return Err("The browser helper's parent changed.".into());
        }
        let parent = OpenProcess(
            PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            expected,
        );
        if parent.is_null() {
            return Err("The browser helper's parent is unavailable.".into());
        }
        let held = OwnedHandle::from_raw_handle(parent);
        let own = canonical(&std::env::current_exe().map_err(|_| "Invalid native executable.")?)?;
        if process_image(parent)? != own {
            return Err("Only the native Mivlet process can start its browser helper.".into());
        }
        Ok(held)
    }
}

fn process_image(process: HANDLE) -> Result<PathBuf, String> {
    let mut name = vec![0u16; 32768];
    let mut size = name.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut size) } == 0 {
        return Err("The private browser process image cannot be verified.".into());
    }
    canonical(&PathBuf::from(std::ffi::OsString::from_wide(
        &name[..size as usize],
    )))
}

fn pull_pipe(parent: &OwnedHandle, source: usize, expected: u32) -> Result<File, String> {
    unsafe {
        let mut copied = std::ptr::null_mut();
        if source == 0
            || DuplicateHandle(
                parent.as_raw_handle(),
                source as HANDLE,
                GetCurrentProcess(),
                &mut copied,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) == 0
        {
            return Err("The browser helper could not acquire its private pipe.".into());
        }
        let file = File::from_raw_handle(copied);
        let mut server = 0;
        if GetFileType(copied) != FILE_TYPE_PIPE
            || GetNamedPipeServerProcessId(copied, &mut server) == 0
            || server != expected
        {
            return Err("The browser helper received an unrelated pipe.".into());
        }
        Ok(file)
    }
}

pub(super) fn run(arguments: &[std::ffi::OsString]) -> Result<(), String> {
    if arguments.len() != 5 {
        return Err("Invalid private browser helper request.".into());
    }
    let parent_id: u32 = arguments[0]
        .to_str()
        .ok_or("Invalid native parent.")?
        .parse()
        .map_err(|_| "Invalid native parent.")?;
    let handles: Vec<usize> = arguments[1..4]
        .iter()
        .map(|value| {
            value
                .to_str()
                .ok_or("Invalid native pipe.")?
                .parse()
                .map_err(|_| "Invalid native pipe.".into())
        })
        .collect::<Result<_, String>>()?;
    let parent = parent_process(parent_id)?;
    let input = pull_pipe(&parent, handles[0], parent_id)?;
    let output = pull_pipe(&parent, handles[1], parent_id)?;
    let mut ready = pull_pipe(&parent, handles[2], parent_id)?;
    let profile = canonical(Path::new(&arguments[4]))?;
    let current =
        canonical(&std::env::current_dir().map_err(|_| "Invalid private browser directory.")?)?;
    if current != profile {
        return Err("The private browser profile changed.".into());
    }
    let image = installed_browser()?;
    let mut profile_arg = std::ffi::OsString::from("--user-data-dir=");
    profile_arg.push(&profile);
    let mut args: Vec<std::ffi::OsString> = [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--hide-crash-restore-bubble",
        "--remote-debugging-pipe",
        "--new-window",
        "about:blank",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let input_id = u32::try_from(input.as_raw_handle() as usize)
        .map_err(|_| "Invalid browser input handle.")?;
    let output_id = u32::try_from(output.as_raw_handle() as usize)
        .map_err(|_| "Invalid browser output handle.")?;
    args.push(format!("--remote-debugging-io-pipes={input_id},{output_id}").into());
    args.push(profile_arg);
    // This process never initializes accounts/providers or launches other work.
    // Only the two CDP handles are inherited by the browser, never readiness/parent handles.
    for file in [&input, &output] {
        if unsafe {
            SetHandleInformation(
                file.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        } == 0
        {
            return Err("The browser helper could not bind its private handles.".into());
        }
    }
    let process = BrowserProcess::spawn_inheriting(
        image,
        &args,
        &profile,
        &[input.as_raw_handle(), output.as_raw_handle()],
    )?;
    ready
        .write_all(format!("{}\0", process.pid).as_bytes())
        .map_err(|_| "The browser owner disconnected.")?;
    drop((input, output, ready, parent));
    unsafe {
        WaitForSingleObject(process.process as HANDLE, INFINITE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_rejects_an_unrelated_parent_before_opening_any_profile() {
        let args: Vec<std::ffi::OsString> = [
            unsafe { GetCurrentProcessId() }.to_string(),
            "1".into(),
            "2".into(),
            "3".into(),
            "C:\\unrelated-profile".into(),
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        assert!(run(&args).unwrap_err().contains("parent"));
        assert!(run(&[]).is_err());
    }
    #[test]
    fn helper_refuses_a_regular_file_in_place_of_a_native_pipe() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let id = unsafe { GetCurrentProcessId() };
        let process = unsafe {
            OpenProcess(
                PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                id,
            )
        };
        assert!(!process.is_null());
        let held = unsafe { OwnedHandle::from_raw_handle(process) };
        assert!(pull_pipe(&held, temporary.as_file().as_raw_handle() as usize, id).is_err());
    }
}
