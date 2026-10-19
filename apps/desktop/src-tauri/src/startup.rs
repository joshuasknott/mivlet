//! Recover a failed native window before opening any account or starting workers.
//! The renderer configuration and all normal account admission checks are retained.

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
    if window
        .with_webview(|webview| {
            let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
                record("process_observer_unavailable");
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut kind = Default::default();
                    if unsafe { args.ProcessFailedKind(&mut kind) }.is_ok() {
                        eprintln!("[mivlet-startup] process_failed {}", kind.0);
                    }
                }
                // An existing workspace may own in-flight effects. Never reload it
                // or restart an agent automatically in response to renderer failure.
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
