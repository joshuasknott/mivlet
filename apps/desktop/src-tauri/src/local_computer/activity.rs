//! Small native Stop window on its own message thread, independent of React,
//! provider calls and blocking accessibility providers. It never activates.
use super::LocalComputerState;
use std::sync::Arc;

#[cfg(windows)]
pub(crate) fn start(state: Arc<LocalComputerState>) -> Result<(), String> {
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::COLOR_WINDOW,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    thread_local! {
        static CONTROL: Cell<*const LocalComputerState> = const { Cell::new(std::ptr::null()) };
        static LABEL: Cell<&'static str> = const { Cell::new("") };
    }
    fn user_input(window: HWND) {
        if window.is_null() {
            return;
        }
        let root = unsafe { GetAncestor(window, GA_ROOT) };
        CONTROL.with(|pointer| {
            let pointer = pointer.get();
            if !pointer.is_null() {
                // Only the window identity is used. No text, key code, cursor
                // coordinates or input history leaves this callback.
                unsafe {
                    (&*pointer).native.user_input(root as usize as u64);
                }
            }
        });
    }
    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN) {
            let input = &*(lparam as *const KBDLLHOOKSTRUCT);
            if input.flags & LLKHF_INJECTED == 0 {
                user_input(GetForegroundWindow());
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(
                wparam as u32,
                WM_LBUTTONDOWN
                    | WM_RBUTTONDOWN
                    | WM_MBUTTONDOWN
                    | WM_XBUTTONDOWN
                    | WM_MOUSEWHEEL
                    | WM_MOUSEHWHEEL
            )
        {
            let input = &*(lparam as *const MSLLHOOKSTRUCT);
            if input.flags & LLMHF_INJECTED == 0 {
                user_input(WindowFromPoint(input.pt));
                // Windows can route wheel input to the active app or the
                // hovered app, depending on the user's inactive-scroll setting.
                if matches!(wparam as u32, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
                    user_input(GetForegroundWindow());
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const LocalComputerState;
        if !pointer.is_null() {
            let state = &*pointer;
            match message {
                WM_COMMAND if wparam & 0xffff == 1 => {
                    state.native.stop("Stopped with the activity control. Already dispatched Windows input may have taken effect. Start a new request to resume.");
                    return 0;
                }
                WM_HOTKEY => {
                    state.native.stop("Stopped with Ctrl+Alt+Esc. Already dispatched Windows input may have taken effect. Start a new request to resume.");
                    return 0;
                }
                WM_CLOSE => {
                    state
                        .native
                        .stop("Computer control stopped. Start a new request to resume.");
                    ShowWindow(hwnd, SW_HIDE);
                    return 0;
                }
                WM_MOUSEACTIVATE => return MA_NOACTIVATE as isize,
                WM_TIMER => {
                    if state.closing.load(Ordering::Acquire) {
                        DestroyWindow(hwnd);
                        return 0;
                    }
                    state.native.monitor();
                    let label = state.native.activity_label();
                    LABEL.with(|current| {
                        if current.replace(label) != label {
                            SetWindowTextW(GetDlgItem(hwnd, 2), wide(label).as_ptr());
                        }
                    });
                    ShowWindow(
                        hwnd,
                        if state.native.active() {
                            SW_SHOWNOACTIVATE
                        } else {
                            SW_HIDE
                        },
                    );
                    return 0;
                }
                WM_DESTROY => {
                    state
                        .native
                        .stop("Computer activity control closed. Start a new request to resume.");
                    PostQuitMessage(0);
                    return 0;
                }
                _ => {}
            }
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
    let (ready, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new().name("mivlet-computer-stop".into()).spawn(move || unsafe {
        CONTROL.with(|pointer| pointer.set(Arc::as_ptr(&state)));
        let instance = GetModuleHandleW(std::ptr::null());
        let class = wide("MivletNativeComputerStop");
        let wc = WNDCLASSW { lpfnWndProc:Some(procedure),hInstance:instance,lpszClassName:class.as_ptr(),hCursor:LoadCursorW(std::ptr::null_mut(),IDC_ARROW),hbrBackground:(COLOR_WINDOW+1) as _,..std::mem::zeroed() };
        if RegisterClassW(&wc) == 0 { let _ = ready.send(Err("The computer Stop control could not start.".to_string())); return; }
        let hwnd = CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,class.as_ptr(),wide("Mivlet computer control").as_ptr(),WS_CAPTION|WS_SYSMENU,
            (GetSystemMetrics(SM_CXSCREEN)-350).max(0),20,330,118,std::ptr::null_mut(),std::ptr::null_mut(),instance,Arc::as_ptr(&state) as _);
        if hwnd.is_null() { let _ = ready.send(Err("The computer Stop control could not open.".to_string())); return; }
        let text = CreateWindowExW(0,wide("STATIC").as_ptr(),wide("Agent is using an app").as_ptr(),WS_CHILD|WS_VISIBLE,12,8,290,22,hwnd,2usize as _,instance,std::ptr::null());
        let button = CreateWindowExW(0,wide("BUTTON").as_ptr(),wide("Stop  (Ctrl+Alt+Esc)").as_ptr(),WS_CHILD|WS_VISIBLE|WS_TABSTOP,12,34,290,36,hwnd,1usize as _,instance,std::ptr::null());
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), instance, 0);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), instance, 0);
        if text.is_null() || button.is_null() || keyboard_hook.is_null() || mouse_hook.is_null() || RegisterHotKey(hwnd,1,MOD_CONTROL|MOD_ALT|MOD_NOREPEAT,VK_ESCAPE as u32) == 0 || SetTimer(hwnd,1,50,None) == 0 {
            if !keyboard_hook.is_null() { UnhookWindowsHookEx(keyboard_hook); }
            if !mouse_hook.is_null() { UnhookWindowsHookEx(mouse_hook); }
            DestroyWindow(hwnd); let _ = ready.send(Err("The native Stop button or Ctrl+Alt+Esc shortcut is unavailable. Computer control remains off.".into())); return;
        }
        let _ = ready.send(Ok(()));
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message,std::ptr::null_mut(),0,0)>0 { TranslateMessage(&message); DispatchMessageW(&message); }
        UnregisterHotKey(hwnd,1);
        UnhookWindowsHookEx(keyboard_hook);
        UnhookWindowsHookEx(mouse_hook);
        CONTROL.with(|pointer| pointer.set(std::ptr::null()));
    }).map_err(|_| "The computer Stop thread could not start.")?;
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "The computer Stop control did not respond.")?
}
#[cfg(not(windows))]
pub(crate) fn start(_: Arc<LocalComputerState>) -> Result<(), String> {
    Err("Computer use requires Windows x64.".into())
}
