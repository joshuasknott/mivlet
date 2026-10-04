//! Fresh document-bound navigation, without script evaluation or DOM input.
use super::{
    observations::{self, Frame},
    pipes::Command,
    BrowserProcess,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const STALE: &str = "The browser navigation choice expired or its document changed. List its tabs again before choosing a new action.";
const UNKNOWN: &str = "Browser navigation was not confirmed. It may have changed the page or started a browser-managed download. No input was replayed and no Mivlet artifact was imported; start a fresh request and inspect the current state.";

pub(super) struct Choice {
    hwnd: u64,
    generation: u64,
    window: u64,
    created: Instant,
    target: String,
    session: String,
    frame: Frame,
    pub(super) origin: String,
}
impl Choice {
    pub(super) fn capture(
        hwnd: u64,
        generation: u64,
        window: u64,
        target: &str,
        session: &str,
        listed_url: &str,
        value: &Value,
    ) -> Result<Self, String> {
        let origin = source_origin(listed_url)?;
        let frame = source_frame(value, &origin)?;
        if frame.url != listed_url {
            return Err(STALE.into());
        }
        Ok(Self {
            hwnd,
            generation,
            window,
            created: Instant::now(),
            target: target.into(),
            session: session.into(),
            frame,
            origin,
        })
    }
    fn check(
        &self,
        hwnd: u64,
        generation: u64,
        origin: &str,
        window: u64,
        current: &Value,
    ) -> Result<(), String> {
        if self.hwnd != hwnd
            || self.generation != generation
            || self.window != window
            || self.origin != origin
            || self.created.elapsed() >= Duration::from_secs(30)
            || self.frame != source_frame(current, origin)?
        {
            return Err(STALE.into());
        }
        Ok(())
    }
}
fn source_origin(value: &str) -> Result<String, String> {
    if value == "about:blank" {
        return Ok(value.into());
    }
    observations::url_origin(value).ok_or(
        "Browser navigation requires an HTTP(S) page or the private initial about:blank tab."
            .into(),
    )
}
fn source_frame(value: &Value, origin: &str) -> Result<Frame, String> {
    if origin == "about:blank" {
        let frame = observations::document(value)?;
        if frame.url != "about:blank"
            || !matches!(
                value["frameTree"]["frame"]["securityOrigin"].as_str(),
                Some("://" | "null")
            )
        {
            return Err(STALE.into());
        }
        Ok(frame)
    } else {
        observations::frame(value, origin)
    }
}
fn destination(value: &str) -> Result<url::Url, String> {
    if value.len() > 2048 || observations::url_origin(value).is_none() {
        return Err("Browser navigation requires a bounded HTTP(S) URL without credentials or control characters.".into());
    }
    url::Url::parse(value).map_err(|_| "The browser destination URL is invalid.".into())
}

pub(super) fn navigate(
    process: &mut BrowserProcess,
    hwnd: u64,
    generation: u64,
    reference: &str,
    origin: &str,
    url: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    let destination = destination(url)?;
    if source_origin(origin)? != origin {
        return Err("Use the exact origin from the current tab list.".into());
    }
    let choice = process.navigation.remove(reference).ok_or(STALE)?;
    // Clear every older tab/action choice before checking or sending input.
    process.tabs = None;
    process.navigation.clear();
    process.controls.clear();
    let (window, pages) = observations::targets(process, hwnd, check)?;
    let page = pages
        .iter()
        .find(|page| page["targetId"] == choice.target)
        .ok_or(STALE)?;
    if page["url"].as_str() != Some(&choice.frame.url) {
        return Err(STALE.into());
    }
    let current = observations::call(
        process,
        Command::Frames,
        json!({}),
        Some(&choice.session),
        check,
    )?;
    choice.check(hwnd, generation, origin, window, &current)?;
    check()?;
    let result = process._pipe.as_mut().ok_or("The browser's native connection is unavailable.")?.navigate(
        json!({"url":destination.as_str(), "frameId":choice.frame.id, "referrerPolicy":"noReferrer"}), &choice.session, check, dispatch
    ).map_err(|_| UNKNOWN)?;
    if result["errorText"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
        || result["isDownload"].as_bool() == Some(true)
        || result["frameId"] != choice.frame.id
    {
        return Err(UNKNOWN.into());
    }
    check().map_err(|_| UNKNOWN)?;
    Ok(json!({"status":"navigation-dispatched","inputDispatched":true,"verified":false,"destinationOrigin":destination.origin().ascii_serialization(),"requiresObservation":true,"message":"List current tabs and observe the destination to verify the result. A dispatched request does not prove that the page loaded. No browser input was replayed and no file was imported."}).to_string())
}

#[cfg(test)]
#[path = "navigation_tests.rs"]
mod tests;
