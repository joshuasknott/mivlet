//! Bounded administrator setup: metadata-only traversal on the fixed execution
//! ancestry. Normal runs never elevate, modify system policy, or change ACLs on
//! user projects. No accounts, passwords, network exemptions, or services exist.
use crate::{
    files,
    security::{self, wide, Capability},
};
use std::{
    fs,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::Com::CoTaskMemFree,
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

fn metadata_acl(path: &Path, sid: PSID, remove: bool) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    let mut old_acl = ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
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
            SetNamedSecurityInfoW(
                wide(path).as_ptr(),
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
fn verify_metadata(path: &Path, sid: PSID) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
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
        verify_metadata(path, capability.sid())?;
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
    let parent = root.parent().ok_or("Invalid native setup root.")?;
    let capability = traversal(owner)?;
    let _maintenance = if root.exists() && root.join("maintenance.lock").exists() {
        Some(crate::custody::installation(&root, true)?)
    } else {
        None
    };
    if cleanup {
        // Preserve all run/receipt data; cleanup only removes this installation's
        // exact capability ACEs and readiness stamp. Other apps/users are untouched.
        if root.exists() {
            files::strict_path(&root)?;
            let _ = fs::remove_file(root.join("setup-version"));
        }
        for path in ancestry(&root).into_iter().rev().filter(|p| p.exists()) {
            metadata_acl(path, capability.sid(), true)?;
        }
        return Ok(());
    }
    files::strict_path(&program_data()?)?;
    fs::create_dir_all(parent).map_err(|_| "Cannot prepare native execution root.")?;
    files::strict_path(parent)?;
    fs::create_dir_all(&root).map_err(|_| "Cannot prepare native execution installation.")?;
    files::strict_path(&root)?;
    security::set_sddl(
        &root,
        &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{owner})(A;OICI;RC;;;OW)"),
        true,
    )?;
    if !root.join("maintenance.lock").exists() {
        use std::io::Write;
        let mut lease = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join("maintenance.lock"))
            .map_err(|_| "Cannot prepare execution maintenance lock.")?;
        lease
            .write_all(b"1")
            .and_then(|_| lease.sync_all())
            .map_err(|_| "Cannot persist execution maintenance lock.")?;
    }
    for path in ancestry(&root) {
        metadata_acl(path, capability.sid(), false)?;
        verify_metadata(path, capability.sid())?;
    }
    fs::write(root.join("setup-version"), b"1").map_err(|_| "Cannot finish native setup.")?;
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
