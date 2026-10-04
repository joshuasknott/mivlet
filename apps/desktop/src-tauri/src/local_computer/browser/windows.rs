//! Fixed installed-browser launch; no shell, PATH lookup or inherited provider environment.
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::{Com::CoTaskMemFree, JobObjects::*, Threading::*},
    UI::{
        Shell::{FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, SHGetKnownFolderPath},
        WindowsAndMessaging::SW_SHOWNOACTIVATE,
    },
};

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

pub(super) struct BrowserImage {
    path: PathBuf,
    file: File,
    product: &'static str,
}

pub(super) fn installed_browser() -> Result<BrowserImage, String> {
    for root_id in [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86] {
        let root = known_folder(root_id)?;
        for (relative, product, publisher) in [
            (
                "Microsoft/Edge/Application/msedge.exe",
                "Microsoft Edge",
                "Microsoft Corporation",
            ),
            (
                "Google/Chrome/Application/chrome.exe",
                "Google Chrome",
                "Google LLC",
            ),
        ] {
            let candidate = root.join(relative);
            if !candidate.is_file() {
                continue;
            }
            let Ok(path) = crate::paths::strict_canonicalize(&candidate) else {
                continue;
            };
            let Ok(root) = crate::paths::strict_canonicalize(&root) else {
                continue;
            };
            if !protected_installation(&path, &root) {
                continue;
            }
            // Hold the executable without write/delete sharing through the process lifetime.
            let Ok(file) = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(&path)
            else {
                continue;
            };
            if trusted_publisher(&path, &file, publisher) {
                return Ok(BrowserImage {
                    path,
                    file,
                    product,
                });
            }
        }
    }
    Err("Install a system Chrome or Edge browser with a valid publisher signature. User-writable installations and elevated Mivlet sessions cannot launch an owned browser.".into())
}

fn known_folder(id: &windows_sys::core::GUID) -> Result<PathBuf, String> {
    let mut pointer = std::ptr::null_mut();
    unsafe {
        if SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut pointer) < 0 || pointer.is_null()
        {
            return Err(
                "Windows could not resolve its trusted browser installation folders.".into(),
            );
        }
        let mut length = 0;
        while length < 32768 && *pointer.add(length) != 0 {
            length += 1;
        }
        let result = (length < 32768).then(|| {
            PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
                pointer, length,
            )))
        });
        CoTaskMemFree(pointer.cast());
        result.ok_or_else(|| "The Windows installation folder is invalid.".into())
    }
}

fn protected_installation(path: &Path, root: &Path) -> bool {
    if !path.starts_with(root) || !write_denied(path, false) {
        return false;
    }
    let mut current = path.parent();
    while let Some(directory) = current {
        if !write_denied(directory, true) {
            return false;
        }
        if directory == root {
            return true;
        }
        current = directory.parent();
    }
    false
}

fn write_denied(path: &Path, directory: bool) -> bool {
    let name = wide(path.as_os_str());
    // Probe existing handles only. No file or directory is created/modified.
    unsafe {
        for access in [2, 4, 0x0001_0000, 0x0004_0000, 0x0008_0000]
            .into_iter()
            .chain(directory.then_some(0x40))
        {
            let handle = CreateFileW(
                name.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
                std::ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                if GetLastError() == ERROR_ACCESS_DENIED {
                    continue;
                }
                return false;
            }
            CloseHandle(handle);
            return false;
        }
        true
    }
}

fn trusted_publisher(path: &Path, file: &File, expected: &str) -> bool {
    use windows_sys::Win32::Security::{
        Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE},
        WinTrust::*,
    };
    let name = wide(path.as_os_str());
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: name.as_ptr(),
        hFile: file.as_raw_handle(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    unsafe {
        let status = WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            std::ptr::addr_of_mut!(data).cast(),
        );
        let valid = if status == 0 {
            let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
            let signer = if provider.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvSignerFromChain(provider, 0, 0, 0)
            };
            let certificate = if signer.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvCertFromChain(signer, 0)
            };
            if certificate.is_null() || (*certificate).pCert.is_null() {
                false
            } else {
                let mut label = [0u16; 256];
                let count = CertGetNameStringW(
                    (*certificate).pCert,
                    CERT_NAME_SIMPLE_DISPLAY_TYPE,
                    0,
                    std::ptr::null(),
                    label.as_mut_ptr(),
                    label.len() as u32,
                );
                count > 1
                    && count <= label.len() as u32
                    && String::from_utf16(&label[..count as usize - 1])
                        .is_ok_and(|name| name == expected)
            }
        } else {
            false
        };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            std::ptr::addr_of_mut!(data).cast(),
        );
        valid
    }
}

