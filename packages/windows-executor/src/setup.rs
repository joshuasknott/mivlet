//! Bounded administrator setup: metadata-only traversal on the fixed execution
//! ancestry. Normal runs never elevate, modify system policy, or change ACLs on
//! user projects. No accounts, passwords, network exemptions, or services exist.
use crate::{
    files,
    security::{self, wide, Capability},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::Com::CoTaskMemFree,
    System::SystemServices::MAXIMUM_ALLOWED,
    UI::Shell::*,
};

const METADATA: u32 = 0x1000a0; // synchronize, traverse, read attributes; no listing/content
pub(crate) fn traversal(owner: &str) -> Result<Capability, String> {
    Capability::derive(&format!("MivletExecutionTraversal.{owner}"))
}
fn validate_owner(owner: &str) -> Result<(), String> {
    if !owner.starts_with("S-1-5-21-")
        || owner.len() > 184
        || owner
            .split('-')
            .skip(1)
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Invalid native setup identity.".into());
    }
    Ok(())
}
fn program_data() -> Result<PathBuf, String> {
    let id = windows_sys::core::GUID {
        data1: 0x62ab5d82,
        data2: 0xfdc1,
        data3: 0x4dc3,
        data4: [0xa9, 0xdd, 0x07, 0x0d, 0x1d, 0x49, 0x5d, 0x97],
    };
    let mut value = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&id, 0, ptr::null_mut(), &mut value) } < 0 {
        return Err("Windows ProgramData is unavailable.".into());
    }
    let path = PathBuf::from(unsafe { security::wide_string(value) });
    unsafe {
        CoTaskMemFree(value.cast());
    }
    files::strict_path(&path)
}
pub fn root_for(owner: &str) -> Result<PathBuf, String> {
    validate_owner(owner)?;
    Ok(program_data()?.join("MivletExecution").join(owner))
}
fn ancestry(root: &Path) -> Vec<&Path> {
    root.ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn lock_directory(path: &Path, maintenance: bool) -> Result<File, String> {
    let file = OpenOptions::new()
        // Metadata-only opens do not participate in Windows delete sharing.
        // A directory-read handle is necessary to pin the resolved ancestry.
        // MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating ACLs
        // through pre-existing children. Setup modifies only held objects.
        .access_mode(if maintenance {
            MAXIMUM_ALLOWED
        } else {
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | READ_CONTROL
        })
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| "Cannot hold stable native setup directory custody.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect native setup directory.")?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Native setup directories cannot be links or reparse points.".into());
    }
    Ok(file)
}
fn stable_ancestry(root: &Path, create: bool) -> Result<Vec<File>, String> {
    let mut handles = Vec::new();
    for path in ancestry(root) {
        if !path
            .try_exists()
            .map_err(|_| "Cannot inspect native setup ancestry.")?
        {
            if !create {
                break;
            }
            fs::create_dir(path).map_err(|_| "Cannot prepare native setup directory.")?;
        }
        // Parents remain pinned without write/delete sharing before child
        // resolution, ACL modification or file creation. ACLs use these handles.
        handles.push(lock_directory(path, true)?);
    }
    Ok(handles)
}
fn setup_file(path: &Path, create: bool) -> Result<Option<File>, String> {
    let exists = match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Cannot inspect native setup file.".into()),
    };
    if !exists && !create {
        return Ok(None);
    }
    let file = OpenOptions::new()
        .access_mode(MAXIMUM_ALLOWED)
        .create_new(!exists)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| "Native setup file is active or cannot be held safely.")?;
    // Validate the opened object before any truncation/write. Reparse and
    // hardlink targets never receive elevated writes, even on first setup.
    files::regular_file(&file)?;
    Ok(Some(file))
}
fn write_stamp(file: &mut File) -> Result<(), String> {
    file.set_len(0)
        .and_then(|_| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(b"1"))
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist native setup file.".into())
}
fn private_acl(file: &File, owner: &str) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(format!(
                "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{owner})(A;OICI;RC;;;OW)"
            ))
            .as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("Cannot prepare native setup ACL.".into());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = ptr::null_mut();
    unsafe {
        GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted);
    }
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(sd.cast());
    }
    if status != 0 {
        return Err("Cannot apply native setup ACL to held directory.".into());
    }
    Ok(())
}

