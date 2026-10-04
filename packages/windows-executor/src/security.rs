//! Windows LPAC identity and explicit, non-inheritable custody handles.
use std::{
    ffi::{c_void, OsStr},
    fs::File,
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Isolation::*, *},
    System::Threading::*,
};

pub(crate) fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub(crate) fn error(action: &str) -> String {
    format!(
        "{action} failed (Windows {}). Repair native execution setup; commands remain blocked.",
        unsafe { GetLastError() }
    )
}
pub(crate) fn random_id() -> Result<String, String> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|_| "Secure execution identity is unavailable.")?;
    Ok(hex::encode(bytes))
}
pub(crate) struct Handle(pub HANDLE);
impl Handle {
    pub fn checked(raw: HANDLE, action: &str) -> Result<Self, String> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(error(action))
        } else {
            Ok(Self(raw))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
// An owned kernel handle is process-wide, and closes exactly once.
unsafe impl Send for Handle {}

pub(crate) fn sid_text(sid: PSID) -> Result<String, String> {
    let mut pointer = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut pointer) } == 0 {
        return Err(error("Resolve execution identity"));
    }
    let result = unsafe { wide_string(pointer) };
    unsafe {
        LocalFree(pointer.cast());
    }
    Ok(result)
}
pub(crate) unsafe fn wide_string(pointer: *const u16) -> String {
    let mut length = 0;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}
pub(crate) fn user_sid() -> Result<String, String> {
    let mut raw = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(error("Read native identity"));
    }
    let token = Handle::checked(raw, "Read native identity")?;
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length);
    }
    if length == 0 || length > 65536 {
        return Err("Invalid native identity.".into());
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(error("Read native identity"));
    }
    sid_text(unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}

/// Capability SIDs are not users. LPAC's second access check admits only an
/// explicitly granted package/capability SID, even for Everyone-readable files.
pub(crate) struct Capability {
    groups: *mut PSID,
    group_count: u32,
    sids: *mut PSID,
    count: u32,
}
impl Capability {
    pub fn derive(name: &str) -> Result<Self, String> {
        let mut result = Self {
            groups: ptr::null_mut(),
            group_count: 0,
            sids: ptr::null_mut(),
            count: 0,
        };
        if unsafe {
            DeriveCapabilitySidsFromName(
                wide(name).as_ptr(),
                &mut result.groups,
                &mut result.group_count,
                &mut result.sids,
                &mut result.count,
            )
        } == 0
            || result.count != 1
        {
            return Err(error("Derive restricted capability"));
        }
        Ok(result)
    }
    pub fn sid(&self) -> PSID {
        unsafe { *self.sids }
    }
}
impl Drop for Capability {
    fn drop(&mut self) {
        unsafe {
            for index in 0..self.count {
                LocalFree((*self.sids.add(index as usize)).cast());
            }
            for index in 0..self.group_count {
                LocalFree((*self.groups.add(index as usize)).cast());
            }
            if !self.sids.is_null() {
                LocalFree(self.sids.cast());
            }
            if !self.groups.is_null() {
                LocalFree(self.groups.cast());
            }
        }
    }
}

pub(crate) struct Profile {
    pub name: String,
    pub sid: PSID,
    pub text: String,
}
impl Profile {
    pub fn remove(&self) -> Result<(), String> {
        let hr = unsafe { DeleteAppContainerProfile(wide(&self.name).as_ptr()) };
        if hr < 0 {
            return Err(format!("Native execution profile cleanup failed ({hr:#x}); no outputs imported. Recovery is required."));
        }
        Ok(())
    }
    pub fn create(id: &str) -> Result<Self, String> {
        let name = format!("Mivlet.Exec.{id}");
        let mut sid = ptr::null_mut();
        let hr = unsafe {
            CreateAppContainerProfile(
                wide(&name).as_ptr(),
                wide("Mivlet execution").as_ptr(),
                wide("Ephemeral restricted command identity").as_ptr(),
                ptr::null(),
                0,
                &mut sid,
            )
        };
        if hr < 0 {
            return Err(format!(
                "Windows execution identity setup failed ({hr:#x}). Commands remain blocked."
            ));
        }
        let mut profile = Self {
            name,
            sid,
            text: String::new(),
        };
        profile.text = sid_text(sid)?;
        // No persistent writable package home outside the supervised tree.
        let mut folder = ptr::null_mut();
        if unsafe { GetAppContainerFolderPath(wide(&profile.text).as_ptr(), &mut folder) } < 0 {
            return Err(error("Inspect execution profile"));
        }
        let path = std::path::PathBuf::from(unsafe { wide_string(folder) });
        unsafe {
            windows_sys::Win32::System::Com::CoTaskMemFree(folder.cast());
        }
        crate::files::strict_path(&path)?;
        protect(&path, &profile.text, "0x1200a9")?;
        Ok(profile)
    }
}

