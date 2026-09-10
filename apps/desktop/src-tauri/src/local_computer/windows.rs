//! Native window identity and foreground checks; input itself belongs to Cua.
//! Window properties distinguish HWND reuse within the same process lifetime.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WindowIdentity {
    pub pid: u32,
    pub hwnd: u64,
    thread: u32,
    process_created: u64,
    class: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowChoice {
    pub id: String,
    pub application: String,
    pub title: String,
    #[serde(skip)]
    pub(super) identity: WindowIdentity,
}

pub(super) struct WindowBinding {
    pub identity: WindowIdentity,
    property: Vec<u16>,
    original_no_activate: bool,
    originally_enabled: bool,
    background_disable_shield: bool,
}

pub(super) fn safe_label(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(limit)
        .collect()
}

// Matches the bundled Cua 0.25.0 keyboard/fg_bypass routing. Restrict cleanup
// to windows this pin can disable; never enable an unrelated modal owner.
fn background_disable_shield(class: &str, application: &str) -> bool {
    class.starts_with("Chrome_WidgetWin_")
        || class.starts_with("CefBrowser")
        || matches!(
            class,
            "ApplicationFrameWindow"
                | "WinUIDesktopWin32WindowClass"
                | "Windows.UI.Core.CoreWindow"
                | "Microsoft.UI.Content.DesktopChildSiteBridge"
        )
        || matches!(
            application.to_ascii_lowercase().as_str(),
            "notepad"
                | "calculatorapp"
                | "calc"
                | "applicationframehost"
                | "photos"
                | "systemsettings"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_only_enables_windows_the_pinned_driver_can_shield() {
        assert!(background_disable_shield("Chrome_WidgetWin_1", "chrome"));
        assert!(background_disable_shield("Notepad", "Notepad"));
        assert!(background_disable_shield(
            "WinUIDesktopWin32WindowClass",
            "sample"
        ));
        assert!(!background_disable_shield(
            "WindowsForms10.Window",
            "MivletComputerFixture"
        ));
        assert!(!background_disable_shield("HwndWrapper[sample]", "sample"));
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HWND, LPARAM, RECT},
        System::Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled},
            WindowsAndMessaging::*,
        },
    };

    fn hwnd(value: u64) -> HWND {
        value as usize as HWND
    }

    pub(super) fn identity(value: u64) -> Result<WindowIdentity, String> {
        unsafe {
            let handle = hwnd(value);
            if IsWindow(handle) == 0 {
                return Err("The selected window closed. Select an open window again.".into());
            }
            let mut pid = 0;
            let thread = GetWindowThreadProcessId(handle, &mut pid);
            if thread == 0 || pid == 0 || pid == std::process::id() {
                return Err("Choose another application's window.".into());
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return Err("This application is inaccessible. Elevated or protected windows are unavailable.".into());
            }
            let mut created: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let okay = GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user);
            CloseHandle(process);
            if okay == 0 {
                return Err("The application's process identity is unavailable.".into());
            }
            let mut class = [0u16; 256];
            let count = GetClassNameW(handle, class.as_mut_ptr(), class.len() as i32);
            if count <= 0 {
                return Err("The selected window identity is unavailable.".into());
            }
            Ok(WindowIdentity {
                pid,
                hwnd: value,
                thread,
                process_created: (u64::from(created.dwHighDateTime) << 32)
                    | u64::from(created.dwLowDateTime),
                class: String::from_utf16_lossy(&class[..count as usize]),
            })
        }
    }

    unsafe extern "system" fn enumerate(handle: HWND, data: LPARAM) -> i32 {
        let result = &mut *(data as *mut Vec<WindowChoice>);
        if result.len() >= 100 {
            return 0;
        }
        if IsWindowVisible(handle) == 0 || IsIconic(handle) != 0 {
            return 1;
        }
        let Ok(identity) = identity(handle as usize as u64) else {
            return 1;
        };
        if GetWindow(handle, GW_OWNER).is_null()
            && GetWindowLongPtrW(handle, GWL_EXSTYLE) & WS_EX_TOOLWINDOW as isize != 0
        {
            return 1;
        }
        let mut title = [0u16; 513];
        let count = GetWindowTextW(handle, title.as_mut_ptr(), title.len() as i32);
        if count <= 0 {
            return 1;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, identity.pid);
        if process.is_null() {
            return 1;
        }
        let mut path = [0u16; 1024];
        let mut size = path.len() as u32;
        let okay = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if okay == 0 {
            return 1;
        }
        let path = String::from_utf16_lossy(&path[..size as usize]);
        let application = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("Application")
            .trim_end_matches(".exe");
        let Ok(id) = super::super::desktop_tools::opaque_id() else {
            return 0;
        };
        result.push(WindowChoice {
            id,
            application: safe_label(application, 80),
            title: safe_label(&String::from_utf16_lossy(&title[..count as usize]), 160),
            identity,
        });
        1
    }

    pub(super) fn choices() -> Result<Vec<WindowChoice>, String> {
        let mut output = Vec::new();
        unsafe {
            EnumWindows(Some(enumerate), std::ptr::addr_of_mut!(output) as LPARAM);
        }
        Ok(output)
    }

    pub(super) fn bind(
        expected: WindowIdentity,
        application: &str,
    ) -> Result<WindowBinding, String> {
        if identity(expected.hwnd)? != expected {
            return Err("The selected application changed. Choose it again.".into());
        }
        let property: Vec<u16> = format!(
            "Mivlet.Control.{}\0",
            super::super::desktop_tools::opaque_id()?
        )
        .encode_utf16()
        .collect();
        unsafe {
            if SetPropW(hwnd(expected.hwnd), property.as_ptr(), 1usize as _) == 0 {
                return Err("Windows denied control of this application. Elevated and protected windows are unsupported.".into());
            }
        }
        let binding = WindowBinding {
            background_disable_shield: background_disable_shield(&expected.class, application),
            original_no_activate: unsafe { GetWindowLongPtrW(hwnd(expected.hwnd), GWL_EXSTYLE) }
                & WS_EX_NOACTIVATE as isize
                != 0,
            originally_enabled: unsafe { IsWindowEnabled(hwnd(expected.hwnd)) } != 0,
            identity: expected,
            property,
        };
        binding.check(false)?;
        Ok(binding)
    }

    impl WindowBinding {
        fn verify_identity(&self) -> Result<(), String> {
            if identity(self.identity.hwnd)? != self.identity
                || unsafe { GetPropW(hwnd(self.identity.hwnd), self.property.as_ptr()) } as usize
                    != 1
            {
                return Err(
                    "The selected window was replaced. Start a new request to resume.".into(),
                );
            }
            Ok(())
        }
        pub(super) fn verify(&self, foreground: bool) -> Result<(), String> {
            self.verify_identity()?;
            if unsafe { IsWindowVisible(hwnd(self.identity.hwnd)) } == 0
                || unsafe { IsIconic(hwnd(self.identity.hwnd)) } != 0
            {
                return Err("The selected window is hidden or minimised. Restore it yourself, then start a fresh request. Mivlet will not restore or raise it automatically.".into());
            }
            if foreground && unsafe { GetForegroundWindow() } != hwnd(self.identity.hwnd) {
                return Err("Foreground focus changed. Computer control stopped; start a new request to select the window again.".into());
            }
            Ok(())
        }

        pub(super) fn enabled(&self) -> Result<(), String> {
            self.verify(false)?;
            if unsafe { IsWindowEnabled(hwnd(self.identity.hwnd)) } == 0 {
                return Err("The selected app is disabled or a dialog needs attention. Computer control stopped; select the current window in a fresh request.".into());
            }
            Ok(())
        }

        pub(super) fn restore(&self) -> Result<(), String> {
            // A closed/reused HWND must never be changed by old cleanup.
            if self.verify_identity().is_err() {
                return Ok(());
            }
            unsafe {
                let handle = hwnd(self.identity.hwnd);
                let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
                let restored = if self.original_no_activate {
                    style | WS_EX_NOACTIVATE as isize
                } else {
                    style & !(WS_EX_NOACTIVATE as isize)
                };
                if restored != style {
                    SetWindowLongPtrW(handle, GWL_EXSTYLE, restored);
                    if GetWindowLongPtrW(handle, GWL_EXSTYLE) & WS_EX_NOACTIVATE as isize
                        != restored & WS_EX_NOACTIVATE as isize
                    {
                        return Err(
                            "The stopped action's window state could not be restored.".into()
                        );
                    }
                }
                // Cua shields XAML/Chromium input by temporarily disabling the
                // root. A real owned dialog must keep its owner's disabled state.
                let popup = GetWindow(handle, GW_ENABLEDPOPUP);
                if self.background_disable_shield
                    && self.originally_enabled
                    && IsWindowEnabled(handle) == 0
                    && (popup.is_null() || popup == handle || IsWindowVisible(popup) == 0)
                {
                    EnableWindow(handle, 1);
                    if IsWindowEnabled(handle) == 0 {
                        return Err("The stopped action's app could not be re-enabled.".into());
                    }
                }
            }
            Ok(())
        }
    }

    pub(super) fn focus(binding: &WindowBinding) -> Result<(), String> {
        binding.verify(false)?;
        unsafe {
            SetForegroundWindow(hwnd(binding.identity.hwnd));
        }
        // Activation crosses input queues. Allow its one requested transition
        // to settle; never repeatedly steal focus or send input here.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        while unsafe { GetForegroundWindow() } != hwnd(binding.identity.hwnd)
            && std::time::Instant::now() < deadline
        {
            binding.verify(false)?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        binding.verify(true)
    }
    pub(super) fn release(binding: &WindowBinding) {
        unsafe {
            if GetPropW(hwnd(binding.identity.hwnd), binding.property.as_ptr()) as usize == 1 {
                RemovePropW(hwnd(binding.identity.hwnd), binding.property.as_ptr());
            }
        }
    }
    pub(super) fn dimensions(binding: &WindowBinding) -> Result<(u32, u32), String> {
        binding.verify(false)?;
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd(binding.identity.hwnd), &mut rect) } == 0 {
            return Err("The window size is unavailable.".into());
        }
        Ok((
            (rect.right - rect.left).max(0) as u32,
            (rect.bottom - rect.top).max(0) as u32,
        ))
    }
}

