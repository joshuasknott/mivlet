//! Native-only masked entry. No WebView, IPC secret parameter, clipboard read,
//! logging, value preview or platform fallback. Capture exclusion must succeed.
use super::{custody::Secret, Failure, RequestInput};

#[cfg(not(windows))]
pub(super) fn prompt(_: &RequestInput, _: &dyn Fn() -> bool) -> Result<Option<Secret>, Failure> {
    Err(Failure::Capture)
}

#[cfg(windows)]
pub(super) fn prompt(
    input: &RequestInput,
    current: &dyn Fn() -> bool,
) -> Result<Option<Secret>, Failure> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Controls::EM_SETLIMITTEXT,
            Input::KeyboardAndMouse::{GetFocus, SetFocus, VK_ESCAPE, VK_RETURN},
            WindowsAndMessaging::*,
        },
    };
    use zeroize::Zeroizing;

    const SAVE: usize = 1;
    const CANCEL: usize = 2;
    const ENTRY: i32 = 3;
    const ERROR: i32 = 4;
    static DIALOG: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _dialog = DIALOG.try_lock().map_err(|_| Failure::Capture)?;
    if !current() {
        return Err(Failure::Stopped);
    }

    struct Context<'a> {
        current: &'a dyn Fn() -> bool,
        result: Option<Result<Option<Secret>, Failure>>,
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    unsafe fn close(
        hwnd: HWND,
        context: *mut Context<'_>,
        result: Result<Option<Secret>, Failure>,
    ) {
        // Win32 destruction re-enters this procedure. Never hold a mutable
        // reference to the context across a call that can dispatch messages.
        (*context).result = Some(result);
        SetWindowTextW(GetDlgItem(hwnd, ENTRY), wide("").as_ptr());
        DestroyWindow(hwnd);
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                (*(lparam as *const CREATESTRUCTW)).lpCreateParams as isize,
            );
        }
        let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Context<'_>;
        if !pointer.is_null() {
            match message {
                WM_TIMER => {
                    if !((*pointer).current)() {
                        close(hwnd, pointer, Err(Failure::Stopped));
                    }
                    return 0;
                }
                WM_CLOSE => {
                    close(hwnd, pointer, Ok(None));
                    return 0;
                }
                WM_COMMAND if wparam & 0xffff == CANCEL => {
                    close(hwnd, pointer, Ok(None));
                    return 0;
                }
                WM_COMMAND if wparam & 0xffff == SAVE => {
                    if !((*pointer).current)() {
                        close(hwnd, pointer, Err(Failure::Stopped));
                        return 0;
                    }
                    let mut buffer = Zeroizing::new([0u16; 513]);
                    let length = GetWindowTextW(
                        GetDlgItem(hwnd, ENTRY),
                        buffer.as_mut_ptr(),
                        buffer.len() as i32,
                    );
                    if length <= 0 {
                        return 0;
                    }
                    let Ok(value) = String::from_utf16(&buffer[..length as usize]) else {
                        return 0;
                    };
                    let value = Secret::new(value);
                    if value.len() < 16 || value.len() > 512 {
                        SetWindowTextW(
                            GetDlgItem(hwnd, ERROR),
                            wide("Use a signing secret of 16 to 512 bytes.").as_ptr(),
                        );
                        return 0;
                    }
                    close(hwnd, pointer, Ok(Some(value)));
                    return 0;
                }
                WM_DESTROY => {
                    KillTimer(hwnd, 1);
                    if (*pointer).result.is_none() {
                        (*pointer).result = Some(Err(Failure::Capture));
                    }
                    return 0;
                }
                _ => {}
            }
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    let mut context = Context {
        current,
        result: None,
    };
    // The context remains on this message thread until the window and controls
    // are destroyed. Windows owns only the masked edit's temporary text.
    unsafe {
        let instance = GetModuleHandleW(null());
        let class = wide("MivletProtectedSecretEntry");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_WINDOW + 1) as _,
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 {
            return Err(Failure::Capture);
        }
        let width = 600.min(GetSystemMetrics(SM_CXSCREEN));
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_CONTROLPARENT,
            class.as_ptr(),
            wide("Mivlet — protected secret request").as_ptr(),
            WS_CAPTION | WS_SYSMENU,
            ((GetSystemMetrics(SM_CXSCREEN) - width) / 2).max(0),
            ((GetSystemMetrics(SM_CYSCREEN) - 410) / 2).max(0),
            width,
            410,
            null_mut(),
            null_mut(),
            instance,
            &mut context as *mut _ as _,
        );
        if hwnd.is_null() {
            UnregisterClassW(class.as_ptr(), instance);
            return Err(Failure::Capture);
        }
        let font = GetStockObject(DEFAULT_GUI_FONT);
        let make =
            |kind: &str, text: &str, style: u32, x: i32, y: i32, w: i32, h: i32, id: usize| {
                let child = CreateWindowExW(
                    0,
                    wide(kind).as_ptr(),
                    wide(text).as_ptr(),
                    WS_CHILD | WS_VISIBLE | style,
                    x,
                    y,
                    w,
                    h,
                    hwnd,
                    id as _,
                    instance,
                    null(),
                );
                SendMessageW(child, WM_SETFONT, font as usize, 1);
                child
            };
        let content_width = width - 48;
        let heading = make("STATIC", &input.label, 0, 20, 18, content_width, 26, 10);
        let reason = make(
            "STATIC",
            &format!("Agent's reason: {}", input.reason),
            0,
            20,
            48,
            content_width,
            58,
            11,
        );
        let target = make(
            "STATIC",
            &format!(
                "For webhook: {}\r\nUse: verify incoming HMAC-SHA256 signatures",
                input.target_id
            ),
            0,
            20,
            112,
            content_width,
            46,
            12,
        );
        let description = make("STATIC", "Only Mivlet's native webhook verifier receives this value. Your agent receives a one-use reference. It expires in 10 minutes.", 0, 20, 164, content_width, 46, 13);
        let label = make(
            "STATIC",
            "&Signing secret",
            0,
            20,
            216,
            content_width,
            20,
            14,
        );
        let edit = make(
            "EDIT",
            "",
            WS_BORDER | WS_TABSTOP | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
            20,
            239,
            content_width,
            27,
            ENTRY as usize,
        );
        SendMessageW(edit, EM_SETLIMITTEXT, 512, 0);
        let error = make(
            "STATIC",
            "16–512 bytes. Cancel declines this request.",
            0,
            20,
            274,
            content_width,
            24,
            ERROR as usize,
        );
        let save = make(
            "BUTTON",
            "&Save securely",
            WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
            20,
            315,
            160,
            34,
            SAVE,
        );
        let cancel = make("BUTTON", "&Decline", WS_TABSTOP, 192, 315, 120, 34, CANCEL);
        if [
            heading,
            reason,
            target,
            description,
            label,
            edit,
            error,
            save,
            cancel,
        ]
        .iter()
        .any(|h| h.is_null())
            || SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0
            || SetTimer(hwnd, 1, 100, None) == 0
        {
            DestroyWindow(hwnd);
            UnregisterClassW(class.as_ptr(), instance);
            return Err(Failure::Capture);
        }
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(edit);
        let mut message: MSG = std::mem::zeroed();
        while context.result.is_none() && GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            if message.message == WM_KEYDOWN
                && (message.wParam == VK_RETURN as usize || message.wParam == VK_ESCAPE as usize)
            {
                SendMessageW(
                    hwnd,
                    WM_COMMAND,
                    if message.wParam == VK_ESCAPE as usize || GetFocus() == cancel {
                        CANCEL
                    } else {
                        SAVE
                    },
                    0,
                );
                continue;
            }
            if IsDialogMessageW(hwnd, &message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if IsWindow(hwnd) != 0 {
            SetWindowTextW(edit, wide("").as_ptr());
            DestroyWindow(hwnd);
        }
        UnregisterClassW(class.as_ptr(), instance);
    }
    context.result.unwrap_or(Err(Failure::Capture))
}
