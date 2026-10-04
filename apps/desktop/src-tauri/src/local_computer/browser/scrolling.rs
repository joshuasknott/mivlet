//! One bounded wheel event at an observed public part of the visible page.
use super::{
    observations::{self, Frame},
    pipes::Command,
    BrowserProcess,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

const STALE: &str = "The browser scroll control is stale or changed. List tabs and observe again. No browser input was dispatched.";
const HIDDEN: &str = "The observed browser tab is no longer visible. Select it yourself and observe again; no browser input was dispatched.";
const UNKNOWN: &str = "Browser scroll outcome is uncertain. No input was replayed. Observe the current page before choosing another action.";

#[derive(Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Viewport {
    width: f64,
    height: f64,
    page_x: f64,
    page_y: f64,
}
impl Viewport {
    fn read(value: &Value) -> Option<Self> {
        let v = &value["cssVisualViewport"];
        let number = |key: &str, min: f64, max: f64| {
            v[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= min && *n <= max)
        };
        if v["scale"].as_f64() != Some(1.0)
            || v["offsetX"].as_f64() != Some(0.0)
            || v["offsetY"].as_f64() != Some(0.0)
            || v.get("zoom").is_some_and(|zoom| zoom.as_f64() != Some(1.0))
        {
            return None;
        }
        Some(Self {
            width: number("clientWidth", 100.0, 10000.0)?,
            height: number("clientHeight", 100.0, 10000.0)?,
            page_x: number("pageX", 0.0, 10_000_000.0)?,
            page_y: number("pageY", 0.0, 10_000_000.0)?,
        })
    }
    fn point(&self) -> (i32, i32) {
        (
            (self.width / 2.0).floor() as i32,
            (self.height / 2.0).floor() as i32,
        )
    }
    fn wheel(&self, direction: &str) -> Result<Value, String> {
        let sign = match direction {
            "up" => -1.0,
            "down" => 1.0,
            _ => {
                return Err(
                    "Invalid browser scroll direction. No browser input was dispatched.".into(),
                )
            }
        };
        let (x, y) = self.point();
        Ok(
            json!({"type":"mouseWheel","x":x,"y":y,"deltaX":0,"deltaY":sign * (self.height * 0.8).floor().min(600.0),"modifiers":0,"buttons":0,"button":"none","pointerType":"mouse"}),
        )
    }
}

pub(super) struct Choice {
    scope: (u64, u64, u64),
    created: Instant,
    target: String,
    session: String,
    frame: Frame,
    origin: String,
    viewport: Viewport,
    hit: (u64, Value),
}
impl Choice {
    fn check(
        &self,
        scope: (u64, u64, u64),
        origin: &str,
        frame: &Frame,
        viewport: &Viewport,
    ) -> Result<(), String> {
        if self.scope != scope
            || self.origin != origin
            || self.frame != *frame
            || self.viewport != *viewport
            || self.created.elapsed() >= Duration::from_secs(30)
        {
            return Err(STALE.into());
        }
        Ok(())
    }
}