/// Quote one Win32 command-line argument. No cmd.exe or PowerShell interprets it.
fn quote(value: &std::ffi::OsStr) -> Result<Vec<u16>, String> {
    let value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err("The browser launch argument is invalid.".into());
    }
    let mut quoted = vec![b'"' as u16];
    let mut slashes = 0;
    for character in value {
        if character == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            b'\\' as u16,
            if character == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        quoted.push(character);
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    quoted.push(b'"' as u16);
    Ok(quoted)
}

fn environment() -> Vec<u16> {
    let mut variables = BTreeMap::new();
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
            variables.insert(key.to_ascii_uppercase(), value);
        }
    }
    let mut block = Vec::new();
    for (key, value) in variables {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

pub(super) struct BrowserProcess {
    // Integers wrap native handles so the manager can cross Tauri worker threads.
    process: usize,
    job: usize,
    pid: u32,
    _image: File,
    _profile: Vec<File>,
    product: &'static str,
}

impl BrowserProcess {
    pub(super) fn product(&self) -> &'static str {
        self.product
    }
    pub(super) fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.process as HANDLE, 0) == WAIT_TIMEOUT }
    }
    pub(super) fn ready_window(
        &self,
    ) -> Result<Option<super::super::windows::WindowChoice>, String> {
        if !self.alive() {
            return Err("The private browser exited before it was ready. It may be blocked by this machine's policy.".into());
        }
        Ok(super::super::windows::list_windows()?
            .into_iter()
            .find(|window| window.identity.pid == self.pid))
    }
    pub(super) fn launch(
        image: BrowserImage,
        profile: &Path,
        pins: Vec<File>,
    ) -> Result<Self, String> {
        let mut profile_argument = std::ffi::OsString::from("--user-data-dir=");
        profile_argument.push(profile);
        let args: Vec<std::ffi::OsString> = [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--hide-crash-restore-bubble",
            "--new-window",
            "about:blank",
        ]
        .into_iter()
        .map(Into::into)
        .chain(Some(profile_argument))
        .collect();
        let mut process = Self::spawn(image, &args, profile)?;
        process._profile = pins;
        Ok(process)
    }
    fn spawn(
        image: BrowserImage,
        args: &[std::ffi::OsString],
        directory: &Path,
    ) -> Result<Self, String> {
        let application = wide(image.path.as_os_str());
        let directory = wide(directory.as_os_str());
        let mut command = quote(image.path.as_os_str())?;
        for argument in args {
            command.push(b' ' as u16);
            command.extend(quote(argument)?);
        }
        command.push(0);
        if command.len() >= 32768 {
            return Err("The browser launch is too large.".into());
        }
        let mut environment = environment();
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("Mivlet could not supervise its owned browser.".into());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("Mivlet could not bind browser lifetime to this account.".into());
            }
            let startup = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                dwFlags: STARTF_USESHOWWINDOW,
                wShowWindow: SW_SHOWNOACTIVATE as u16,
                ..Default::default()
            };
            let mut info = PROCESS_INFORMATION::default();
            if CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                environment.as_mut_ptr().cast(),
                directory.as_ptr(),
                &startup,
                &mut info,
            ) == 0
            {
                CloseHandle(job);
                return Err("Mivlet could not start its private browser.".into());
            }
            // No child can run/fork before it belongs to the account-owned job.
            if AssignProcessToJobObject(job, info.hProcess) == 0
                || ResumeThread(info.hThread) == u32::MAX
            {
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                CloseHandle(job);
                return Err(
                    "Mivlet could not supervise the private browser; it was closed.".into(),
                );
            }
            CloseHandle(info.hThread);
            Ok(Self {
                process: info.hProcess as usize,
                job: job as usize,
                pid: info.dwProcessId,
                _image: image.file,
                _profile: Vec::new(),
                product: image.product,
            })
        }
    }
}
impl Drop for BrowserProcess {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job as HANDLE);
            CloseHandle(self.process as HANDLE);
        }
    }
}

