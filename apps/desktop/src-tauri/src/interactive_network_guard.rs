//! NavigationStarting can cancel a commit after its request has reached a
//! server. Pause document requests before transmission, using Chromium's stable
//! frame identity (including process swaps), then pin interactive resources.
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler,
    DevToolsProtocolEventReceivedEventHandler,
    Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceiver},
};
use windows::core::{HSTRING, PWSTR};

static READY: AtomicBool = AtomicBool::new(false);
static FAILED: AtomicBool = AtomicBool::new(false);
const MAX_FRAMES: usize = 128;
type Frames = HashMap<String, String>;
thread_local! {
    // Retain COM receivers on the main WebView's UI thread for its lifetime.
    static RECEIVERS: RefCell<Vec<ICoreWebView2DevToolsProtocolEventReceiver>> = const { RefCell::new(Vec::new()) };
}

fn allow(frames: &mut Frames, frame: &str, uri: &str, registered: bool) -> bool {
    if let Some(expected) = frames.get(frame) {
        return expected == uri;
    }
    if registered {
        if frames.len() >= MAX_FRAMES {
            return false;
        }
        frames.insert(frame.into(), uri.into());
    }
    true
}
pub(crate) fn require_ready() -> Result<(), String> {
    if READY.load(Ordering::Acquire) && !FAILED.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(
            "The native HTML network guard is unavailable. Reopen Mivlet before using a preview."
                .into(),
        )
    }
}
fn failed() {
    FAILED.store(true, Ordering::Release);
    READY.store(false, Ordering::Release);
}

fn command(
    core: &ICoreWebView2,
    method: &str,
    params: Value,
    enabling: bool,
) -> windows::core::Result<()> {
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, _result| {
            if status.is_err() {
                failed();
            } else if enabling {
                READY.store(true, Ordering::Release);
            }
            Ok(())
        }));
    unsafe {
        core.CallDevToolsProtocolMethod(
            &HSTRING::from(method),
            &HSTRING::from(params.to_string()),
            &callback,
        )
    }
}

pub(crate) fn install(core: &ICoreWebView2) -> windows::core::Result<()> {
    let frames = Arc::new(Mutex::new(Frames::new()));
    let requests = frames.clone();
    let handler_core = core.clone();
    let requests_handler =
        DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                failed();
                return Ok(());
            };
            let mut raw = PWSTR::null();
            unsafe {
                args.ParameterObjectAsJson(&mut raw)?;
            }
            // No request headers, credentials or URLs are published to the renderer
            // or diagnostics. The native decision retains only a frame's issued URL.
            let value: Value = match serde_json::from_str(&take_pwstr(raw)) {
                Ok(value) => value,
                Err(_) => {
                    failed();
                    return Ok(());
                }
            };
            let Some(request) = value["requestId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 256)
            else {
                failed();
                return Ok(());
            };
            let permitted = match (value["frameId"].as_str(), value["request"]["url"].as_str()) {
                (Some(frame), Some(uri)) if frame.len() <= 256 && uri.len() <= 32768 => {
                    match requests.lock() {
                        Ok(mut frames) => allow(
                            &mut frames,
                            frame,
                            uri,
                            crate::mcp_app_host::is_registered_mcp_url(uri),
                        ),
                        Err(_) => false,
                    }
                }
                _ => false,
            };
            let method = if permitted {
                "Fetch.continueRequest"
            } else {
                "Fetch.failRequest"
            };
            let params = if permitted {
                json!({"requestId":request})
            } else {
                json!({"requestId":request,"errorReason":"BlockedByClient"})
            };
            if command(&handler_core, method, params, false).is_err() {
                failed();
            }
            Ok(())
        }));
    let receiver =
        unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Fetch.requestPaused"))? };
    let mut request_token = 0;
    unsafe {
        receiver.add_DevToolsProtocolEventReceived(&requests_handler, &mut request_token)?;
    }
    RECEIVERS.with(|receivers| receivers.borrow_mut().push(receiver));

    let detached =
        DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                let mut raw = PWSTR::null();
                unsafe {
                    args.ParameterObjectAsJson(&mut raw)?;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&take_pwstr(raw)) {
                    // Process swaps retain the same frame and its fence.
                    if value["reason"] == "remove" {
                        if let Some(frame) = value["frameId"].as_str() {
                            if let Ok(mut frames) = frames.lock() {
                                frames.remove(frame);
                            }
                        }
                    }
                }
            }
            Ok(())
        }));
    let receiver =
        unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Page.frameDetached"))? };
    let mut detached_token = 0;
    unsafe {
        receiver.add_DevToolsProtocolEventReceived(&detached, &mut detached_token)?;
    }
    RECEIVERS.with(|receivers| receivers.borrow_mut().push(receiver));
    command(core, "Page.enable", json!({}), false)?;
    command(
        core,
        "Fetch.enable",
        json!({"patterns":[{"urlPattern":"*","resourceType":"Document","requestStage":"Request"}]}),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pins_resources_before_the_first_request_and_keeps_process_swap_identity() {
        let mut frames = Frames::new();
        let issued = "http://127.0.0.2:1234/token/index.html";
        assert!(allow(&mut frames, "guest", issued, true));
        for uri in [
            "https://example.com/?answer=private",
            "http://127.0.0.1:1420/",
            "http://ipc.localhost/",
            "data:text/html,other",
            "http://127.0.0.2:1234/token/index.html?other",
        ] {
            assert!(!allow(&mut frames, "guest", uri, false));
        }
        assert!(allow(&mut frames, "guest", issued, true));
        assert!(allow(
            &mut frames,
            "ordinary-preview",
            "https://example.com",
            false
        ));
    }
    #[test]
    fn bounds_frame_retention_without_relaxing_existing_fences() {
        let mut frames = (0..MAX_FRAMES)
            .map(|n| (n.to_string(), "issued".into()))
            .collect();
        assert!(!allow(&mut frames, "new", "issued", true));
        assert!(!allow(&mut frames, "0", "other", false));
        assert!(allow(&mut frames, "0", "issued", false));
    }
}
