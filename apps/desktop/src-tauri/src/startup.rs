//! Recover native window failures without replaying workspace effects.
//! The renderer configuration and all normal account admission checks are retained.

#[cfg(any(windows, test))]
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
use tauri::Manager;

pub(crate) fn record(stage: &'static str) {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    eprintln!(
        "[mivlet-startup] {stage} {}",
        STARTED.get_or_init(Instant::now).elapsed().as_millis()
    );
}

fn retry_requested(result: rfd::MessageDialogResult) -> bool {
    result == rfd::MessageDialogResult::Yes
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct RecoveryState(AtomicU8);

#[cfg(any(windows, test))]
impl RecoveryState {
    const READY: u8 = 1;
    const FAILED: u8 = 2;
    const RECOVERING: u8 = 4;

    fn signal(&self, event: u8) -> bool {
        let state = self.0.fetch_or(event, Ordering::AcqRel) | event;
        state & (Self::READY | Self::FAILED) == (Self::READY | Self::FAILED)
            && self.0.fetch_or(Self::RECOVERING, Ordering::AcqRel) & Self::RECOVERING == 0
    }
}

#[cfg(windows)]
static RECOVERY: RecoveryState = RecoveryState(AtomicU8::new(0));

pub(crate) fn finish_setup(app: &tauri::AppHandle) {
    record("setup_complete");
    #[cfg(windows)]
    if RECOVERY.signal(RecoveryState::READY) {
        recover_lost_renderer(app.clone());
    } else {
        watch_renderer_mount(app.clone());
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(any(windows, test))]
async fn await_renderer_mount<F, P>(
    timeout: std::time::Duration,
    interval: std::time::Duration,
    mut probe: F,
) -> bool
where
    F: FnMut() -> P,
    P: std::future::Future<Output = bool>,
{
    tokio::time::timeout(timeout, async {
        loop {
            if probe().await {
                return;
            }
            tokio::time::sleep(interval).await;
        }
    })
    .await
    .is_ok()
}

#[cfg(windows)]
fn watch_renderer_mount(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mounted = await_renderer_mount(
            std::time::Duration::from_secs(60),
            std::time::Duration::from_secs(1),
            || async {
                if crate::account_session::is_restarting() {
                    return true;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return false;
                };
                let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
                // Observe only a boolean from the main React root. No content,
                // credentials, account state or provider readiness is inspected.
                // Only one evaluation is outstanding; the outer timeout also
                // bounds a renderer that never calls its completion callback.
                if window
                    .eval_with_callback(
                        "Boolean(document.getElementById('root')?.firstElementChild)",
                        move |result| {
                            let _ = sender.try_send(result == "true");
                        },
                    )
                    .is_err()
                {
                    return false;
                }
                receiver.recv().await == Some(true)
            },
        )
        .await;
        if crate::account_session::is_restarting() {
            return;
        }
        if mounted {
            record("renderer_mounted");
        } else {
            record("renderer_mount_timeout");
            if RECOVERY.signal(RecoveryState::FAILED) {
                recover_lost_renderer(app);
            }
        }
    });
}

#[cfg(windows)]
fn recover_lost_renderer(app: tauri::AppHandle) {
    // A failure during setup is queued until every worker has been registered.
    // Otherwise teardown could finish before setup starts another worker.
    tauri::async_runtime::spawn(async move {
        if !crate::account_session::close_session(&app).await {
            return;
        }
        record("renderer_recovery");
        // Never show a blocking dialog inside a WebView2 COM callback. The
        // session is closed before asking, so no agent work can continue unseen.
        let result = tauri::async_runtime::spawn_blocking(|| {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Mivlet's window stopped working")
                .set_description(
                    "The window could not start or stopped working. Windows may be short of memory. \
                     Current agent activity has been stopped.\n\nStart Mivlet again?",
                )
                .set_buttons(rfd::MessageButtons::YesNo)
                .show()
        })
        .await;
        if result.is_ok_and(retry_requested) {
            app.request_restart();
        } else {
            app.exit(1);
        }
    });
}

#[cfg(windows)]
fn requires_recovery(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    matches!(
        kind,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
    )
}

pub(crate) fn create_main_window(app: &tauri::App) -> bool {
    record("window_creating");
    #[cfg(windows)]
    let deadline = webview2_com::scoped_wait_deadline(std::time::Duration::from_secs(60));
    let result = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or(tauri::Error::WindowNotFound)
        .and_then(|config| tauri::WebviewWindowBuilder::from_config(app, config))
        .and_then(|builder| {
            builder
                .on_page_load(|_, event| match event.event() {
                    tauri::webview::PageLoadEvent::Started => record("page_started"),
                    tauri::webview::PageLoadEvent::Finished => record("page_finished"),
                })
                .build()
        });
    #[cfg(windows)]
    drop(deadline);
    match result {
        Ok(window) => {
            record("window_created");
            #[cfg(windows)]
            observe_process_failure(&window);
            true
        }
        Err(_) => {
            // Do not print the underlying error: it can contain installation
            // paths. A failure here has not initialized an account or workspace.
            record("window_failed");
            let result = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Mivlet couldn't open its window")
                .set_description(
                    "The window could not start. Windows may be short of memory. \
                     Your workspace has not been opened.\n\nTry starting Mivlet again?",
                )
                .set_buttons(rfd::MessageButtons::YesNo)
                .show();
            if retry_requested(result) {
                // Never reuse a partly initialized WebView or replay account
                // setup. A fresh process repeats the ordinary admission checks.
                app.handle().request_restart();
            } else {
                app.handle().exit(1);
            }
            false
        }
    }
}

