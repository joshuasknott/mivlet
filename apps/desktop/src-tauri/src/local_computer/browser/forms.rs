//! Empty public text fields only. Native node/document references stay private;
//! existing values are never returned or replaced.
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

const STALE: &str = "The browser field is stale or changed. List tabs and observe again. No browser input was dispatched.";
const UNKNOWN: &str = "Browser form entry outcome is uncertain. Observe the current page; do not replay it or overwrite an existing value.";

#[derive(Clone, PartialEq)]
struct Field {
    backend: u64,
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
    field: Field,
}
impl Choice {
    fn check(
        &self,
        scope: (u64, u64, u64),
        origin: &str,
        name: &str,
        frame: &Frame,
    ) -> Result<(), String> {
        if (self.hwnd, self.generation, self.window) != scope
            || self.origin != origin
            || self.field.name != name
            || self.frame != *frame
            || self.created.elapsed() >= Duration::from_secs(30)
        {
            return Err(STALE.into());
        }
        Ok(())
    }
}

fn candidate(node: &Value) -> Option<(u64, String)> {
    let name = node["name"]["value"].as_str()?;
    if node["ignored"] != false
        || !matches!(node["role"]["value"].as_str()?, "textbox" | "searchbox")
        // Chromium omits the optional AX value for some empty native inputs.
        // Missing is only a candidate: the isolated native getter below must
        // positively prove emptiness before an offer exists.
        || node.get("value").is_some_and(|value| value["value"].as_str() != Some(""))
        || name.trim().is_empty()
        || name.chars().count() > 160
        || name.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(name)
        || private_identifier(name)
        || node["properties"].as_array().is_some_and(|props| {
            props.iter().any(|prop| {
                matches!(
                    prop["name"].as_str(),
                    Some("disabled" | "readonly" | "requiredInvalid")
                ) && prop["value"]["value"] == true
            })
        })
    {
        return None;
    }
    Some((
        node["backendDOMNodeId"]
            .as_u64()
            .filter(|id| *id > 0 && *id <= u32::MAX.into())?,
        name.into(),
    ))
}
fn private_identifier(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "password",
        "passcode",
        "one-time",
        "otp",
        "secret",
        "token",
        "api-key",
        "apikey",
        "cc-",
        "credit",
        "cvv",
        "cvc",
        "username",
        "email",
        "phone",
        "login",
        "signin",
        "sign-in",
        "account",
        "credential",
        "authentication",
        "security-code",
    ]
    .iter()
    .any(|word| value.contains(word))
}
fn metadata(node: &Value) -> Option<Value> {
    if node["nodeType"] != 1 || !matches!(node["nodeName"].as_str()?, "INPUT" | "TEXTAREA") {
        return None;
    }
    let attrs = node["attributes"].as_array()?;
    if attrs.len() > 128 || attrs.len() % 2 != 0 {
        return None;
    }
    let mut bytes = 0;
    for pair in attrs.as_chunks::<2>().0 {
        let key = pair[0].as_str()?.to_ascii_lowercase();
        let value = pair[1].as_str()?;
        bytes += key.len() + value.len();
        if bytes > 2048
            || matches!(
                key.as_str(),
                "disabled" | "readonly" | "hidden" | "contenteditable"
            )
            || key == "value" && !value.is_empty()
            || key == "type" && !matches!(value.to_ascii_lowercase().as_str(), "text" | "search")
        {
            return None;
        }
        if matches!(
            key.as_str(),
            "name" | "id" | "aria-label" | "placeholder" | "autocomplete"
        ) && private_identifier(value)
        {
            return None;
        }
    }
    Some(json!({"tag":node["nodeName"],"attributes":attrs}))
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
        let Some((backend, name)) = candidate(&nodes[index]) else {
            continue;
        };
        if inspected >= 24 {
            break;
        }
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
        let Some(metadata) = metadata(&described["node"]) else {
            continue;
        };
        if !process
            ._pipe
            .as_mut()
            .ok_or(STALE)?
            .empty_text(&frame.id, session, backend, origin, &metadata, check)?
        {
            continue;
        }
        let reference = super::super::super::desktop_tools::opaque_id()?;
        display.push(json!({"fieldRef":reference,"name":name,"empty":true}));
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
                field: Field {
                    backend,
                    name,
                    metadata,
                },
            },
        );
    }
    Ok((display, choices))
}
pub(super) fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty()
        || text.len() > 2048
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\t'))
        || crate::secret_redaction::secret_marker_survives(text)
        || crate::secret_redaction::looks_secret(text)
    {
        return Err("Supply 1–2048 bytes of public text without credentials or control characters. No browser input was dispatched.".into());
    }
    Ok(())
}
pub(super) fn fill(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    reference: &str,
    origin: &str,
    name: &str,
    text: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    validate_text(text)?;
    let choice = process.fields.remove(reference).ok_or(STALE)?;
    process.fields.clear();
    process.downloads.clear();
    process.upload_choices.clear();
    process.controls.clear();
    process.navigation.clear();
    process.activation.clear();
    process.tabs = None;
    process.scroll = None;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if !pages.iter().any(|page| {
        page["targetId"] == choice.target && page["url"].as_str() == Some(&choice.frame.url)
    }) {
        return Err(STALE.into());
    }
    let frame = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    choice.check((scope.0, scope.1, window), origin, name, &frame)?;
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&frame.id, &choice.session, check)?
    {
        return Err(STALE.into());
    }
    let (nodes, _) = observations::checked_tree(process, &choice.session, &frame, check)?;
    if !observations::reachable(&nodes, &frame.id, false)?
        .iter()
        .any(|index| candidate(&nodes[*index]) == Some((choice.field.backend, name.into())))
    {
        return Err(STALE.into());
    }
    let described = observations::call(
        process,
        Command::DescribeNode,
        json!({"backendNodeId":choice.field.backend,"depth":0,"pierce":false}),
        Some(&choice.session),
        check,
    )?;
    if described["node"]["backendNodeId"].as_u64() != Some(choice.field.backend)
        || metadata(&described["node"]).as_ref() != Some(&choice.field.metadata)
    {
        return Err(STALE.into());
    }
    if choice.field.metadata["tag"] == "INPUT" && text.contains(['\n', '\t']) {
        return Err(
            "Single-line fields require single-line text. No browser input was dispatched.".into(),
        );
    }
    let quads = observations::call(
        process,
        Command::Quads,
        json!({"backendNodeId":choice.field.backend}),
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
    let point = super::controls::point(&quads, &metrics)?;
    let offset = (
        metrics["cssVisualViewport"]["pageX"]
            .as_f64()
            .ok_or(STALE)?,
        metrics["cssVisualViewport"]["pageY"]
            .as_f64()
            .ok_or(STALE)?,
    );
    let hit = observations::document_point(point, offset)?;
    let hit = observations::call(
        process,
        Command::Hit,
        json!({"x":hit.0,"y":hit.1,"includeUserAgentShadowDOM":false,"ignorePointerEventsNone":false}),
        Some(&choice.session),
        check,
    )?;
    if hit["backendNodeId"].as_u64() != Some(choice.field.backend)
        || hit["frameId"].as_str() != Some(&frame.id)
    {
        return Err(STALE.into());
    }
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&frame.id, &choice.session, check)?
    {
        return Err(STALE.into());
    }
    let latest = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        origin,
    )?;
    if latest != frame {
        return Err(STALE.into());
    }
    let result = process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .fill_empty(
            &frame.id,
            &choice.session,
            choice.field.backend,
            origin,
            &choice.field.metadata,
            text,
            check,
            dispatch,
        )
        .map_err(|_| UNKNOWN)?;
    if result != "filled" {
        return Err(STALE.into());
    }
    check().map_err(|_| UNKNOWN)?;
    Ok(json!({"status":"form-entry-dispatched","inputDispatched":true,"verified":false,"requiresObservation":true,"characters":text.chars().count(),
        "message":"Public text entered in the exact empty field. Observe the page before another action; no existing field value was returned or replaced."}).to_string())
}

#[cfg(test)]
#[path = "forms_tests.rs"]
mod tests;