impl WindowBinding {
    #[cfg(all(test, windows))]
    pub(super) fn invalidate_marker_for_test(&self) {
        platform::release(self);
    }
    pub(super) fn new(identity: WindowIdentity, application: &str) -> Result<Self, String> {
        #[cfg(windows)]
        {
            platform::bind(identity, application)
        }
        #[cfg(not(windows))]
        {
            let _ = (identity, application);
            Err("Computer use requires Windows.".into())
        }
    }
    pub(super) fn check(&self, foreground: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.verify(foreground)
        }
        #[cfg(not(windows))]
        {
            let _ = foreground;
            Err("Computer use requires Windows.".into())
        }
    }
    pub(super) fn focus(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            platform::focus(self)
        }
        #[cfg(not(windows))]
        {
            Err("Computer use requires Windows.".into())
        }
    }
    pub(super) fn dimensions(&self) -> Result<(u32, u32), String> {
        #[cfg(windows)]
        {
            platform::dimensions(self)
        }
        #[cfg(not(windows))]
        {
            Err("Computer use requires Windows.".into())
        }
    }

    pub(super) fn check_enabled(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.enabled()
        }
        #[cfg(not(windows))]
        {
            Err("Computer use requires Windows.".into())
        }
    }

    pub(super) fn restore_background_state(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.restore()
        }
        #[cfg(not(windows))]
        {
            Err("Computer use requires Windows.".into())
        }
    }

    pub(super) fn background_requires_foreground(&self) -> bool {
        // Pinned Cua fg_bypass.rs documents WPF peers self-activating even
        // through the disabled-window shield. Refuse before dispatch.
        self.identity.class.starts_with("HwndWrapper[")
    }
}
impl Drop for WindowBinding {
    fn drop(&mut self) {
        #[cfg(windows)]
        platform::release(self);
    }
}