pub(super) fn pin_directory(path: &Path) -> Result<File, String> {
    let canonical = crate::paths::strict_canonicalize(path)
        .map_err(|_| "The browser folder contains a link or is unavailable.")?;
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&canonical)
        .map_err(|_| "Mivlet could not hold its private browser folder.")?;
    if super::super::artifacts::opened_path(&handle)? != canonical {
        return Err("The browser folder changed while it was being opened.".into());
    }
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;

    #[test]
    #[ignore = "Opens one disposable private installed browser; explicit native acceptance only."]
    fn native_owned_browser_acceptance() {
        assert_eq!(
            std::env::var("MIVLET_OWNED_BROWSER_ACCEPTANCE").as_deref(),
            Ok("1")
        );
        let profile = tempfile::Builder::new()
            .prefix("mivlet-owned-browser-qa-")
            .tempdir()
            .unwrap();
        let image =
            installed_browser().expect("a protected installed Chrome/Edge and trusted publisher");
        let product = image.product;
        let process = BrowserProcess::launch(
            image,
            profile.path(),
            vec![pin_directory(profile.path()).unwrap()],
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let window = loop {
            if let Some(window) = process.ready_window().unwrap() {
                break window;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "private browser window did not become ready"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(
            !profile.path().join("DevToolsActivePort").exists(),
            "owned browser must not expose a debugging endpoint"
        );
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cua-driver");
        let driver = crate::local_computer::cua::Driver::start(
            &runtime,
            (window.identity.pid, window.identity.hwnd),
        )
        .unwrap();
        assert!(driver.alive());
        driver.stop();
        assert!(driver.wait_stopped(std::time::Duration::from_secs(5)));
        assert!(
            process.alive(),
            "driver Stop killed the separately owned browser"
        );
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process.pid) };
        assert!(!handle.is_null());
        drop(process);
        let result = unsafe { WaitForSingleObject(handle, 5000) };
        unsafe {
            CloseHandle(handle);
        }
        assert_eq!(result, windows_sys::Win32::Foundation::WAIT_OBJECT_0);
        eprintln!("Owned {product}: private window ready without a debugging endpoint, driver Stop preserved it, owner shutdown closed it.");
    }

    #[test]
    fn launch_arguments_preserve_spaces_quotes_and_trailing_slashes_without_a_shell() {
        let as_text =
            |value: &str| String::from_utf16(&quote(std::ffi::OsStr::new(value)).unwrap()).unwrap();
        assert_eq!(as_text("C:\\private data\\"), "\"C:\\private data\\\\\"");
        assert_eq!(as_text("a\"b"), "\"a\\\"b\"");
        assert_eq!(as_text("$(`secret`); & echo"), "\"$(`secret`); & echo\"");
        assert!(quote(&std::ffi::OsString::from_wide(&[1, 0, 2])).is_err());
    }

    #[test]
    fn user_writable_browser_executable_is_not_an_installation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("chrome.exe");
        std::fs::write(&path, b"not a system executable").unwrap();
        assert!(!protected_installation(&path, directory.path()));
        let file = File::open(&path).unwrap();
        assert!(!trusted_publisher(&path, &file, "Google LLC"));
    }

    #[test]
    fn browser_environment_has_no_provider_or_shell_configuration() {
        let block = environment();
        let text = String::from_utf16(&block).unwrap();
        let keys: Vec<_> = text
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.split('=').next().unwrap())
            .collect();
        assert!(keys.iter().all(|key| [
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE"
        ]
        .contains(key)));
        assert!(!keys.contains(&"PATH"));
    }

    #[test]
    fn a_held_profile_folder_cannot_be_replaced_until_its_process_releases_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("profile");
        let replacement = root.path().join("replacement");
        std::fs::create_dir(&path).unwrap();
        let held = pin_directory(&path).unwrap();
        assert!(std::fs::rename(&path, &replacement).is_err());
        drop(held);
        std::fs::rename(&path, &replacement).unwrap();
    }

    #[test]
    fn native_stop_preserves_the_owned_process_but_account_shutdown_kills_its_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("browser lifetime fixture.mjs");
        let output = directory.path().join("owned-child.json");
        std::fs::write(&script, r#"
            import { spawn } from 'node:child_process';
            import { writeFileSync } from 'node:fs';
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
            writeFileSync(process.argv[2], JSON.stringify({parent:process.pid, child:child.pid}));
            setInterval(() => {}, 1000);
        "#).unwrap();
        let discovered = std::process::Command::new("node.exe")
            .args(["--print", "process.execPath"])
            .output()
            .unwrap();
        assert!(discovered.status.success());
        let node = PathBuf::from(String::from_utf8(discovered.stdout).unwrap().trim());
        let image = BrowserImage {
            file: File::open(&node).unwrap(),
            path: node,
            product: "owned fixture",
        };
        let process = BrowserProcess::spawn(
            image,
            &[script.into_os_string(), output.clone().into_os_string()],
            directory.path(),
        )
        .unwrap();
        let manager = super::super::BrowserManager::default();
        manager
            .processes
            .lock()
            .unwrap()
            .insert("fixture".into(), process);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !output.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let ids: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
        let child = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                ids["child"].as_u64().unwrap() as u32,
            )
        };
        assert!(!child.is_null());
        let state =
            super::super::super::LocalComputerState::for_test(directory.path().to_path_buf());
        state.native.stop("owned fixture Stop");
        assert!(manager
            .processes
            .lock()
            .unwrap()
            .get("fixture")
            .unwrap()
            .alive());
        let before = unsafe { WaitForSingleObject(child, 0) };
        manager.shutdown();
        let after = unsafe { WaitForSingleObject(child, 5000) };
        unsafe {
            CloseHandle(child);
        }
        assert_eq!(before, windows_sys::Win32::Foundation::WAIT_TIMEOUT);
        assert_eq!(after, windows_sys::Win32::Foundation::WAIT_OBJECT_0);
        assert!(manager.processes.lock().unwrap().is_empty());
    }
}
