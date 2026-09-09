//! Native visual observations. Pixels stay in a pending native provider call;
//! the renderer and Mivlet transcript receive only bounded observation metadata.

use super::{
    authority::OperationTicket, browser_tools, container, ensure_browser_session,
    LocalComputerState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const OBSERVATION_TTL: Duration = Duration::from_secs(30);
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const PRIVACY_ERROR: &str = "This screen contains a private browser or sign-in surface. Take control to complete the private step, then return control on the working page.";

pub(super) struct DesktopObservationState {
    id: String,
    generation: u64,
    created: Instant,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopObservation {
    observation_id: String,
    generation: u64,
    width: u32,
    height: u32,
    trust: &'static str,
    image_delivery: &'static str,
    state_fingerprint: String,
}

pub(crate) struct NativeDesktopCapture {
    pub output: String,
    pub jpeg: Vec<u8>,
    pub generation: u64,
    pub workspace_id: String,
    pub agent_id: String,
    pub created: Instant,
}

pub(crate) fn opaque_id() -> Result<String, String> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random)
        .map_err(|_| "Computer observation randomness is unavailable.".to_string())?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Inspect every visible page in the shared browser. No form value is returned.
// Unknown/inaccessible browser state fails closed instead of sending pixels.
const PRIVATE_BROWSER_SURFACE: &str = r#"(() => {
  if (document.visibilityState !== 'visible') return false;
  if (!['http:','https:','about:'].includes(location.protocol) || (location.protocol === 'about:' && location.href !== 'about:blank')) return true;
  const secret = /(password|passcode|one.?time|verification|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|otp|payment)/i;
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const nodes = Array.from(document.querySelectorAll('input,textarea,[contenteditable],iframe,[id],[name],[aria-label],[autocomplete]'));
  if (nodes.length > 20000) return true;
  return nodes.some(el => visible(el) && (el.tagName === 'IFRAME' || el.matches('input[type=password]') || secret.test([el.id,el.getAttribute('name'),el.getAttribute('aria-label'),el.getAttribute('autocomplete')].join(' '))));
})()"#;

fn check_browser_privacy(session: &super::LocalBrowserSession) -> Result<(), String> {
    let tabs = session
        ._browser
        .get_tabs()
        .lock()
        .map_err(|_| PRIVACY_ERROR.to_string())?
        .clone();
    if tabs.len() > 16 {
        return Err(PRIVACY_ERROR.into());
    }
    for tab in tabs {
        if tab
            .evaluate(PRIVATE_BROWSER_SURFACE, false)
            .map_err(|_| PRIVACY_ERROR.to_string())?
            .value
            .and_then(|value| value.as_bool())
            != Some(false)
        {
            return Err(PRIVACY_ERROR.into());
        }
    }
    Ok(())
}

pub(crate) async fn prepare(
    computers: Arc<LocalComputerState>,
    workspace_id: &str,
    agent_id: &str,
    generation: u64,
) -> Result<(), String> {
    let scope = computers.scope(workspace_id, agent_id)?;
    ensure_browser_session(computers, scope, Some((generation, false))).await
}