#[cfg(windows)]
fn observe_process_failure(window: &tauri::WebviewWindow) {
    use webview2_com::ProcessFailedEventHandler;
    let app = window.app_handle().clone();
    if window
        .with_webview(move |webview| {
            let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
                record("process_observer_unavailable");
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = Default::default();
                    if unsafe { args.ProcessFailedKind(&mut kind) }.is_ok() {
                        eprintln!("[mivlet-startup] process_failed {}", kind.0);
                        if requires_recovery(kind) && RECOVERY.signal(RecoveryState::FAILED) {
                            recover_lost_renderer(app.clone());
                        }
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            if unsafe { core.add_ProcessFailed(&handler, &mut token) }.is_err() {
                record("process_observer_unavailable");
            }
        })
        .is_err()
    {
        record("process_observer_unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mount_probe_retries_until_react_has_rendered() {
        let mut attempts = 0;
        assert!(
            await_renderer_mount(
                std::time::Duration::from_secs(1),
                std::time::Duration::from_millis(1),
                || {
                    attempts += 1;
                    std::future::ready(attempts == 3)
                },
            )
            .await
        );
        assert_eq!(attempts, 3);
    }

    #[tokio::test]
    async fn empty_renderer_is_bounded_without_a_process_failure_event() {
        assert!(
            !await_renderer_mount(
                std::time::Duration::from_millis(10),
                std::time::Duration::from_millis(1),
                || std::future::ready(false),
            )
            .await
        );
    }

    #[tokio::test]
    async fn missing_eval_callback_is_bounded_without_queueing_more_probes() {
        let mut attempts = 0;
        assert!(
            !await_renderer_mount(
                std::time::Duration::from_millis(10),
                std::time::Duration::from_millis(1),
                || {
                    attempts += 1;
                    std::future::pending::<bool>()
                },
            )
            .await
        );
        assert_eq!(attempts, 1);
    }

    #[test]
    fn failure_during_setup_waits_for_registered_workers_and_dispatches_once() {
        let state = RecoveryState::default();
        assert!(!state.signal(RecoveryState::FAILED));
        assert!(!state.signal(RecoveryState::FAILED));
        assert!(state.signal(RecoveryState::READY));
        assert!(!state.signal(RecoveryState::READY));
        assert!(!state.signal(RecoveryState::FAILED));
    }

    #[test]
    fn a_later_failure_also_dispatches_once() {
        let state = RecoveryState::default();
        assert!(!state.signal(RecoveryState::READY));
        assert!(state.signal(RecoveryState::FAILED));
        assert!(!state.signal(RecoveryState::FAILED));
    }

    #[test]
    fn concurrent_setup_and_failures_dispatch_one_recovery() {
        let state = RecoveryState::default();
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16)
                .map(|index| {
                    let state = &state;
                    scope.spawn(move || {
                        state.signal(if index == 0 {
                            RecoveryState::READY
                        } else {
                            RecoveryState::FAILED
                        })
                    })
                })
                .collect();
            assert_eq!(
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .filter(|dispatched| *dispatched)
                    .count(),
                1
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn only_loss_of_the_main_renderer_or_browser_requires_recovery() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        assert!(requires_recovery(
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
        ));
        assert!(requires_recovery(
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        ));
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        ] {
            assert!(!requires_recovery(kind));
        }
    }

    #[test]
    fn recovery_requires_an_explicit_retry_and_dismissal_closes() {
        assert!(retry_requested(rfd::MessageDialogResult::Yes));
        for result in [
            rfd::MessageDialogResult::No,
            rfd::MessageDialogResult::Cancel,
            rfd::MessageDialogResult::Ok,
            rfd::MessageDialogResult::Custom("Yes".into()),
        ] {
            assert!(!retry_requested(result));
        }
    }

    #[test]
    fn main_window_creation_is_owned_by_the_recoverable_startup_path() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["label"], "main");
        assert_eq!(windows[0]["create"], false);
        let entry = include_str!("lib.rs");
        let window = entry.find("if !startup::create_main_window(app)").unwrap();
        let account = entry
            .find("if account_session::initialize(&handle)?")
            .unwrap();
        assert!(window < account);
        assert!(entry[window..account].contains("return Ok(());"));
    }
}
