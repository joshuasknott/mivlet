//! One observed, document-bound click. No selector, script or coordinate comes
//! from an agent; layout and hit identity are resolved again immediately before input.
use super::{
    observations::{self, Frame},
    pipes::Command,
    BrowserProcess,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const STALE: &str = "The browser control is stale or changed. List tabs and observe again before choosing a new action. No browser input was dispatched.";
const UNKNOWN: &str = "Browser click outcome is uncertain. It may have changed the page, submitted data or started a browser-managed download. No input was replayed and no Mivlet artifact was imported. Observe the current state before choosing another action.";
const SOLE: &str = "Browser clicks require the sole tab in the selected foreground owned window. Close extra tabs and observe again; no browser input was dispatched.";

#[derive(Clone, PartialEq, Eq)]
struct Control {
    backend: u64,
    role: String,
    name: String,
    metadata: Value,
}
pub(super) struct Choice {
    hwnd: u64,
    generation: u64,
    window: u64,
    created: Instant,
    target: String,
    session: String,
    frame: Frame,
    origin: String,
    control: Control,
}
impl Choice {
    fn check(
        &self,
        hwnd: u64,
        generation: u64,
        window: u64,
        origin: &str,
        name: &str,
        frame: &Frame,
    ) -> Result<(), String> {
        if self.hwnd != hwnd
            || self.generation != generation
            || self.window != window
            || self.origin != origin
            || self.control.name != name
            || self.frame != *frame
            || self.created.elapsed() >= Duration::from_secs(30)
        {
            return Err(STALE.into());
        }
        Ok(())
    }
}

fn candidate(node: &Value) -> Option<(u64, String, String)> {
    let role = node["role"]["value"].as_str()?;
    let name = node["name"]["value"].as_str()?;
    let disabled = node["properties"].as_array().is_some_and(|props| {
        props
            .iter()
            .any(|prop| prop["name"] == "disabled" && prop["value"]["value"] == true)
    });
    if node["ignored"] != false
        || !matches!(role, "button" | "link")
        || disabled
        || name.trim().is_empty()
        || name.chars().count() > 200
        || name.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(name)
    {
        return None;
    }
    let backend = node["backendDOMNodeId"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= u32::MAX.into())?;
    Some((backend, role.into(), name.into()))
}

fn metadata(node: &Value, role: &str, page_url: &str) -> Option<Value> {
    if node["nodeType"] != 1 {
        return None;
    }
    let tag = node["nodeName"].as_str()?;
    if !matches!((role, tag), ("button", "BUTTON") | ("link", "A")) {
        return None;
    }
    let attributes = node["attributes"].as_array()?;
    if attributes.len() > 512 || attributes.len() % 2 != 0 {
        return None;
    }
    let mut bytes = 0;
    let mut href = None;
    for pair in attributes.as_chunks::<2>().0 {
        let key = pair[0].as_str()?;
        let value = pair[1].as_str()?;
        bytes += key.len() + value.len();
        if bytes > 16000
            || matches!(
                key.to_ascii_lowercase().as_str(),
                "disabled" | "hidden" | "download" | "contenteditable"
            )
        {
            return None;
        }
        if key.eq_ignore_ascii_case("href") {
            href = Some(value);
        }
    }
    if role == "link" {
        let destination = url::Url::parse(page_url).ok()?.join(href?).ok()?;
        observations::url_origin(destination.as_str())?;
    }
    // Native-only fingerprint. Attribute strings, handlers and hrefs are never
    // returned as instructions or evaluated by Mivlet.
    Some(json!({"tag":tag,"attributes":attributes}))
}

pub(super) fn capture(
    process: &mut BrowserProcess,
    scope: (u64, u64, u64),
    target: &str,
    session: &str,
    frame: &Frame,
    origin: &str,
    nodes: &[Value],
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(Vec<Value>, HashMap<String, Choice>), String> {
    let mut display = Vec::new();
    let mut choices = HashMap::new();
    let mut inspected = 0;
    for index in observations::reachable(nodes, &frame.id, false)? {
        if inspected >= 32 {
            break;
        }
        let Some((backend, role, name)) = candidate(&nodes[index]) else {
            continue;
        };
        inspected += 1;
        let described = observations::call(
            process,
            Command::DescribeNode,
            json!({"backendNodeId":backend,"depth":0,"pierce":false}),
            Some(session),
            check,
        )?;
        if described["node"]["backendNodeId"].as_u64() != Some(backend) {
            return Err(STALE.into());
        }
        let Some(metadata) = metadata(&described["node"], &role, &frame.url) else {
            continue;
        };
        let reference = super::super::super::desktop_tools::opaque_id()?;
        display.push(json!({"controlRef":reference,"role":role,"name":name}));
        choices.insert(
            reference,
            Choice {
                hwnd: scope.0,
                generation: scope.1,
                window: scope.2,
                created: Instant::now(),
                target: target.into(),
                session: session.into(),
                frame: frame.clone(),
                origin: origin.into(),
                control: Control {
                    backend,
                    role,
                    name,
                    metadata,
                },
            },
        );
    }
    Ok((display, choices))
}

fn point(quads: &Value, metrics: &Value) -> Result<(i32, i32), String> {
    let quads = quads["quads"]
        .as_array()
        .filter(|quads| quads.len() == 1)
        .ok_or(STALE)?;
    let quad = quads[0]
        .as_array()
        .filter(|quad| quad.len() == 8)
        .ok_or(STALE)?;
    let values: Vec<f64> = quad
        .iter()
        .map(|n| {
            n.as_f64()
                .filter(|n| n.is_finite() && n.abs() <= 10000.0)
                .ok_or(STALE)
        })
        .collect::<Result<_, _>>()?;
    let viewport = &metrics["cssVisualViewport"];
    let width = viewport["clientWidth"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 10000.0)
        .ok_or(STALE)?;
    let height = viewport["clientHeight"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 10000.0)
        .ok_or(STALE)?;
    if viewport["scale"].as_f64() != Some(1.0)
        || viewport["offsetX"].as_f64() != Some(0.0)
        || viewport["offsetY"].as_f64() != Some(0.0)
        || values[0] != values[6]
        || values[1] != values[3]
        || values[2] != values[4]
        || values[5] != values[7]
        || values[0] < 0.0
        || values[1] < 0.0
        || values[2] > width
        || values[5] > height
        || values[2] - values[0] < 4.0
        || values[5] - values[1] < 4.0
    {
        return Err(STALE.into());
    }
    Ok((
        ((values[0] + values[2]) / 2.0).round() as i32,
        ((values[1] + values[5]) / 2.0).round() as i32,
    ))
}

pub(super) fn click(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    reference: &str,
    origin: &str,
    name: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    let choice = process.controls.remove(reference).ok_or(STALE)?;
    process.controls.clear();
    process.navigation.clear();
    process.tabs = None;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if pages.len() != 1 {
        return Err(SOLE.into());
    }
    if pages[0]["targetId"] != choice.target || pages[0]["url"].as_str() != Some(&choice.frame.url)
    {
        return Err(STALE.into());
    }
    let current = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    choice.check(scope.0, scope.1, window, origin, name, &current)?;
    let (nodes, _) = observations::checked_tree(process, &choice.session, &current, check)?;
    if !observations::reachable(&nodes, &current.id, false)?
        .iter()
        .any(|index| {
            candidate(&nodes[*index])
                == Some((
                    choice.control.backend,
                    choice.control.role.clone(),
                    choice.control.name.clone(),
                ))
        })
    {
        return Err(STALE.into());
    }
    let described = observations::call(
        process,
        Command::DescribeNode,
        json!({"backendNodeId":choice.control.backend,"depth":0,"pierce":false}),
        Some(&choice.session),
        check,
    )?;
    if described["node"]["backendNodeId"].as_u64() != Some(choice.control.backend)
        || metadata(&described["node"], &choice.control.role, &current.url).as_ref()
            != Some(&choice.control.metadata)
    {
        return Err(STALE.into());
    }
    let quads = observations::call(
        process,
        Command::Quads,
        json!({"backendNodeId":choice.control.backend}),
        Some(&choice.session),
        check,
    )?;
    let metrics = observations::call(
        process,
        Command::Layout,
        json!({}),
        Some(&choice.session),
        check,
    )?;
    let (x, y) = point(&quads, &metrics)?;
    let hit = observations::call(
        process,
        Command::Hit,
        json!({"x":x,"y":y,"includeUserAgentShadowDOM":false,"ignorePointerEventsNone":false}),
        Some(&choice.session),
        check,
    )?;
    if hit["frameId"] != current.id || hit["backendNodeId"].as_u64() != Some(choice.control.backend)
    {
        return Err(STALE.into());
    }
    let after = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    choice.check(scope.0, scope.1, window, origin, name, &after)?;
    let (last_window, last_pages) = observations::targets(process, scope.0, check)?;
    if last_pages.len() != 1
        || last_window != window
        || last_pages[0]["targetId"] != choice.target
        || last_pages[0]["url"].as_str() != Some(&after.url)
    {
        return Err(STALE.into());
    }
    check()?;
    // One complete, fixed mouse gesture in one bounded fenced write. No separate
    // down/up writes, focus change, scroll, caller coordinates or replay.
    process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .click(
            json!({"x":x,"y":y,"duration":0,"tapCount":1,"gestureSourceType":"mouse"}),
            &choice.session,
            check,
            dispatch,
        )
        .map_err(|_| UNKNOWN)?;
    check().map_err(|_| UNKNOWN)?;
    Ok(json!({"status":"click-dispatched","inputDispatched":true,"verified":false,"requiresObservation":true,"message":"Observe the current page to verify this click. No input was replayed and no file was imported."}).to_string())
}

#[cfg(test)]
#[path = "controls_tests.rs"]
mod tests;