// An editable ancestor, widget or subframe must never receive the wheel event.
// Page wheel handlers remain possible side effects of this approved input.
fn public_hit(nodes: &[Value], frame: &str, backend: u64) -> Result<bool, String> {
    let reachable = observations::reachable(nodes, frame, false)?;
    let indexed: HashMap<_, _> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| n["nodeId"].as_str().map(|id| (id, i)))
        .collect();
    let Some(mut index) = reachable
        .into_iter()
        .find(|i| nodes[*i]["backendDOMNodeId"].as_u64() == Some(backend))
    else {
        return Ok(false);
    };
    let mut seen = HashSet::new();
    while seen.insert(index) && seen.len() <= 32 {
        let node = &nodes[index];
        if !matches!(
            node["role"]["value"].as_str(),
            Some(
                "RootWebArea"
                    | "none"
                    | "generic"
                    | "paragraph"
                    | "StaticText"
                    | "InlineTextBox"
                    | "heading"
                    | "main"
                    | "article"
                    | "section"
                    | "list"
                    | "listitem"
                    | "table"
                    | "rowgroup"
                    | "row"
                    | "cell"
                    | "columnheader"
                    | "rowheader"
                    | "banner"
                    | "contentinfo"
                    | "navigation"
                    | "complementary"
            )
        ) || node["properties"].as_array().is_some_and(|props| {
            props.iter().any(|p| {
                p["name"] == "editable"
                    && p["value"]["value"] != false
                    && p["value"]["value"] != "false"
            })
        }) {
            return Ok(false);
        }
        if node["role"]["value"] == "RootWebArea" {
            return Ok(node["frameId"] == frame);
        }
        let Some(parent) = node["parentId"]
            .as_str()
            .and_then(|id| indexed.get(id))
            .copied()
        else {
            return Ok(false);
        };
        if !nodes[parent]["childIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&node["nodeId"]))
        {
            return Ok(false);
        }
        index = parent;
    }
    Ok(false)
}
fn metadata(node: &Value) -> Option<Value> {
    if node["nodeType"] != 1
        || !matches!(
            node["nodeName"].as_str(),
            Some(
                "HTML"
                    | "BODY"
                    | "DIV"
                    | "SPAN"
                    | "P"
                    | "MAIN"
                    | "SECTION"
                    | "ARTICLE"
                    | "UL"
                    | "OL"
                    | "LI"
                    | "TABLE"
                    | "TBODY"
                    | "THEAD"
                    | "TFOOT"
                    | "TR"
                    | "TD"
                    | "TH"
                    | "H1"
                    | "H2"
                    | "H3"
                    | "H4"
                    | "H5"
                    | "H6"
                    | "HEADER"
                    | "FOOTER"
                    | "NAV"
                    | "ASIDE"
            )
        )
    {
        return None;
    }
    let attributes = node["attributes"].as_array()?;
    if attributes.len() > 512 || attributes.len() % 2 != 0 {
        return None;
    }
    let mut bytes = 0;
    for pair in attributes.as_chunks::<2>().0 {
        let key = pair[0].as_str()?.to_ascii_lowercase();
        let value = pair[1].as_str()?;
        bytes += key.len() + value.len();
        if bytes > 16000
            || matches!(key.as_str(), "hidden" | "inert")
            || (key == "contenteditable" && value != "false")
        {
            return None;
        }
    }
    Some(json!({"tag":node["nodeName"],"attributes":attributes}))
}
fn hit(
    process: &mut BrowserProcess,
    session: &str,
    frame: &Frame,
    viewport: &Viewport,
    nodes: &[Value],
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Option<(u64, Value)>, String> {
    let (x, y) = viewport.point();
    let (hit_x, hit_y) = observations::document_point((x, y), (viewport.page_x, viewport.page_y))?;
    let hit = observations::call(
        process,
        Command::Hit,
        json!({"x":hit_x,"y":hit_y,"includeUserAgentShadowDOM":false,"ignorePointerEventsNone":false}),
        Some(session),
        check,
    )?;
    let Some(backend) = hit["backendNodeId"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX.into())
    else {
        return Ok(None);
    };
    if hit["frameId"] != frame.id || !public_hit(nodes, &frame.id, backend)? {
        return Ok(None);
    }
    let described = observations::call(
        process,
        Command::DescribeNode,
        json!({"backendNodeId":backend,"depth":0,"pierce":false}),
        Some(session),
        check,
    )?;
    if described["node"]["backendNodeId"].as_u64() != Some(backend) {
        return Ok(None);
    }
    Ok(metadata(&described["node"]).map(|metadata| (backend, metadata)))
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
) -> Result<(Value, Option<(String, Choice)>), String> {
    let layout = observations::call(process, Command::Layout, json!({}), Some(session), check)?;
    let Some(viewport) = Viewport::read(&layout) else {
        return Ok((Value::Null, None));
    };
    let display = serde_json::to_value(&viewport).map_err(|_| STALE)?;
    let Some(hit) = hit(process, session, frame, &viewport, nodes, check)? else {
        return Ok((display, None));
    };
    let reference = super::super::super::desktop_tools::opaque_id()?;
    Ok((
        display,
        Some((
            reference,
            Choice {
                scope,
                created: Instant::now(),
                target: target.into(),
                session: session.into(),
                frame: frame.clone(),
                origin: origin.into(),
                viewport,
                hit,
            },
        )),
    ))
}

pub(super) fn scroll(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    reference: &str,
    origin: &str,
    direction: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    let (native_ref, choice) = process.scroll.take().ok_or(STALE)?;
    process.controls.clear();
    process.navigation.clear();
    process.tabs = None;
    if native_ref != reference {
        return Err(STALE.into());
    }
    let params = choice.viewport.wheel(direction)?;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if !pages
        .iter()
        .any(|p| p["targetId"] == choice.target && p["url"].as_str() == Some(&choice.frame.url))
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
    let viewport = Viewport::read(&observations::call(
        process,
        Command::Layout,
        json!({}),
        Some(&choice.session),
        check,
    )?)
    .ok_or(STALE)?;
    choice.check((scope.0, scope.1, window), origin, &current, &viewport)?;
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&current.id, &choice.session, check)?
    {
        return Err(HIDDEN.into());
    }
    let (nodes, _) = observations::checked_tree(process, &choice.session, &current, check)?;
    if hit(process, &choice.session, &current, &viewport, &nodes, check)?.as_ref()
        != Some(&choice.hit)
    {
        return Err(STALE.into());
    }
    let (last_window, last_pages) = observations::targets(process, scope.0, check)?;
    if last_window != window
        || !last_pages
            .iter()
            .any(|p| p["targetId"] == choice.target && p["url"].as_str() == Some(&current.url))
    {
        return Err(STALE.into());
    }
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&current.id, &choice.session, check)?
    {
        return Err(HIDDEN.into());
    }
    let last_viewport = Viewport::read(&observations::call(
        process,
        Command::Layout,
        json!({}),
        Some(&choice.session),
        check,
    )?)
    .ok_or(STALE)?;
    let verified = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    choice.check(
        (scope.0, scope.1, window),
        origin,
        &verified,
        &last_viewport,
    )?;
    if hit(
        process,
        &choice.session,
        &verified,
        &last_viewport,
        &nodes,
        check,
    )?
    .as_ref()
        != Some(&choice.hit)
    {
        return Err(STALE.into());
    }
    let final_frame = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    choice.check(
        (scope.0, scope.1, window),
        origin,
        &final_frame,
        &last_viewport,
    )?;
    check()?;
    process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .scroll(params, &choice.session, check, dispatch)
        .map_err(|_| UNKNOWN)?;
    check().map_err(|_| UNKNOWN)?;
    Ok(json!({"status":"scroll-dispatched","inputDispatched":true,"verified":false,"requiresObservation":true,"message":"Observe the current page to verify scrolling. Nested scrolling or page event handlers may affect its result. No input was replayed."}).to_string())
}

#[cfg(test)]
#[path = "scrolling_tests.rs"]
mod tests;
