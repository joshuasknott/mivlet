//! Selected Windows app tools. Pixels stay native until a claimed provider call
//! consumes them; transcripts contain only bounded, explicitly untrusted text.
use super::{
    authority::OperationTicket,
    control::{DeliveryMode, Observation, PreparedCall},
    LocalComputerState,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) struct NativeDesktopCapture {
    pub output: String,
    pub png: Vec<u8>,
    pub generation: u64,
    pub workspace_id: String,
    pub agent_id: String,
    pub created: Instant,
    pub observation_id: String,
    pub selection_id: String,
}
pub(crate) fn opaque_id() -> Result<String, String> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| "Computer randomness is unavailable.")?;
    Ok(hex::encode(random))
}
pub(crate) async fn prepare(
    computers: Arc<LocalComputerState>,
    workspace: &str,
    agent: &str,
    generation: u64,
) -> Result<(), String> {
    computers.validate_target(workspace, agent)?;
    computers.native.validate(workspace, agent, generation)
}
pub(crate) fn observe(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
) -> Result<NativeDesktopCapture, String> {
    observation(computers, workspace, agent, generation, true)
}
pub(crate) fn observe_app(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
) -> Result<String, String> {
    observation(computers, workspace, agent, generation, false).map(|c| c.output)
}
fn observation(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    image: bool,
) -> Result<NativeDesktopCapture, String> {
    let ticket = computers
        .authority_for(workspace, agent)?
        .begin_agent(generation)?;
    let mut window_size = (0, 0);
    let (request, result) =
        computers
            .native
            .call(workspace, agent, generation, &ticket, None, |window, _, mode| {
                if image && !mode.is_foreground() {
                    return Ok(PreparedCall::ForegroundRequired("Screenshots require an explicitly selected foreground window. Use local-app-observe for background controls, or request foreground selection."));
                }
                window_size = window.dimensions()?;
                if image && (window_size.0 > 4096 || window_size.1 > 4096) {
                    return Err(
                        "Resize this window below 4096 pixels before using screenshot control."
                            .into(),
                    );
                }
                Ok(PreparedCall::Driver(
                    "get_window_state",
                    json!({"pid":window.identity.pid,"window_id":window.identity.hwnd,
            "include_screenshot":image,"max_elements":100,"max_depth":10,"max_dimension":4096}),
                ))
            })?;
    if result["status"] == "foreground-required" {
        return Err(result["message"]
            .as_str()
            .unwrap_or("Foreground selection is required.")
            .into());
    }
    let data = result
        .get("structuredContent")
        .ok_or("The application's observation was incomplete.")?;
    let snapshot = data
        .get("snapshot_id")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 100)
        .ok_or("The application's snapshot identity is missing.")?;
    let mut png = Vec::new();
    let (width, height) = if image {
        let encoded = result["content"]
            .as_array()
            .and_then(|v| {
                v.iter()
                    .find(|v| v["type"] == "image" && v["mimeType"] == "image/png")
            })
            .and_then(|v| v["data"].as_str())
            .filter(|s| s.len() <= 6 * 1024 * 1024)
            .ok_or("The selected window did not provide a supported screenshot.")?;
        png = STANDARD
            .decode(encoded)
            .map_err(|_| "The selected window screenshot is invalid.")?;
        png_dimensions(&png)?
    } else {
        (0, 0)
    };
    let id = opaque_id()?;
    let mut tokens = HashMap::new();
    let mut controls = Vec::new();
    for element in data["elements"]
        .as_array()
        .ok_or("Windows accessibility did not provide elements.")?
        .iter()
        .take(100)
    {
        let Some(token) = element["element_token"].as_str().filter(|v| v.len() <= 100) else {
            continue;
        };
        let reference = format!("e{}", controls.len());
        tokens.insert(reference.clone(), token.into());
        controls.push(json!({"ref":reference,"role":bounded(&element["role"],80),"name":bounded(&element["label"],200),
            "value":bounded(&element["value"],1000),"enabled":element["enabled"].as_bool().unwrap_or(false)}));
    }
    let text = bounded(&data["tree_markdown"], 16000);
    if credential_shaped(&text) || controls.iter().any(|c| credential_shaped(&c.to_string())) {
        computers.native.stop(
            "The window contains credential-shaped content. Complete the private step yourself.",
        );
        return Err("Private content cannot be sent to the agent.".into());
    }
    let output = json!({"observationId":id,"generation":generation,"controls":controls,"text":text,
        "width":width,"height":height,"trust":"external-untrusted","instructionAuthority":"none",
        "imageDelivery":if image {"native-provider-only"} else {"none"}})
    .to_string();
    computers.native.retain(
        &request,
        Observation {
            id: id.clone(),
            snapshot: snapshot.into(),
            elements: tokens,
            width,
            height,
            window_size,
            created: Instant::now(),
        },
        &ticket,
    )?;
    ticket.finish(Ok(NativeDesktopCapture {
        output,
        png,
        generation,
        workspace_id: workspace.into(),
        agent_id: agent.into(),
        created: Instant::now(),
        observation_id: id,
        selection_id: request,
    }))
}
fn bounded(value: &Value, max: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(max)
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopAction {
    observation_id: String,
    action: String,
    element_ref: Option<String>,
    x: Option<u32>,
    y: Option<u32>,
    delta_y: Option<i32>,
    text: Option<String>,
    key: Option<String>,
    modifiers: Option<Vec<String>>,
}
fn arguments(
    action: &DesktopAction,
    observation: &Observation,
    pid: u32,
    hwnd: u64,
) -> Result<(&'static str, Value), String> {
    let invalid = "Application input does not match a supported action and its exact fields.";
    let mut args = json!({"pid":pid,"window_id":hwnd});
    let pointer = action.x.is_some() || action.y.is_some();
    if let Some(reference) = &action.element_ref {
        if pointer {
            return Err(invalid.into());
        }
        args["element_token"] = json!(observation
            .elements
            .get(reference)
            .ok_or("The control reference is stale. Observe again.")?);
        args["snapshot_id"] = json!(observation.snapshot);
    } else if pointer {
        match (action.x, action.y) {
            (Some(x), Some(y)) if x < observation.width && y < observation.height => {
                args["x"] = json!(x);
                args["y"] = json!(y);
            }
            _ => return Err("Coordinates are outside the latest screenshot.".into()),
        }
    }
    let target = pointer || action.element_ref.is_some();
    match action.action.as_str() {
        "click"
            if target
                && action.text.is_none()
                && action.key.is_none()
                && action.modifiers.is_none()
                && action.delta_y.is_none() =>
        {
            Ok(("click", args))
        }
        "type"
            if action.element_ref.is_some()
                && !pointer
                && action.key.is_none()
                && action.modifiers.is_none()
                && action.delta_y.is_none() =>
        {
            let text = action
                .text
                .as_deref()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 1500
                        && s.chars().count() <= 512
                        && !s.contains('\0')
                        && !credential_shaped(s)
                })
                .ok_or("Enter up to 512 non-secret characters in an observed text control.")?;
            args["text"] = json!(text);
            Ok(("type_text", args))
        }
        "scroll"
            if target
                && action.text.is_none()
                && action.key.is_none()
                && action.modifiers.is_none() =>
        {
            let delta = action
                .delta_y
                .filter(|d| *d != 0 && (-1200..=1200).contains(d))
                .ok_or(invalid)?;
            args["direction"] = json!(if delta < 0 { "up" } else { "down" });
            args["amount"] = json!((delta.unsigned_abs() / 100).max(1));
            args["by"] = json!("line");
            Ok(("scroll", args))
        }
        "key" if !target && action.text.is_none() && action.delta_y.is_none() => {
            let key = action.key.as_deref().ok_or(invalid)?;
            let normalized = match key {
                "Enter" => "RETURN",
                "Backspace" => "BACKSPACE",
                "ArrowUp" => "UP",
                "ArrowDown" => "DOWN",
                "ArrowLeft" => "LEFT",
                "ArrowRight" => "RIGHT",
                "PageUp" => "PAGEUP",
                "PageDown" => "PAGEDOWN",
                "Tab" => "TAB",
                "Escape" => "ESCAPE",
                "Delete" => "DELETE",
                "Home" => "HOME",
                "End" => "END",
                _ => return Err(invalid.into()),
            };
            let mods = action.modifiers.as_deref().unwrap_or_default();
            if mods.len() > 1 || mods.iter().any(|m| m != "Shift") {
                return Err("Only Shift with navigation keys is supported. Use observed app controls for other commands.".into());
            }
            args["key"] = json!(normalized);
            args["modifiers"] = json!(mods.iter().map(|_| "SHIFT").collect::<Vec<_>>());
            Ok(("press_key", args))
        }
        _ => Err(invalid.into()),
    }
}
pub(crate) fn act(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    action: DesktopAction,
) -> Result<String, String> {
    let ticket = computers
        .authority_for(workspace, agent)?
        .begin_agent(generation)?;
    let (_, result) = computers.native.call(
        workspace,
        agent,
        generation,
        &ticket,
        Some(&action.observation_id),
        |window, observation, mode| {
            if mode == DeliveryMode::Background && window.background_requires_foreground() {
                return Ok(PreparedCall::ForegroundRequired("This app framework can activate itself during background input. Request foreground selection before using it."));
            }
            if mode == DeliveryMode::Background && (action.action == "key" || action.x.is_some() || action.y.is_some()) {
                return Ok(PreparedCall::ForegroundRequired("Keyboard and pixel actions require foreground selection. Background control uses fresh element refs for clicking, appending text and scrolling."));
            }
            let (name, args) = arguments(
                &action,
                &observation.ok_or("Observe before acting.")?,
                window.identity.pid,
                window.identity.hwnd,
            )?;
            Ok(PreparedCall::Driver(name, args))
        },
    )?;
    if result["status"] == "foreground-required" {
        return ticket.finish(Ok(result.to_string()));
    }
    ticket.finish(Ok(json!({"generation":generation,"status":"input-dispatched","outcome":"Observe the application to confirm the effect.","requiresObservation":true,"trust":"external-untrusted"}).to_string()))
}
fn credential_shaped(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "sk-",
        "github_pat_",
        "ghp_",
        "bearer ",
        "-----begin private key",
        "password=",
        "api_key=",
        "access_token=",
    ]
    .iter()
    .any(|p| lower.contains(p))
}
pub(crate) fn delivery_ticket(
    computers: &Arc<LocalComputerState>,
    capture: &NativeDesktopCapture,
) -> Result<OperationTicket, String> {
    if capture.created.elapsed() > Duration::from_secs(30) {
        return Err("Screenshot delivery expired. Observe again.".into());
    }
    computers.validate_target(&capture.workspace_id, &capture.agent_id)?;
    let ticket = computers
        .authority_for(&capture.workspace_id, &capture.agent_id)?
        .begin_agent(capture.generation)?;
    computers.native.validate_delivery(capture, &ticket)?;
    Ok(ticket)
}
fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("The screenshot is too large.".into());
    }
    let reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map_err(|_| "The screenshot is invalid.")?;
    let info = reader.info();
    if !(1..=4096).contains(&info.width) || !(1..=4096).contains(&info.height) {
        return Err("The screenshot dimensions are unsupported.".into());
    }
    Ok((info.width, info.height))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observed() -> Observation {
        Observation {
            id: "fresh".into(),
            snapshot: "s1".into(),
            elements: HashMap::from([("e0".into(), "s1:0".into())]),
            width: 600,
            height: 400,
            window_size: (600, 400),
            created: Instant::now(),
        }
    }
    fn input(value: Value) -> Result<(&'static str, Value), String> {
        arguments(
            &serde_json::from_value(value).map_err(|_| "invalid")?,
            &observed(),
            12,
            34,
        )
    }
    #[test]
    fn only_observed_elements_or_bounded_pixels_are_accepted() {
        assert!(
            input(json!({"observationId":"fresh","action":"click","elementRef":"e1"})).is_err()
        );
        assert!(input(json!({"observationId":"fresh","action":"click","x":600,"y":1})).is_err());
        let (_, args) =
            input(json!({"observationId":"fresh","action":"click","elementRef":"e0"})).unwrap();
        assert_eq!(args["element_token"], "s1:0");
        assert_eq!(args["window_id"], 34);
        assert_eq!(args["snapshot_id"], "s1");
    }
    #[test]
    fn rejects_shell_launch_arbitrary_fields_and_global_shortcuts() {
        for value in [
            json!({"observationId":"fresh","action":"launch","application":"terminal"}),
            json!({"observationId":"fresh","action":"key","key":"R","modifiers":["Meta"]}),
            json!({"observationId":"fresh","action":"click","x":1,"y":1,"pid":99}),
        ] {
            assert!(input(value).is_err());
        }
    }
    #[test]
    fn text_requires_observed_control_and_blocks_secrets() {
        assert!(input(json!({"observationId":"fresh","action":"type","text":"hello"})).is_err());
        assert!(input(json!({"observationId":"fresh","action":"type","elementRef":"e0","text":"password=hidden"})).is_err());
        assert!(input(
            json!({"observationId":"fresh","action":"type","elementRef":"e0","text":"hello"})
        )
        .is_ok());
    }
}