/// Verify the security property rather than querying class 46, which some
/// supported Windows builds reject with ERROR_INVALID_PARAMETER. Both checks
/// use documented AccessCheck semantics on the actual suspended child token:
/// ordinary AppContainers can read ALL_APPLICATION_PACKAGES objects; LPAC
/// cannot, while an explicit grant to this exact package must still work.
pub(crate) fn verify_lpac(token: HANDLE, package: &str) -> Result<(), String> {
    let mut raw = ptr::null_mut();
    if unsafe {
        DuplicateTokenEx(
            token,
            TOKEN_QUERY | TOKEN_IMPERSONATE,
            ptr::null(),
            SecurityImpersonation,
            TokenImpersonation,
            &mut raw,
        )
    } == 0
    {
        return Err(error("Verify restricted access checks"));
    }
    let duplicate = Handle::checked(raw, "Verify restricted access checks")?;
    for (sid, expected) in [("S-1-15-2-1", false), (package, true)] {
        let sddl = wide(format!("O:SYG:SYD:(A;;0x1;;;WD)(A;;0x1;;;{sid})"));
        let mut sd = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(error("Prepare restricted access check"));
        }
        let mapping = GENERIC_MAPPING {
            GenericRead: 1,
            GenericWrite: 2,
            GenericExecute: 4,
            GenericAll: 7,
        };
        let mut privileges = [0usize; 64];
        let mut length = size_of_val(&privileges) as u32;
        let mut granted = 0;
        let mut allowed = 0;
        let ok = unsafe {
            AccessCheck(
                sd,
                duplicate.0,
                1,
                &mapping,
                privileges.as_mut_ptr().cast(),
                &mut length,
                &mut granted,
                &mut allowed,
            )
        };
        let last_error = unsafe { GetLastError() };
        unsafe {
            LocalFree(sd.cast());
        }
        if ok == 0 || (allowed != 0) != expected {
            return Err(format!("Restricted access verification failed (expected {expected}, allowed {allowed}, error {last_error}). No command was started."));
        }
    }
    Ok(())
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            let _ = self.remove();
            FreeSid(self.sid);
        }
    }
}

/// Protected DACLs suppress inherited broad grants. OWNER RIGHTS suppresses
/// implicit WRITE_DAC; the package receives Modify, never ownership/ACL rights.
pub(crate) fn protect(path: &Path, sid: &str, rights: &str) -> Result<(), String> {
    let owner = user_sid()?;
    set_sddl(path,&format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{owner})(A;OICI;{rights};;;{sid})(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;LW)"),true)
}
pub(crate) fn set_sddl(path: &Path, sddl: &str, protected: bool) -> Result<(), String> {
    let mut sd = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(error("Prepare execution ACL"));
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = ptr::null_mut();
    let mut sacl = ptr::null_mut();
    unsafe {
        GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted);
        GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted);
    }
    let mut flags = DACL_SECURITY_INFORMATION;
    if protected {
        flags |= PROTECTED_DACL_SECURITY_INFORMATION;
    }
    if !sacl.is_null() {
        flags |= LABEL_SECURITY_INFORMATION;
    }
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            flags,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            sacl,
        )
    };
    unsafe {
        LocalFree(sd);
    }
    if status != 0 {
        return Err(format!(
            "Execution filesystem boundary failed (Windows {status}); commands remain blocked."
        ));
    }
    Ok(())
}
pub(crate) fn locked_file(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "Cannot lock execution runtime or snapshot file.".to_owned())?;
    crate::files::regular_file(&file)?;
    Ok(file)
}

/// The attribute storage owns every pointed-to value until CreateProcess ends.
pub(crate) struct Attributes {
    storage: Vec<usize>,
    pub list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    pub fn new(count: u32) -> Result<Self, String> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err(error("Allocate process boundary"));
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, count, 0, &mut bytes) } == 0 {
            return Err(error("Initialize process boundary"));
        }
        Ok(Self { storage, list })
    }
    pub fn set<T>(&mut self, key: u32, value: &T) -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                key as usize,
                (value as *const T).cast::<c_void>(),
                size_of::<T>(),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            return Err(error("Bind process boundary"));
        }
        Ok(())
    }
    pub fn handles(&mut self, handles: &[HANDLE]) -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            return Err(error("Bind isolated process handles"));
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        let _ = &self.storage;
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}
