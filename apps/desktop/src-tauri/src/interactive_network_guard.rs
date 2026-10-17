//! Block interactive document requests before transmission, including OOPIF sessions.
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
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceivedEventArgs2,
        ICoreWebView2DevToolsProtocolEventReceiver, ICoreWebView2_11,
    },
};
use windows::core::{Interface, HSTRING, PWSTR};
static READY: AtomicBool = AtomicBool::new(false);
static FAILED: AtomicBool = AtomicBool::new(false);
const MAX_FRAMES: usize = 128;
type Frames = HashMap<String, String>;
#[derive(Default)]
struct Fence {
    frames: Frames,
    sessions: Frames,
}
thread_local! {
    // COM receivers remain on the main WebView UI thread for its lifetime.
    static RECEIVERS: RefCell<Vec<ICoreWebView2DevToolsProtocolEventReceiver>> = const { RefCell::new(Vec::new()) };
}
fn allow(frames: &mut Frames, frame: &str, uri: &str, registered: bool) -> bool {
    if let Some(expected) = frames.get(frame) {
        return crate::local_computer::live_preview::navigation_allowed(expected, uri)
            .unwrap_or_else(|| expected == uri);
    }
    if crate::local_computer::live_preview::navigation_allowed(uri, uri) == Some(false) {
        return false;
    }
    if registered {
        if frames.len() >= MAX_FRAMES {
            return false;
        }
        frames.insert(frame.into(), uri.into());
    }
    true
}
impl Fence {
    fn allow(&mut self, session: &str, frame: &str, uri: &str, registered: bool) -> bool {
        if self.sessions.get(session).is_some_and(|expected| {
            !crate::local_computer::live_preview::navigation_allowed(expected, uri)
                .unwrap_or_else(|| expected == uri)
        }) {
            return false;
        }
        let allowed = allow(&mut self.frames, frame, uri, registered);
        if allowed && registered && !session.is_empty() {
            if self.sessions.len() >= MAX_FRAMES && !self.sessions.contains_key(session) {
                return false;
            }
            self.sessions.insert(session.into(), uri.into());
        }
        allowed
    }
    fn bind(&mut self, session: &str, target: &str, uri: &str, registered: bool) -> bool {
        let expected = if registered {
            Some(uri.to_owned())
        } else {
            self.frames.get(target).cloned()
        };
        if let Some(expected) = expected {
            if self.sessions.len() >= MAX_FRAMES {
                return false;
            }
            self.sessions.insert(session.into(), expected);
        }
        true
    }
}
fn failed() {
    FAILED.store(true, Ordering::Release);
    READY.store(false, Ordering::Release);
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
fn command(
    core: &ICoreWebView2,
    session: &str,
    method: &str,
    params: Value,
) -> windows::core::Result<()> {
    let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|status, _| {
        if status.is_err() {
            failed();
        }
        Ok(())
    }));
    unsafe {
        if session.is_empty() {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(params.to_string()),
                &callback,
            )
        } else {
            core.cast::<ICoreWebView2_11>()?
                .CallDevToolsProtocolMethodForSession(
                    &HSTRING::from(session),
                    &HSTRING::from(method),
                    &HSTRING::from(params.to_string()),
                    &callback,
                )
        }
    }
}
fn enable(core: &ICoreWebView2, session: &str) -> windows::core::Result<()> {
    command(core, session, "Page.enable", json!({}))?;
    command(
        core,
        session,
        "Target.setAutoAttach",
        json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,"filter":[{"type":"iframe","exclude":false},{"exclude":true}]}),
    )?;
    let ready_core = core.clone();
    let ready_session = session.to_owned();
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, _| {
            if status.is_err() {
                failed();
            } else if ready_session.is_empty() {
                READY.store(true, Ordering::Release);
            } else if command(
                &ready_core,
                &ready_session,
                "Runtime.runIfWaitingForDebugger",
                json!({}),
            )
            .is_err()
            {
                failed();
            }
            Ok(())
        }));
    let params = HSTRING::from(
        json!({"patterns":[{"urlPattern":"*","resourceType":"Document","requestStage":"Request"}]})
            .to_string(),
    );
    unsafe {
        if session.is_empty() {
            core.CallDevToolsProtocolMethod(&HSTRING::from("Fetch.enable"), &params, &callback)
        } else {
            core.cast::<ICoreWebView2_11>()?
                .CallDevToolsProtocolMethodForSession(
                    &HSTRING::from(session),
                    &HSTRING::from("Fetch.enable"),
                    &params,
                    &callback,
                )
        }
    }
}
fn subscribe(
    core: &ICoreWebView2,
    event: &str,
    handler: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventHandler,
) -> windows::core::Result<()> {
    let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))? };
    let mut token = 0;
    unsafe {
        receiver.add_DevToolsProtocolEventReceived(handler, &mut token)?;
    }
    RECEIVERS.with(|receivers| receivers.borrow_mut().push(receiver));
    Ok(())
}
pub(crate) fn install(core: &ICoreWebView2) -> windows::core::Result<()> {
    let _: ICoreWebView2_11 = core.cast()?;
    let fence = Arc::new(Mutex::new(Fence::default()));
    let requests = fence.clone();
    let handler_core = core.clone();
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            failed();
            return Ok(());
        };
        let mut raw = PWSTR::null();
        unsafe {
            args.ParameterObjectAsJson(&mut raw)?;
        }
        // Request headers, credentials and URLs never enter renderer state or logs.
        let Ok(value) = serde_json::from_str::<Value>(&take_pwstr(raw)) else {
            failed();
            return Ok(());
        };
        let args2: ICoreWebView2DevToolsProtocolEventReceivedEventArgs2 = args.cast()?;
        let mut session = PWSTR::null();
        unsafe {
            args2.SessionId(&mut session)?;
        }
        let session = take_pwstr(session);
        let Some(request) = value["requestId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            failed();
            return Ok(());
        };
        let allowed = match (value["frameId"].as_str(), value["request"]["url"].as_str()) {
            (Some(frame), Some(uri)) if frame.len() <= 256 && uri.len() <= 32768 => requests
                .lock()
                .map(|mut fence| {
                    fence.allow(
                        &session,
                        frame,
                        uri,
                        crate::mcp_app_host::is_registered_mcp_url(uri)
                            || crate::local_computer::live_preview::registered_origin(uri)
                                .is_some(),
                    )
                })
                .unwrap_or(false),
            _ => false,
        };
        let (method, params) = if allowed {
            ("Fetch.continueRequest", json!({"requestId":request}))
        } else {
            (
                "Fetch.failRequest",
                json!({"requestId":request,"errorReason":"BlockedByClient"}),
            )
        };
        if command(&handler_core, &session, method, params).is_err() {
            failed();
        }
        Ok(())
    }));
    subscribe(core, "Fetch.requestPaused", &handler)?;
    let targets = fence.clone();
    let target_core = core.clone();
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            failed();
            return Ok(());
        };
        let mut raw = PWSTR::null();
        unsafe {
            args.ParameterObjectAsJson(&mut raw)?;
        }
        let Ok(value) = serde_json::from_str::<Value>(&take_pwstr(raw)) else {
            failed();
            return Ok(());
        };
        let Some(session) = value["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            failed();
            return Ok(());
        };
        let uri = value["targetInfo"]["url"].as_str().unwrap_or_default();
        let target = value["targetInfo"]["targetId"].as_str().unwrap_or_default();
        if !targets
            .lock()
            .map(|mut fence| {
                fence.bind(
                    session,
                    target,
                    uri,
                    crate::mcp_app_host::is_registered_mcp_url(uri)
                        || crate::local_computer::live_preview::registered_origin(uri).is_some(),
                )
            })
            .unwrap_or(false)
        {
            failed();
            return Ok(());
        }
        // Child targets start paused. Their Fetch domain is enabled before any
        // guest JavaScript resumes, including further out-of-process descendants.
        if enable(&target_core, session).is_err() {
            failed();
        }
        Ok(())
    }));
    subscribe(core, "Target.attachedToTarget", &handler)?;
    for event in ["Page.frameDetached", "Target.detachedFromTarget"] {
        let removed = fence.clone();
        let is_session = event.starts_with("Target.");
        let handler =
            DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut raw = PWSTR::null();
                    unsafe {
                        args.ParameterObjectAsJson(&mut raw)?;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&take_pwstr(raw)) {
                        if let Ok(mut fence) = removed.lock() {
                            if is_session {
                                if let Some(session) = value["sessionId"].as_str() {
                                    fence.sessions.remove(session);
                                }
                            }
                            // A process swap must retain the frame's issued URL.
                            else if value["reason"] == "remove" {
                                if let Some(frame) = value["frameId"].as_str() {
                                    fence.frames.remove(frame);
                                }
                            }
                        }
                    }
                }
                Ok(())
            }));
        subscribe(core, event, &handler)?;
    }
    enable(core, "")
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
    #[test]
    fn child_renderer_sessions_inherit_the_pin_and_cannot_escape_by_changing_frame() {
        let mut fence = Fence::default();
        let issued = "http://127.0.0.2:1234/token/index.html";
        assert!(fence.allow("", "frame", issued, true));
        assert!(fence.bind("child", "frame", "", false));
        assert!(!fence.allow("child", "different-frame", "https://example.com", false));
        assert!(fence.allow("child", "different-frame", issued, true));
        assert!(fence.allow("ordinary", "normal", "https://example.com", false));
    }
    #[test]
    fn expired_native_preview_origin_cannot_be_reintroduced_as_an_ordinary_frame() {
        let issued = "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:41234/";
        let mut frames = Frames::new();
        assert!(!allow(&mut frames, "new-preview", issued, false));
        frames.insert("retained".into(), issued.into());
        assert!(!allow(&mut frames, "retained", issued, false));
        assert!(!allow(
            &mut frames,
            "retained",
            "http://127.0.0.1:1420/",
            false
        ));
    }
}
