extern crate webview2_com_sys;
pub use webview2_com_sys::Microsoft;

#[macro_use]
extern crate webview2_com_macros;

mod callback;
mod options;
mod pwstr;

use std::{
    cell::Cell,
    fmt,
    marker::PhantomData,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

use windows::{
    core::HRESULT,
    Win32::{
        Foundation::{CloseHandle, HANDLE, RPC_E_TIMEOUT, RPC_S_CALLPENDING},
        System::{
            Com::{CoWaitForMultipleHandles, COWAIT_DEFAULT, COWAIT_DISPATCH_CALLS},
            Threading::CreateEventW,
        },
        UI::WindowsAndMessaging::{self, MSG, PM_REMOVE, WM_QUIT},
    },
};

pub use callback::*;
pub use options::*;
pub use pwstr::*;

#[derive(Debug)]
pub enum Error {
    WindowsError(windows::core::Error),
    CallbackError(String),
    TaskCanceled,
    SendError,
    TimedOut,
    ChannelDisconnected,
}

impl std::error::Error for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl From<windows::core::Error> for Error {
    fn from(err: windows::core::Error) -> Self {
        Self::WindowsError(err)
    }
}

impl From<HRESULT> for Error {
    fn from(err: HRESULT) -> Self {
        Self::WindowsError(windows::core::Error::from(err))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

thread_local! {
    static WAIT_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Bounds waits made by [`wait_with_pump`] on the current thread.
///
/// The deadline is scoped so existing cookie and callback waits retain their
/// historical unbounded behavior unless the caller explicitly opts in. Nested
/// scopes restore the previous deadline when dropped.
pub struct WaitDeadlineGuard {
    previous: Option<Instant>,
    // This guard restores a thread-local value on Drop and must stay on that
    // thread for the lifetime of the scope.
    _not_send: PhantomData<Rc<()>>,
}

/// Set a deadline for WebView2 initialization waits on the current thread.
pub fn scoped_wait_deadline(duration: Duration) -> WaitDeadlineGuard {
    let deadline = Instant::now() + duration;
    let previous = WAIT_DEADLINE.with(|cell| {
        let previous = cell.get();
        cell.set(Some(
            previous.map_or(deadline, |previous| previous.min(deadline)),
        ));
        previous
    });
    WaitDeadlineGuard {
        previous,
        _not_send: PhantomData,
    }
}

impl Drop for WaitDeadlineGuard {
    fn drop(&mut self) {
        WAIT_DEADLINE.with(|cell| cell.set(self.previous));
    }
}

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        // The event is created and owned by the enclosing wait.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn pump_pending_messages() -> Result<()> {
    const MAX_MESSAGES_PER_SLICE: usize = 64;
    let mut msg = MSG::default();
    unsafe {
        for _ in 0..MAX_MESSAGES_PER_SLICE {
            if !WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                break;
            }
            if msg.message == WM_QUIT {
                // Preserve process shutdown semantics for the caller's outer
                // event loop while still reporting cancellation to WebView2.
                WindowsAndMessaging::PostQuitMessage(msg.wParam.0 as i32);
                return Err(Error::TaskCanceled);
            }
            let _ = WindowsAndMessaging::TranslateMessage(&msg);
            WindowsAndMessaging::DispatchMessageA(&msg);
        }
    }
    Ok(())
}

/// Pump COM and window messages while waiting for a WebView2 result.
///
/// Unlike the upstream implementation, this wait polls the receiver between
/// short COM-aware slices. This avoids depending on a separate
/// `PostThreadMessage` kick and allows callers to apply a bounded deadline to
/// native startup without moving apartment-bound COM values to another thread.
pub fn wait_with_pump<T>(rx: mpsc::Receiver<T>) -> Result<T> {
    // The receiver may carry apartment-bound COM interfaces, so keep it on the
    // UI thread. Polling between short COM-aware slices avoids requiring `T:
    // Send` and still removes the old dependency on posted-message kicks.
    let event = EventHandle(unsafe { CreateEventW(None, true, false, None)? });
    let deadline = WAIT_DEADLINE.with(Cell::get);
    let flags = (COWAIT_DEFAULT.0 | COWAIT_DISPATCH_CALLS.0) as u32;

    loop {
        match rx.try_recv() {
            Ok(result) => return Ok(result),
            Err(mpsc::TryRecvError::Disconnected) => return Err(Error::ChannelDisconnected),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        pump_pending_messages()?;

        let now = Instant::now();
        let wait_ms = deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_millis(50))
                    .as_millis()
                    .max(1) as u32
            })
            .unwrap_or(50);

        unsafe {
            match CoWaitForMultipleHandles(flags, wait_ms, &[event.0]) {
                Ok(_) => {}
                Err(error)
                    if error.code() == RPC_E_TIMEOUT || error.code() == RPC_S_CALLPENDING => {}
                Err(error) => return Err(error.into()),
            }
        }

        // A completion may race the deadline boundary. Prefer a value already
        // delivered to the receiver over reporting a timeout.
        match rx.try_recv() {
            Ok(result) => return Ok(result),
            Err(mpsc::TryRecvError::Disconnected) => return Err(Error::ChannelDisconnected),
            Err(mpsc::TryRecvError::Empty) => {}
        }

        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(Error::TimedOut);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::GetCurrentThreadId;

    struct ComGuard;

    impl ComGuard {
        fn new() -> Self {
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                    .ok()
                    .expect("test thread must initialize a COM apartment");
            }
            Self
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[test]
    fn completes_without_a_posted_message() {
        let _com = ComGuard::new();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            tx.send(42).unwrap();
        });

        let _deadline = scoped_wait_deadline(Duration::from_secs(1));
        assert_eq!(wait_with_pump(rx).unwrap(), 42);
    }

    #[test]
    fn reports_a_disconnected_channel() {
        let _com = ComGuard::new();
        let (tx, rx) = mpsc::channel::<()>();
        drop(tx);

        let _deadline = scoped_wait_deadline(Duration::from_secs(1));
        assert!(matches!(
            wait_with_pump(rx),
            Err(Error::ChannelDisconnected)
        ));
    }

    #[test]
    fn nested_deadlines_cannot_extend_the_outer_scope() {
        let outer = scoped_wait_deadline(Duration::from_secs(1));
        let outer_deadline = WAIT_DEADLINE.with(Cell::get).unwrap();
        {
            let _inner = scoped_wait_deadline(Duration::from_secs(10));
            assert_eq!(WAIT_DEADLINE.with(Cell::get), Some(outer_deadline));
        }
        assert_eq!(WAIT_DEADLINE.with(Cell::get), Some(outer_deadline));
        drop(outer);
        assert_eq!(WAIT_DEADLINE.with(Cell::get), None);
    }

    #[test]
    fn reports_a_scoped_timeout() {
        let _com = ComGuard::new();
        let (_tx, rx) = mpsc::channel::<()>();
        let _deadline = scoped_wait_deadline(Duration::from_millis(20));
        let result = wait_with_pump(rx);
        assert!(matches!(result, Err(Error::TimedOut)), "{result:?}");
    }

    #[test]
    fn preserves_wm_quit() {
        let _com = ComGuard::new();
        unsafe { WindowsAndMessaging::PostQuitMessage(23) };
        let (_tx, rx) = mpsc::channel::<()>();
        let _deadline = scoped_wait_deadline(Duration::from_secs(1));
        assert!(matches!(wait_with_pump(rx), Err(Error::TaskCanceled)));

        let mut msg = MSG::default();
        unsafe {
            assert!(WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool());
        }
        assert_eq!(msg.message, WM_QUIT);
        assert_eq!(msg.wParam.0, 23);
    }

    #[test]
    fn pumps_queued_window_messages_before_completion() {
        let _com = ComGuard::new();
        let (_tx, rx) = mpsc::channel::<()>();
        unsafe {
            WindowsAndMessaging::PostThreadMessageA(
                GetCurrentThreadId(),
                WindowsAndMessaging::WM_APP + 1,
                windows::Win32::Foundation::WPARAM(0),
                windows::Win32::Foundation::LPARAM(0),
            )
            .unwrap();
        }
        let _deadline = scoped_wait_deadline(Duration::from_millis(20));
        let result = wait_with_pump(rx);
        assert!(matches!(result, Err(Error::TimedOut)), "{result:?}");

        let mut msg = MSG::default();
        unsafe {
            assert!(!WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool());
        }
    }

    #[test]
    fn a_busy_message_queue_leaves_time_for_the_deadline_check() {
        let _com = ComGuard::new();
        let mut msg = MSG::default();
        unsafe {
            // Make the thread message queue before posting into it.
            let _ = WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE);
            for _ in 0..128 {
                WindowsAndMessaging::PostThreadMessageA(
                    GetCurrentThreadId(),
                    WindowsAndMessaging::WM_APP + 2,
                    windows::Win32::Foundation::WPARAM(0),
                    windows::Win32::Foundation::LPARAM(0),
                )
                .unwrap();
            }
        }
        pump_pending_messages().unwrap();
        let mut remaining = 0;
        unsafe {
            while WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                remaining += 1;
            }
        }
        assert_eq!(remaining, 64);
    }

    #[test]
    fn completion_can_remain_bound_to_the_current_apartment() {
        let _com = ComGuard::new();
        let (tx, rx) = mpsc::channel();
        let value = Rc::new(42);
        tx.send(value.clone()).unwrap();
        let _deadline = scoped_wait_deadline(Duration::from_secs(1));
        assert!(Rc::ptr_eq(&wait_with_pump(rx).unwrap(), &value));
    }

    #[test]
    fn quit_arriving_during_a_com_wait_is_preserved() {
        let _com = ComGuard::new();
        let mut msg = MSG::default();
        let _ = unsafe { WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE) };
        let thread = unsafe { GetCurrentThreadId() };
        let (_tx, rx) = mpsc::channel::<()>();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            unsafe {
                WindowsAndMessaging::PostThreadMessageA(
                    thread,
                    WM_QUIT,
                    windows::Win32::Foundation::WPARAM(42),
                    windows::Win32::Foundation::LPARAM(0),
                )
                .unwrap();
            }
        });
        let _deadline = scoped_wait_deadline(Duration::from_secs(1));
        let result = wait_with_pump(rx);
        sender.join().unwrap();
        assert!(matches!(result, Err(Error::TaskCanceled)), "{result:?}");
        unsafe {
            assert!(WindowsAndMessaging::PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool());
        }
        assert_eq!(msg.message, WM_QUIT);
        assert_eq!(msg.wParam.0, 42);
    }
}
