//! Exact selected-window, origin-bounded browser reads. CDP identifiers and
//! field values stay native. Visibility uses one fixed isolated-world read;
//! no page input or caller-provided JavaScript is exposed.
use super::{pipes::Command, BrowserProcess};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

const LIMIT: usize = 32;
const STALE: &str = "The browser tab choice expired or changed. List its tabs again.";
const PRIVATE: &str = "This browser page contains private fields or credential-shaped content. Complete the private step yourself; no page content was delivered.";

pub(super) struct TabSnapshot {
    hwnd: u64,
    generation: u64,
    created: Instant,
    window: u64,
    choices: HashMap<String, String>,
    activations: HashMap<String, super::activation::Choice>,
}
impl TabSnapshot {
    fn consume(
        &mut self,
        hwnd: u64,
        generation: u64,
        reference: &str,
    ) -> Result<(String, u64), String> {
        if self.hwnd != hwnd
            || self.generation != generation
            || self.created.elapsed() >= Duration::from_secs(60)
        {
            return Err(STALE.into());
        }
        Ok((self.choices.remove(reference).ok_or(STALE)?, self.window))
    }
    pub(super) fn activation(
        &mut self,
        hwnd: u64,
        generation: u64,
        reference: &str,
    ) -> Result<super::activation::Choice, String> {
        self.consume(hwnd, generation, reference)?;
        self.activations
            .remove(reference)
            .ok_or_else(|| STALE.into())
    }
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
pub(super) fn title(value: &Value) -> String {
    let title = bounded(&value["title"], 200);
    if crate::secret_redaction::looks_secret(&title) {
        "Private title".into()
    } else {
        title
    }
}
fn id(value: &Value) -> Result<String, String> {
    value
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 100
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
        })
        .map(String::from)
        .ok_or_else(|| "The browser returned an unsupported native identity.".into())
}
pub(super) fn url_origin(value: &str) -> Option<String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}
fn exact_origin(value: &str) -> Result<String, String> {
    url_origin(value).filter(|origin| origin == value).ok_or_else(|| "Browser observation requires an exact HTTP(S) origin without a path, credentials, query or fragment.".into())
}
pub(super) fn call(
    process: &mut BrowserProcess,
    command: Command,
    args: Value,
    session: Option<&str>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    process
        ._pipe
        .as_mut()
        .ok_or("The browser's native connection is unavailable.")?
        .read_command(command, args, session, check)
}
pub(super) fn targets(
    process: &mut BrowserProcess,
    hwnd: u64,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(u64, Vec<Value>), String> {
    check()?;
    let windows = super::super::super::windows::list_windows()?;
    let owned: Vec<_> = windows
        .iter()
        .filter(|window| window.identity.pid == process.pid)
        .collect();
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindow, GW_OWNER};
    let roots: Vec<_> = owned
        .iter()
        .filter(|window| unsafe {
            GetWindow(window.identity.hwnd as usize as _, GW_OWNER).is_null()
        })
        .collect();
    if roots.len() != 1 || roots[0].identity.hwnd != hwnd {
        return Err("Browser reads require the exact sole visible window of this Mivlet-owned browser. Close extra browser windows and select it again.".into());
    }
    // Chrome's owned menus/tooltips are not extra tab windows. Never read their
    // content; password metadata still pauses reads behind a private popup.
    for popup in owned.iter().filter(|window| window.identity.hwnd != hwnd) {
        check()?;
        super::super::super::windows::privacy_check(popup.identity.hwnd)?;
    }
    let value = call(
        process,
        Command::Targets,
        json!({"filter":[{"type":"page","exclude":false},{"exclude":true}]}),
        None,
        check,
    )?;
    let pages = value["targetInfos"]
        .as_array()
        .filter(|pages| !pages.is_empty() && pages.len() <= LIMIT)
        .ok_or("The owned browser must have between one and 32 supported tabs.")?;
    let mut window = None;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for page in pages {
        if page["type"] != "page" {
            return Err("The browser returned an unsupported page target.".into());
        }
        let target = id(&page["targetId"])?;
        if !seen.insert(target.clone()) {
            return Err("The browser returned duplicate targets.".into());
        }
        let bounds = call(
            process,
            Command::Window,
            json!({"targetId":target}),
            None,
            check,
        )?;
        let current = bounds["windowId"]
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or("The browser window identity is missing.")?;
        if bounds["bounds"]["windowState"] == "minimized"
            || window.is_some_and(|previous| previous != current)
        {
            return Err("Browser reads require tabs in the sole selected browser window. No window was raised or restored.".into());
        }
        window = Some(current);
        result.push(page.clone());
    }
    check()?;
    Ok((window.ok_or(STALE)?, result))
}