fn metadata_acl(file: &File, sid: PSID, remove: bool) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    let mut old_acl = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut old_acl,
            ptr::null_mut(),
            &mut sd,
        )
    };
    if result != 0 || old_acl.is_null() {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd);
            }
        }
        return Err("Native setup cannot inspect its metadata boundary.".into());
    }
    let mut entry: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
    entry.grfAccessPermissions = METADATA;
    entry.grfAccessMode = REVOKE_ACCESS;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    entry.Trustee.ptstrName = sid.cast();
    let mut revoked = ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut revoked) };
    let mut updated = ptr::null_mut();
    let status = if status == 0 && !remove {
        entry.grfAccessMode = GRANT_ACCESS;
        unsafe { SetEntriesInAclW(1, &entry, revoked, &mut updated) }
    } else {
        status
    };
    let acl = if remove { revoked } else { updated };
    let status = if status == 0 {
        unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null_mut(),
            )
        }
    } else {
        status
    };
    unsafe {
        LocalFree(sd);
        if !revoked.is_null() {
            LocalFree(revoked.cast());
        }
        if !updated.is_null() {
            LocalFree(updated.cast());
        }
    }
    if status != 0 {
        return Err(format!("Native metadata setup failed (Windows {status}). Administrator-approved setup is required."));
    }
    Ok(())
}
fn verify_metadata(file: &File, sid: PSID) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut sd,
        )
    };
    if result != 0 || acl.is_null() {
        if !sd.is_null() {
            unsafe {
                LocalFree(sd);
            }
        }
        return Err("Native execution setup is incomplete. Use Set up native execution.".into());
    }
    let mut found = false;
    let mut invalid = false;
    unsafe {
        for index in 0..(*acl).AceCount {
            let mut raw = ptr::null_mut();
            if GetAce(acl, index as u32, &mut raw) == 0 {
                invalid = true;
                break;
            }
            let header = &*(raw.cast::<ACE_HEADER>());
            if header.AceType == 0 {
                let ace = &*(raw.cast::<ACCESS_ALLOWED_ACE>());
                let principal = ptr::addr_of!(ace.SidStart).cast_mut().cast();
                if EqualSid(principal, sid) != 0 {
                    found = true;
                    invalid |= ace.Mask != METADATA || header.AceFlags != 0;
                }
            }
        }
        LocalFree(sd);
    }
    if !found || invalid {
        return Err("Native execution traversal permissions changed. Repair setup; commands remain blocked.".into());
    }
    Ok(())
}
pub fn ready() -> Result<PathBuf, String> {
    let owner = security::user_sid()?;
    let root = root_for(&owner)?;
    files::strict_path(&root)
        .map_err(|_| "Set up native execution once to run coding and file analysis.".to_owned())?;
    let capability = traversal(&owner)?;
    for path in ancestry(&root) {
        verify_metadata(&lock_directory(path, false)?, capability.sid())?;
    }
    // The stamp only records the version; ACL checks above establish authority.
    if files::read(&root.join("setup-version"), 16)? != b"1" {
        return Err("Native execution setup requires repair.".into());
    }
    Ok(root)
}
/// Called only by the fixed native setup entry point under Windows UAC.
pub fn configure(owner: &str, cleanup: bool) -> Result<(), String> {
    validate_owner(owner)?;
    if unsafe { IsUserAnAdmin() } == 0 {
        return Err("Native setup requires administrator approval.".into());
    }
    let root = root_for(owner)?;
    let capability = traversal(owner)?;
    let handles = stable_ancestry(&root, !cleanup)?;
    let mut maintenance = if root.exists() {
        setup_file(&root.join("maintenance.lock"), !cleanup)?
    } else {
        None
    };
    let mut stamp = if root.exists() {
        setup_file(&root.join("setup-version"), !cleanup)?
    } else {
        None
    };
    if cleanup {
        // Preserve all run/receipt data; cleanup only removes this installation's
        // exact capability ACEs and readiness stamp. Other apps/users are untouched.
        if let Some(stamp) = &stamp {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            if unsafe {
                SetFileInformationByHandle(
                    stamp.as_raw_handle(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                return Err("Cannot remove verified native setup stamp.".into());
            }
        }
        for file in handles.iter().rev() {
            metadata_acl(file, capability.sid(), true)?;
        }
        return Ok(());
    }
    let root_handle = handles.last().ok_or("Native setup root is unavailable.")?;
    private_acl(root_handle, owner)?;
    if let Some(file) = &mut maintenance {
        private_acl(file, owner)?;
        write_stamp(file)?;
    }
    private_acl(
        stamp.as_ref().ok_or("Native setup stamp is unavailable.")?,
        owner,
    )?;
    for file in &handles {
        metadata_acl(file, capability.sid(), false)?;
        verify_metadata(file, capability.sid())?;
    }
    write_stamp(stamp.as_mut().ok_or("Native setup stamp is unavailable.")?)?;
    Ok(())
}

/// UI initiation is explicit. No command/tool can trigger elevation or repair.
pub fn request_elevation(cleanup: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    let exe = std::env::current_exe().map_err(|_| "Native setup executable is unavailable.")?;
    files::strict_path(&exe)?;
    let args = format!(
        "--mivlet-execution-setup {} {}",
        security::user_sid()?,
        if cleanup { "cleanup" } else { "repair" }
    );
    let exe_wide = wide(&exe);
    let args_wide = wide(args);
    let verb = wide("runas");
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = exe_wide.as_ptr();
    info.lpParameters = args_wide.as_ptr();
    info.nShow = 0;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(
            "Native setup was declined or blocked by Windows policy. Commands remain unavailable."
                .into(),
        );
    }
    let process = security::Handle::checked(info.hProcess, "Start native setup")?;
    if unsafe { WaitForSingleObject(process.0, 120_000) } != WAIT_OBJECT_0 {
        return Err("Native setup has not finished. Retry inspection after the administrator prompt; no command was run.".into());
    }
    let mut code = 0;
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 || code != 0 {
        return Err(format!("Native execution setup failed (exit {code}). Retry Repair or ask your administrator to permit the bounded metadata ACL setup."));
    }
    if cleanup {
        Ok(())
    } else {
        ready().map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dacl(file: &File) -> String {
        let mut sd = ptr::null_mut();
        let mut text = ptr::null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut sd,
                )
            },
            0
        );
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    sd,
                    1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    ptr::null_mut(),
                )
            },
            0
        );
        let value = unsafe { security::wide_string(text) };
        unsafe {
            LocalFree(text.cast());
            LocalFree(sd.cast());
        }
        value
    }
    #[test]
    fn privileged_acl_helper_changes_only_the_held_object() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("child"), b"existing child custody").unwrap();
        let child = File::open(root.path().join("child")).unwrap();
        let before = dacl(&child);
        let held = lock_directory(root.path(), true).unwrap();
        private_acl(&held, &security::user_sid().unwrap()).unwrap();
        assert_eq!(
            dacl(&child),
            before,
            "Privileged ACL update propagated to an unvalidated child"
        );
    }
    #[test]
    fn linked_setup_files_cannot_modify_a_sentinel() {
        for name in ["setup-version", "maintenance.lock"] {
            let root = tempfile::tempdir().unwrap();
            let sentinel = root.path().join("sentinel");
            fs::write(&sentinel, b"never truncate or elevate this target").unwrap();
            fs::hard_link(&sentinel, root.path().join(name)).unwrap();
            assert!(setup_file(&root.path().join(name), true).is_err());
            assert_eq!(
                fs::read(&sentinel).unwrap(),
                b"never truncate or elevate this target"
            );
            fs::remove_file(root.path().join(name)).unwrap();
            if std::os::windows::fs::symlink_file(&sentinel, root.path().join(name)).is_ok() {
                assert!(setup_file(&root.path().join(name), true).is_err());
                assert_eq!(
                    fs::read(&sentinel).unwrap(),
                    b"never truncate or elevate this target"
                );
            }
        }
    }
    #[test]
    fn setup_directory_custody_blocks_replacement() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("held");
        fs::create_dir(&directory).unwrap();
        let held = lock_directory(&directory, true).unwrap();
        assert!(fs::rename(&directory, root.path().join("replacement")).is_err());
        drop(held);
        fs::rename(&directory, root.path().join("replacement")).unwrap();
    }
}