pub(super) fn list_windows() -> Result<Vec<WindowChoice>, String> {
    #[cfg(windows)]
    {
        platform::choices()
    }
    #[cfg(not(windows))]
    {
        Err("Native computer use currently requires Windows.".into())
    }
}

pub(super) fn foreground() -> u64 {
    #[cfg(windows)]
    {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as usize as u64
        }
    }
    #[cfg(not(windows))]
    {
        0
    }
}

pub(super) fn belongs_to_window(mut candidate: u64, target: u64) -> bool {
    for _ in 0..8 {
        if candidate == target {
            return true;
        }
        if candidate == 0 {
            break;
        }
        #[cfg(windows)]
        {
            candidate = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetWindow(
                    candidate as usize as _,
                    windows_sys::Win32::UI::WindowsAndMessaging::GW_OWNER,
                ) as usize as u64
            };
        }
        #[cfg(not(windows))]
        {
            candidate = 0;
        }
    }
    false
}

/// Inspect password metadata without asking Windows for password values.
/// Runs outside the authority lock; Stop does not wait on a third-party UIA provider.
#[cfg(windows)]
pub(super) fn privacy_check(window: u64) -> Result<(), String> {
    use ::windows::Win32::{
        Foundation::HWND,
        System::{Com::*, Variant::VARIANT},
        UI::Accessibility::*,
    };
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _apartment = Apartment(initialized.is_ok());
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|_| {
                "Windows accessibility is unavailable. Computer control remains off."
            })?;
        let root = automation.ElementFromHandle(HWND(window as usize as _))
            .map_err(|_| "The application's accessibility state is inaccessible. Computer control remains off.")?;
        let condition = automation
            .CreatePropertyCondition(UIA_IsPasswordPropertyId, &VARIANT::from(true))
            .map_err(|_| "The application's privacy state could not be checked.")?;
        let matches = root
            .FindAll(TreeScope_Subtree, &condition)
            .map_err(|_| "The application's privacy state could not be checked.")?;
        if matches
            .Length()
            .map_err(|_| "The application's privacy state could not be checked.")?
            > 0
        {
            return Err("This window contains a password field. Stop computer control and complete the private step yourself.".into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
pub(super) fn privacy_check(_: u64) -> Result<(), String> {
    Err("Computer use requires Windows.".into())
}