pub(super) fn tabs(
    process: &mut BrowserProcess,
    hwnd: u64,
    generation: u64,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    process.tabs = None;
    process.navigation.clear();
    process.controls.clear();
    process.scroll = None;
    let (window, pages) = targets(process, hwnd, check)?;
    let mut choices = HashMap::new();
    let mut navigation = HashMap::new();
    let mut activations = HashMap::new();
    let mut tabs = Vec::new();
    let live: HashSet<_> = pages
        .iter()
        .map(|page| id(&page["targetId"]))
        .collect::<Result<_, _>>()?;
    process.sessions.retain(|target, _| live.contains(target));
    for page in pages {
        let target = id(&page["targetId"])?;
        let reference = super::super::super::desktop_tools::opaque_id()?;
        choices.insert(reference.clone(), target.clone());
        let title = title(&page);
        let raw_url = page["url"].as_str().unwrap_or_default();
        let mut origin = url_origin(raw_url);
        let mut navigation_ref = None;
        if origin.is_some() || raw_url == "about:blank" {
            let session = session(process, &target, check)?;
            let value = call(process, Command::Frames, json!({}), Some(&session), check)?;
            let choice = super::navigation::Choice::capture(
                hwnd, generation, window, &target, &session, raw_url, &value,
            )?;
            activations.insert(
                reference.clone(),
                super::activation::Choice::capture(choice.clone(), title.clone()),
            );
            let reference = super::super::super::desktop_tools::opaque_id()?;
            origin = Some(choice.origin.clone());
            navigation_ref = Some(reference.clone());
            navigation.insert(reference, choice);
        }
        tabs.push(json!({"tabRef":reference,"navigationRef":navigation_ref,"title":title,"origin":origin,"canActivate":activations.contains_key(&reference)}));
    }
    check()?;
    process.tabs = Some(TabSnapshot {
        hwnd,
        generation,
        created: Instant::now(),
        window,
        choices,
        activations,
    });
    process.navigation = navigation;
    Ok(json!({"tabs":tabs,"activationExpiresSeconds":30,"trust":"external-untrusted","instructionAuthority":"none","inputAuthority":false}).to_string())
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Frame {
    pub(super) id: String,
    pub(super) loader: String,
    pub(super) url: String,
}
pub(super) fn document(value: &Value) -> Result<Frame, String> {
    let root = &value["frameTree"]["frame"];
    let url = root["url"]
        .as_str()
        .filter(|value| value.len() <= 8192 && !value.chars().any(char::is_control))
        .ok_or("The browser page URL is missing or unsupported.")?;
    Ok(Frame {
        id: id(&root["id"])?,
        loader: id(&root["loaderId"])?,
        url: url.into(),
    })
}
pub(super) fn frame(value: &Value, origin: &str) -> Result<Frame, String> {
    let root = &value["frameTree"]["frame"];
    let raw = root["url"]
        .as_str()
        .ok_or("The browser page URL is missing.")?;
    if url_origin(raw).as_deref() != Some(origin) || root["securityOrigin"].as_str() != Some(origin)
    {
        return Err("The live browser page is outside the exact approved origin. No page content was delivered.".into());
    }
    document(value)
}

pub(super) fn session(
    process: &mut BrowserProcess,
    target: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    if let Some(session) = process.sessions.get(target) {
        return Ok(session.clone());
    }
    let result = call(
        process,
        Command::Attach,
        json!({"targetId":target,"flatten":true}),
        None,
        check,
    )?;
    let session = id(&result["sessionId"])?;
    process.sessions.insert(target.into(), session.clone());
    Ok(session)
}
fn editable(node: &Value) -> bool {
    matches!(
        node["role"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "textbox" | "searchbox" | "combobox" | "spinbutton" | "slider"
    ) || node["properties"].as_array().is_some_and(|values| {
        values.iter().any(|property| {
            property["name"] == "editable"
                && property["value"]["value"]
                    .as_str()
                    .is_some_and(|value| value != "false")
        })
    })
}
fn private_attributes(node: &Value) -> Result<bool, String> {
    // Editable AX descendants can be DOM text nodes, which have no attributes.
    // Their owning elements are checked separately and their text is never projected.
    if node["nodeType"] == 3 {
        return Ok(false);
    }
    let attributes = node["attributes"]
        .as_array()
        .ok_or("The browser field metadata is incomplete.")?;
    if attributes.len() > 512 || attributes.len() % 2 != 0 {
        return Err("The browser field metadata exceeded its limit.".into());
    }
    for pair in attributes.as_chunks::<2>().0 {
        let name = pair[0]
            .as_str()
            .ok_or("Invalid browser field metadata.")?
            .to_ascii_lowercase();
        let value = pair[1]
            .as_str()
            .ok_or("Invalid browser field metadata.")?
            .to_ascii_lowercase();
        if (name == "type" && matches!(value.as_str(), "password" | "file"))
            || (name == "autocomplete"
                && value.split_ascii_whitespace().any(|value| {
                    matches!(value, "current-password" | "new-password" | "one-time-code")
                        || value.starts_with("cc-")
                }))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn reachable(
    nodes: &[Value],
    frame: &str,
    field_descendants: bool,
) -> Result<Vec<usize>, String> {
    if nodes.len() > 2000 {
        return Err("This page's accessibility tree exceeded its read limit. Use a smaller page or an existing connector.".into());
    }
    let mut indexed = HashMap::new();
    let mut root = None;
    for (index, node) in nodes.iter().enumerate() {
        let key = id(&node["nodeId"])?;
        if indexed.insert(key, index).is_some() {
            return Err("The browser accessibility tree repeats an identity.".into());
        }
        if node["role"]["value"] == "RootWebArea"
            && node["frameId"] == frame
            && root.replace(index).is_some()
        {
            return Err("The browser accessibility root is ambiguous.".into());
        }
    }
    let mut pending = VecDeque::from([
        root.ok_or("The browser accessibility root could not be bound to the approved frame.")?
    ]);
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    while let Some(index) = pending.pop_front() {
        if !seen.insert(index) {
            return Err("The browser accessibility tree contains a cycle.".into());
        }
        let node = &nodes[index];
        if node["frameId"].as_str().is_some_and(|id| id != frame)
            || (node["role"]["value"] == "RootWebArea" && Some(index) != root)
        {
            continue;
        }
        output.push(index);
        if field_descendants || !editable(node) {
            if let Some(children) = node["childIds"].as_array() {
                for child in children {
                    if let Some(index) = child.as_str().and_then(|id| indexed.get(id)) {
                        pending.push_back(*index);
                    }
                }
            }
        }
    }
    Ok(output)
}

fn privacy_fields(nodes: &[Value], frame: &str) -> Result<Vec<usize>, String> {
    let indexed: HashMap<_, _> = nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| node["nodeId"].as_str().map(|id| (id, index)))
        .collect();
    let backend = |node: &Value| {
        node["backendDOMNodeId"]
            .as_u64()
            .filter(|value| *value > 0 && *value <= u32::MAX.into())
    };
    let mut fields = Vec::new();
    for index in reachable(nodes, frame, true)?
        .into_iter()
        .filter(|index| editable(&nodes[*index]) || nodes[*index]["role"]["value"] == "button")
    {
        if backend(&nodes[index]).is_some() {
            fields.push(index);
            continue;
        }
        // Virtual AX text descendants have no DOM handle. They are covered only
        // when a real editable ancestor is checked and their subtree is omitted.
        let mut current = index;
        let mut covered = false;
        let mut seen = HashSet::new();
        while seen.insert(current) && seen.len() <= 32 {
            let Some(parent) = nodes[current]["parentId"]
                .as_str()
                .and_then(|id| indexed.get(id))
                .copied()
            else {
                break;
            };
            if !nodes[parent]["childIds"]
                .as_array()
                .is_some_and(|children| children.iter().any(|id| id == &nodes[current]["nodeId"]))
            {
                break;
            }
            if (editable(&nodes[parent]) || nodes[parent]["role"]["value"] == "button")
                && backend(&nodes[parent]).is_some()
            {
                covered = true;
                break;
            }
            current = parent;
        }
        if !covered {
            return Err("The browser field could not be checked for privacy.".into());
        }
    }
    if fields.len() > 100 {
        return Err("The browser page has too many fields for a bounded privacy check.".into());
    }
    Ok(fields)
}

#[derive(serde::Serialize)]
pub(super) struct Projection {
    content: Vec<Value>,
    truncated: bool,
}
fn projection(nodes: &[Value], frame: &str) -> Result<Projection, String> {
    let mut output = Vec::new();
    let mut remaining = 16000;
    let mut truncated = false;
    for index in reachable(nodes, frame, false)? {
        let node = &nodes[index];
        if node["ignored"] == false {
            if output.len() >= 200 || remaining == 0 {
                truncated = true;
                continue;
            }
            let role = bounded(&node["role"]["value"], 80);
            let mut name = bounded(&node["name"]["value"], 400.min(remaining));
            // Accessible field names can embed all or part of the current value.
            // Omit them entirely rather than guessing which substring is a label.
            if editable(node) {
                name.clear();
            } else if node["name"]["value"]
                .as_str()
                .is_some_and(|value| value.chars().count() > 400.min(remaining))
            {
                truncated = true;
            }
            if crate::secret_redaction::looks_secret(&name) {
                return Err(PRIVATE.into());
            }
            remaining -= name.chars().count();
            output.push(json!({"role":role,"name":name}));
        }
    }
    Ok(Projection {
        content: output,
        truncated,
    })
}

pub(super) fn observe(
    process: &mut BrowserProcess,
    hwnd: u64,
    generation: u64,
    reference: &str,
    requested_origin: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    process.controls.clear();
    process.scroll = None;
    let origin = exact_origin(requested_origin)?;
    // Consume before I/O; this choice cannot be replayed by a later observation.
    let (target, expected_window) = process
        .tabs
        .as_mut()
        .ok_or(STALE)?
        .consume(hwnd, generation, reference)?;
    let (window, pages) = targets(process, hwnd, check)?;
    if window != expected_window {
        return Err(STALE.into());
    }
    let page = pages
        .iter()
        .find(|page| page["targetId"] == target)
        .ok_or(STALE)?;
    if url_origin(page["url"].as_str().unwrap_or_default()).as_deref() != Some(&origin) {
        return Err(
            "The browser tab is outside the exact approved origin. No page content was delivered."
                .into(),
        );
    }
    let session = session(process, &target, check)?;
    let before = frame(
        &call(process, Command::Frames, json!({}), Some(&session), check)?,
        &origin,
    )?;
    let visible = process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&before.id, &session, check)?;
    let (nodes, content) = checked_tree(process, &session, &before, check)?;
    let (controls, choices) = if visible {
        super::controls::capture(
            process,
            (hwnd, generation, window),
            &target,
            &session,
            &before,
            &origin,
            &nodes,
            check,
        )?
    } else {
        (Vec::new(), HashMap::new())
    };
    let (viewport, scroll) = if visible {
        super::scrolling::capture(
            process,
            (hwnd, generation, window),
            &target,
            &session,
            &before,
            &origin,
            &nodes,
            check,
        )?
    } else {
        (Value::Null, None)
    };
    let after = frame(
        &call(process, Command::Frames, json!({}), Some(&session), check)?,
        &origin,
    )?;
    if before != after {
        return Err("The browser document changed during observation. List tabs and observe again; no content was delivered.".into());
    }
    check()?;
    process.controls = choices;
    let scroll_ref = scroll.as_ref().map(|(reference, _)| reference.clone());
    process.scroll = scroll;
    Ok(json!({"origin":origin,"content":content.content,"truncated":content.truncated,"controls":controls,"controlsPartial":true,"controlScope":"visible-tab-buttons-http-links","tabVisible":visible,"controlExpiresSeconds":30,"viewport":viewport,"scrollRef":scroll_ref,"inputValues":"omitted","scope":"top-frame-only","trust":"external-untrusted","instructionAuthority":"none","inputAuthority":false}).to_string())
}

pub(super) fn checked_tree(
    process: &mut BrowserProcess,
    session: &str,
    document: &Frame,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(Vec<Value>, Projection), String> {
    let tree = call(
        process,
        Command::Accessibility,
        json!({"frameId":document.id,"depth":8}),
        Some(session),
        check,
    )?;
    let nodes = tree["nodes"]
        .as_array()
        .ok_or("The browser accessibility tree is unavailable.")?;
    if nodes.len() > 2000 {
        return Err("The browser accessibility tree exceeded its read limit.".into());
    }
    let fields = privacy_fields(nodes, &document.id)?;
    for index in fields {
        let node = &nodes[index];
        let backend = node["backendDOMNodeId"]
            .as_u64()
            .filter(|value| *value > 0 && *value <= u32::MAX.into())
            .ok_or("The browser field could not be checked for privacy.")?;
        let metadata = call(
            process,
            Command::DescribeNode,
            json!({"backendNodeId":backend,"depth":0,"pierce":false}),
            Some(session),
            check,
        )?;
        if private_attributes(&metadata["node"])? {
            return Err(PRIVATE.into());
        }
    }
    Ok((nodes.clone(), projection(nodes, &document.id)?))
}

/// Chromium DOM hit testing takes document CSS coordinates; Input takes viewport
/// CSS coordinates. Only native measured scroll offsets may bridge the two.
pub(super) fn document_point(point: (i32, i32), offsets: (f64, f64)) -> Result<(i32, i32), String> {
    let coordinate = |value: i32, offset: f64| {
        if !(0..=10000).contains(&value)
            || !offset.is_finite()
            || !(0.0..=10_000_000.0).contains(&offset)
        {
            return Err(
                "The browser hit-test coordinate is unavailable. No browser input was dispatched.",
            );
        }
        Ok((f64::from(value) + offset).round() as i32)
    };
    Ok((
        coordinate(point.0, offsets.0)?,
        coordinate(point.1, offsets.1)?,
    ))
}

#[cfg(debug_assertions)]
pub(super) fn acceptance(
    process: &mut BrowserProcess,
    hwnd: u64,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let _server = super::fixture_server::Server::start()?;
    let origin = _server.origin.clone();
    let (_, pages) = targets(process, hwnd, check)?;
    if pages.len() != 1 {
        return Err("Browser QA requires its sole disposable tab.".into());
    }
    for (private, path) in [(false, "report"), (true, "private"), (true, "file")] {
        let url = format!("{origin}/{path}");
        let listed: Value = serde_json::from_str(&tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Browser QA tab list invalid.")?;
        let navigation_ref = listed["tabs"][0]["navigationRef"]
            .as_str()
            .ok_or("Browser QA navigation choice missing.")?;
        let source_origin = listed["tabs"][0]["origin"]
            .as_str()
            .ok_or("Browser QA source origin missing.")?;
        let result = super::navigation::navigate(
            process,
            hwnd,
            1,
            navigation_ref,
            source_origin,
            &url,
            check,
            dispatch,
        )
        .map_err(|error| format!("Browser QA {path} navigation: {error}"))?;
        if !result.contains("navigation-dispatched") {
            return Err("Browser QA navigation was not dispatched.".into());
        }
        if super::navigation::navigate(
            process,
            hwnd,
            1,
            navigation_ref,
            source_origin,
            &url,
            check,
            dispatch,
        )
        .is_ok()
        {
            return Err("Browser QA replayed navigation.".into());
        }
        std::thread::sleep(Duration::from_millis(350));
        let listed: Value = serde_json::from_str(&tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Browser QA tab list invalid.")?;
        let reference = listed["tabs"][0]["tabRef"]
            .as_str()
            .ok_or("Browser QA tab missing.")?;
        if observe(
            process,
            hwnd,
            1,
            reference,
            "https://outside.example",
            check,
        )
        .is_ok()
        {
            return Err("Browser QA accepted an outside origin.".into());
        }
        let listed: Value = serde_json::from_str(&tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Browser QA tab list invalid.")?;
        let reference = listed["tabs"][0]["tabRef"]
            .as_str()
            .ok_or("Browser QA tab missing.")?;
        let observed = observe(process, hwnd, 1, reference, &origin, check);
        if private {
            if !observed.as_ref().is_err_and(|error| error == PRIVATE) {
                return Err("Browser QA did not pause the private field or file chooser.".into());
            }
        } else {
            let observed = observed?;
            if !observed.contains("Revenue 42")
                || observed.contains("Hidden entry")
                || observed.contains("Hidden subframe")
            {
                return Err("Browser QA projection did not preserve public text and omit field/subframe contents.".into());
            }
            let evidence: Value = serde_json::from_str(&observed)
                .map_err(|_| "Browser control QA observation invalid.")?;
            let control = evidence["controls"]
                .as_array()
                .and_then(|controls| {
                    controls
                        .iter()
                        .find(|control| control["name"] == "Activate once")
                })
                .ok_or("Browser QA public button was not offered.")?;
            let control_ref = control["controlRef"]
                .as_str()
                .ok_or("Browser QA control identity missing.")?;
            let clicked = super::controls::click(
                process,
                (hwnd, 1),
                control_ref,
                &origin,
                "Activate once",
                check,
                dispatch,
            )?;
            if !clicked.contains("click-dispatched")
                || super::controls::click(
                    process,
                    (hwnd, 1),
                    control_ref,
                    &origin,
                    "Activate once",
                    check,
                    dispatch,
                )
                .is_ok()
            {
                return Err("Browser QA click was missing or replayable.".into());
            }
            let listed: Value = serde_json::from_str(&tabs(process, hwnd, 1, check)?)
                .map_err(|_| "Browser QA tabs invalid after click.")?;
            let next = listed["tabs"][0]["tabRef"]
                .as_str()
                .ok_or("Browser QA fresh tab missing.")?;
            let verified = observe(process, hwnd, 1, next, &origin, check)?;
            if !verified.contains("Activated once") || verified.contains("Not activated") {
                return Err("Browser QA click did not produce its freshly observed result.".into());
            }
            if observe(process, hwnd, 1, reference, &origin, check).is_ok() {
                return Err("Browser QA reused a consumed tab reference.".into());
            }
        }
    }
    super::tab_acceptance::run(process, hwnd, &origin, check, dispatch)?;
    super::scroll_acceptance::run(process, hwnd, &origin, check, dispatch)?;
    eprintln!("Owned browser DOM fixture: document-bound navigation and visible-tab public button click each dispatched once and verified by fresh observation; public text read; field values, editable descendants and subframes omitted; outside origin, consumed refs, password field and file chooser refused.");
    Ok(())
}

#[cfg(test)]
#[path = "observations_tests.rs"]
mod tests;