pub(crate) fn observe(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    generation: u64,
) -> Result<NativeDesktopCapture, String> {
    let scope = computers.scope(workspace_id, agent_id)?;
    let authority = computers.authority_for(workspace_id, agent_id)?;
    let session = computers
        .sessions
        .lock()
        .map_err(|_| "Computer desktop state is unavailable.")?
        .get(&scope.key)
        .cloned()
        .ok_or("Observe the running computer before using desktop tools.")?;
    let ticket = authority.begin_agent(generation)?;
    let mut session = session
        .lock()
        .map_err(|_| "Computer desktop is busy.".to_string())?;
    ticket.check()?;
    browser_tools::follow_active_tab(&mut session)?;
    check_browser_privacy(&session)?;
    container::desktop_privacy_check(&scope)?;
    let jpeg = container::capture_desktop(&scope)?;
    let (width, height) = jpeg_dimensions(&jpeg)?;
    check_browser_privacy(&session)?;
    container::desktop_privacy_check(&scope)?;
    ticket.check()?;
    let observation = DesktopObservationState {
        id: format!("desktop-{}", opaque_id()?),
        generation,
        created: Instant::now(),
        width,
        height,
    };
    let output = serde_json::to_string(&DesktopObservation {
        observation_id: observation.id.clone(),
        generation,
        width,
        height,
        trust: "external-untrusted",
        image_delivery: "native-provider-only",
        state_fingerprint: hex::encode(&Sha256::digest(&jpeg)[..16]),
    })
    .map_err(|_| "The desktop observation is invalid.".to_string())?;
    let mut observations = computers
        .desktop_observations
        .lock()
        .map_err(|_| "Desktop observations are unavailable.".to_string())?;
    observations.retain(|_, observation| observation.created.elapsed() <= OBSERVATION_TTL);
    if observations.len() >= 32 && !observations.contains_key(&scope.key) {
        return Err("Too many computer observations are active. Retry shortly.".into());
    }
    observations.insert(scope.key, observation);
    ticket.finish(Ok(NativeDesktopCapture {
        output,
        jpeg,
        generation,
        workspace_id: workspace_id.into(),
        agent_id: agent_id.into(),
        created: Instant::now(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopAction {
    observation_id: String,
    action: String,
    x: Option<u32>,
    y: Option<u32>,
    to_x: Option<u32>,
    to_y: Option<u32>,
    delta_y: Option<i32>,
    text: Option<String>,
    key: Option<String>,
    modifiers: Option<Vec<String>>,
    application: Option<String>,
}

fn input_sequence(action: &DesktopAction, width: u32, height: u32) -> Result<Vec<Value>, String> {
    let invalid =
        || "Desktop input does not match a supported action and its exact fields.".to_string();
    let point = |x: Option<u32>, y: Option<u32>| -> Result<(u32, u32), String> {
        match (x, y) {
            (Some(x), Some(y)) if x < width && y < height => Ok((x, y)),
            _ => Err("Desktop coordinates are outside the observed frame.".into()),
        }
    };
    let has_point = action.x.is_some() || action.y.is_some();
    let has_to = action.to_x.is_some() || action.to_y.is_some();
    let has_key = action.key.is_some() || action.modifiers.is_some();
    if action.application.is_some() && action.action != "launch" {
        return Err(invalid());
    }
    match action.action.as_str() {
        "launch"
            if !has_point
                && !has_to
                && !has_key
                && action.text.is_none()
                && action.delta_y.is_none()
                && action.application.as_deref().is_some_and(|application| {
                    ["browser", "files", "terminal", "writer", "spreadsheet"].contains(&application)
                }) =>
        {
            Ok(Vec::new())
        }
        "click" | "double-click" | "scroll" | "drag" if action.text.is_none() && !has_key => {
            let (x, y) = point(action.x, action.y)?;
            let click = json!({"type":"pointer","action":"click","x":x,"y":y});
            match action.action.as_str() {
                "click" if !has_to && action.delta_y.is_none() => Ok(vec![click]),
                "double-click" if !has_to && action.delta_y.is_none() => {
                    Ok(vec![click.clone(), click])
                }
                "scroll"
                    if !has_to
                        && action
                            .delta_y
                            .is_some_and(|delta| delta != 0 && (-1920..=1920).contains(&delta)) =>
                {
                    Ok(vec![
                        json!({"type":"pointer","action":"scroll","x":x,"y":y,"deltaY":action.delta_y}),
                    ])
                }
                "drag" if action.delta_y.is_none() => {
                    let (to_x, to_y) = point(action.to_x, action.to_y)?;
                    Ok(vec![
                        json!({"type":"pointer","action":"down","x":x,"y":y}),
                        json!({"type":"pointer","action":"move","x":to_x,"y":to_y}),
                        json!({"type":"pointer","action":"up","x":to_x,"y":to_y}),
                    ])
                }
                _ => Err(invalid()),
            }
        }
        "type" if !has_point && !has_to && !has_key && action.delta_y.is_none() => {
            let text = action.text.as_deref().ok_or_else(invalid)?;
            if text.is_empty()
                || text.chars().count() > 4096
                || text.contains('\0')
                || credential_shaped(text)
            {
                return Err("Desktop text is empty, too large, or contains credential-shaped content. Use human control for private input.".into());
            }
            Ok(vec![json!({"type":"text","text":text})])
        }
        "key" if !has_point && !has_to && action.text.is_none() && action.delta_y.is_none() => {
            let key = action.key.as_deref().ok_or_else(invalid)?;
            let modifiers = action.modifiers.as_deref().unwrap_or_default();
            let named = [
                "Enter",
                "Backspace",
                "ArrowUp",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
                "PageUp",
                "PageDown",
                "Tab",
                "Escape",
                "Delete",
                "Home",
                "End",
                "Insert",
            ];
            if !(named.contains(&key)
                || (key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ')))
                || modifiers.len() > 3
                || modifiers
                    .iter()
                    .any(|modifier| !["Control", "Alt", "Shift"].contains(&modifier.as_str()))
            {
                return Err(invalid());
            }
            Ok(vec![json!({"type":"key","key":key,"modifiers":modifiers})])
        }
        _ => Err(invalid()),
    }
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
    .any(|prefix| lower.contains(prefix))
}

pub(crate) fn act(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    generation: u64,
    action: DesktopAction,
) -> Result<String, String> {
    let scope = computers.scope(workspace_id, agent_id)?;
    let authority = computers.authority_for(workspace_id, agent_id)?;
    let ticket = authority.begin_agent(generation)?;
    let observed = computers
        .desktop_observations
        .lock()
        .map_err(|_| "Desktop observations are unavailable.".to_string())?
        .remove(&scope.key)
        .ok_or_else(|| "Observe the desktop before acting.".to_string())?;
    if observed.id != action.observation_id
        || observed.generation != generation
        || observed.created.elapsed() > OBSERVATION_TTL
    {
        return Err("The desktop observation is stale. Observe again before acting.".into());
    }
    let inputs = input_sequence(&action, observed.width, observed.height)?;
    let session = computers
        .sessions
        .lock()
        .map_err(|_| "Computer desktop state is unavailable.")?
        .get(&scope.key)
        .cloned()
        .ok_or("Observe the running computer before using desktop tools.")?;
    let mut session = session
        .lock()
        .map_err(|_| "Computer desktop is busy.".to_string())?;
    ticket.check()?;
    check_browser_privacy(&session)?;
    container::desktop_privacy_check(&scope)?;
    if jpeg_dimensions(&container::capture_desktop(&scope)?)? != (observed.width, observed.height) {
        return Err("The desktop was resized. Observe it again before acting.".into());
    }
    session.observation = None;
    let result = (|| {
        if action.action == "launch" {
            ticket.check()?;
            container::launch_application(
                &scope,
                action.application.as_deref().unwrap_or_default(),
            )?;
        }
        for input in inputs {
            ticket.check()?;
            container::desktop_input(&scope, &input)?;
        }
        Ok(json!({"generation":generation,"status":"action-completed","requiresObservation":true,"trust":"external-untrusted"}).to_string())
    })();
    // Release held modifiers/pointer even when a multi-step action is revoked.
    let _ = container::desktop_input(&scope, &json!({"type":"release"}));
    ticket.finish(result)
}

pub(crate) fn delivery_ticket(
    computers: &Arc<LocalComputerState>,
    capture: &NativeDesktopCapture,
) -> Result<OperationTicket, String> {
    if capture.created.elapsed() > OBSERVATION_TTL {
        return Err("Desktop observation delivery expired. Observe again.".into());
    }
    computers.validate_target(&capture.workspace_id, &capture.agent_id)?;
    computers
        .authority_for(&capture.workspace_id, &capture.agent_id)?
        .begin_agent(capture.generation)
}

fn jpeg_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let invalid = || "The desktop frame is invalid or outside supported dimensions.".to_string();
    if bytes.len() < 4 || bytes.len() > MAX_FRAME_BYTES || bytes[..2] != [0xff, 0xd8] {
        return Err(invalid());
    }
    let mut offset = 2;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            return Err(invalid());
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or_else(invalid)?;
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = bytes.get(offset..offset + 2).ok_or_else(invalid)?;
        let length = u16::from_be_bytes([length[0], length[1]]) as usize;
        if length < 2 || offset + length > bytes.len() {
            return Err(invalid());
        }
        if [0xc0, 0xc1, 0xc2].contains(&marker) {
            if length < 8 {
                return Err(invalid());
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            return if (640..=3840).contains(&width) && (480..=2160).contains(&height) {
                Ok((width, height))
            } else {
                Err(invalid())
            };
        }
        offset += length;
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coordinates_actions_and_secret_input_fail_closed() {
        let parse = |value| serde_json::from_value::<DesktopAction>(value).unwrap();
        assert!(input_sequence(
            &parse(json!({"observationId":"a","action":"click","x":1279,"y":799})),
            1280,
            800
        )
        .is_ok());
        assert!(input_sequence(
            &parse(json!({"observationId":"a","action":"launch","application":"writer"})),
            1280,
            800
        )
        .is_ok());
        assert!(input_sequence(
            &parse(json!({"observationId":"a","action":"launch","application":"sh"})),
            1280,
            800
        )
        .is_err());
        assert!(input_sequence(
            &parse(
                json!({"observationId":"a","action":"click","x":1,"y":1,"application":"writer"})
            ),
            1280,
            800
        )
        .is_err());
        for value in [
            json!({"observationId":"a","action":"click","x":1280,"y":799}),
            json!({"observationId":"a","action":"click","x":1,"y":1,"text":"unused"}),
            json!({"observationId":"a","action":"type","text":"Bearer privatecredential"}),
            json!({"observationId":"a","action":"key","key":"Return;sh"}),
            json!({"observationId":"a","action":"scroll","x":1,"y":1,"deltaY":9999}),
        ] {
            assert!(input_sequence(&parse(value), 1280, 800).is_err());
        }
        assert!(serde_json::from_value::<DesktopAction>(
            json!({"observationId":"a","action":"type","text":"x","script":"evil"})
        )
        .is_err());
    }
    #[test]
    fn jpeg_dimensions_reject_truncation_and_oversized_screens() {
        let mut frame = vec![0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 3, 32, 5, 0, 3, 0xff, 0xd9];
        assert_eq!(jpeg_dimensions(&frame).unwrap(), (1280, 800));
        assert!(jpeg_dimensions(&frame[..8]).is_err());
        frame[9] = 255;
        assert!(jpeg_dimensions(&frame).is_err());
    }
}
