//! Structured browser work in the same Chromium session shown by the viewer.
//! Callers hold a current native operation ticket and the browser session lock.

use std::{collections::HashMap, path::Path, sync::Arc};

use headless_chrome::browser::tab::Tab;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    normalize_agent_navigation, sanitize_agent_result_url, sanitize_browser_title, ComputerScope,
    LocalBrowserObservationState, LocalBrowserSession,
};

const MAX_TABS: usize = 16;
const MAX_PAGE_TEXT: usize = 16_000;
const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

// No input value, editable content, script, hidden state, or credential-shaped
// container is included. Text is external evidence, never instruction authority.
const VISIBLE_TEXT_SCRIPT: &str = r#"(() => {
  const secret = /(password|passcode|one.?time|verification|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|otp|payment)/i;
  const excluded = 'input,textarea,select,script,style,noscript,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]';
  const forbidden = (el) => {
    if (el.closest(excluded)) return true;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (secret.test([node.id,node.getAttribute('name'),node.getAttribute('aria-label'),node.getAttribute('autocomplete')].join(' '))) return true;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
    }
    return false;
  };
  if (!document.body) return '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const output = []; let length = 0; let visited = 0; let node;
  while ((node = walker.nextNode()) && visited++ < 20000 && length < 16000) {
    const el = node.parentElement;
    if (!el || forbidden(el)) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if (!Array.from(range.getClientRects()).some((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) continue;
    const text = (node.textContent || '').replace(/\s+/g,' ').trim();
    if (text) { output.push(text); length += text.length + 1; }
  }
  return output.join('\n').slice(0,16000)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]{12,}/gi,'[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,'[redacted credential]');
})()"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserTabObservation {
    #[serde(rename = "ref")]
    pub(super) tab_ref: String,
    title: String,
    current_url: String,
    pub(super) active: bool,
}

pub(super) struct BrowserPageObservation {
    pub text: String,
    pub tabs: Vec<BrowserTabObservation>,
    pub active_tab_ref: String,
    pub retained_tabs: HashMap<String, Arc<Tab>>,
}

fn available_tabs(session: &LocalBrowserSession) -> Result<Vec<Arc<Tab>>, String> {
    let tabs = session
        ._browser
        .get_tabs()
        .lock()
        .map_err(|_| "The local browser tab list is unavailable.".to_string())?;
    Ok(tabs.iter().take(MAX_TABS).cloned().collect())
}

/// After a human return, observe the tab actually visible on the desktop.
pub(super) fn follow_active_tab(session: &mut LocalBrowserSession) -> Result<(), String> {
    let tabs = available_tabs(session)?;
    let mut visible = None;
    for tab in tabs {
        let state = tab.evaluate("JSON.stringify({visible:document.visibilityState==='visible',focused:document.hasFocus()})", false)
            .ok().and_then(|result| result.value)
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
        if state
            .as_ref()
            .and_then(|state| state.get("focused"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            if session.tab.get_target_id() != tab.get_target_id() {
                session.observation = None;
            }
            session.tab = tab;
            return Ok(());
        }
        if state
            .as_ref()
            .and_then(|state| state.get("visible"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
            && (visible.is_none() || session.tab.get_target_id() == tab.get_target_id())
        {
            visible = Some(tab);
        }
    }
    if let Some(tab) = visible {
        if session.tab.get_target_id() != tab.get_target_id() {
            session.observation = None;
        }
        session.tab = tab;
    }
    Ok(())
}

pub(super) fn observe_page(
    session: &LocalBrowserSession,
    observation_id: &str,
) -> Result<BrowserPageObservation, String> {
    let text = session
        .tab
        .evaluate(VISIBLE_TEXT_SCRIPT, false)
        .map_err(|_| {
            "The browser could not read the visible page. Observe again after it finishes loading."
                .to_string()
        })?
        .value
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "The browser returned an invalid visible-page observation.".to_string())?;
    let mut retained_tabs = HashMap::new();
    let mut observations = Vec::new();
    let mut active_tab_ref = None;
    for tab in available_tabs(session)? {
        let active = session.tab.get_target_id() == tab.get_target_id();
        let tab_ref = tab_reference(observation_id, tab.get_target_id());
        if active {
            active_tab_ref = Some(tab_ref.clone());
        }
        observations.push(BrowserTabObservation {
            tab_ref: tab_ref.clone(),
            title: sanitize_browser_title(tab.get_title().unwrap_or_else(|_| "Browser tab".into())),
            current_url: sanitize_agent_result_url(&tab.get_url()),
            active,
        });
        retained_tabs.insert(tab_ref, tab);
    }
    Ok(BrowserPageObservation {
        text: text.chars().take(MAX_PAGE_TEXT).collect(),
        tabs: observations,
        active_tab_ref: active_tab_ref
            .ok_or_else(|| "The active tab changed. Observe the browser again.".to_string())?,
        retained_tabs,
    })
}

fn tab_reference(observation_id: &str, target_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"fable-browser-tab-v1\0");
    hash.update(observation_id.as_bytes());
    hash.update(b"\0");
    hash.update(target_id.as_bytes());
    format!("tab-{}", &hex::encode(hash.finalize())[..24])
}

pub(super) fn validate_tab_arguments(
    action: &str,
    tab_ref: Option<&str>,
    url: Option<&str>,
) -> Result<(), String> {
    let valid = match action {
        "new" => {
            tab_ref.is_none() && url.is_some_and(|url| normalize_agent_navigation(url).is_ok())
        }
        "switch" | "close" => {
            url.is_none()
                && tab_ref.is_some_and(|value| {
                    value.starts_with("tab-")
                        && value.len() == 28
                        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        }
        _ => false,
    };
    if !valid {
        return Err(
            "Choose new with a public page URL, or switch/close with an exact observed tab ref."
                .into(),
        );
    }
    Ok(())
}

pub(super) fn act_on_tab(
    session: &mut LocalBrowserSession,
    observation: LocalBrowserObservationState,
    action: &str,
    tab_ref: Option<&str>,
    url: Option<&str>,
) -> Result<(), String> {
    validate_tab_arguments(action, tab_ref, url)?;
    if action == "new" {
        if session
            ._browser
            .get_tabs()
            .lock()
            .map_err(|_| "The local browser tab list is unavailable.".to_string())?
            .len()
            >= MAX_TABS
        {
            return Err("Close an unused browser tab before opening another; this computer supports up to 16 tabs.".into());
        }
        let url = normalize_agent_navigation(url.unwrap_or_default())?;
        let tab = session
            ._browser
            .new_tab()
            .map_err(|_| "The local browser could not create a tab.".to_string())?;
        tab.navigate_to(&url)
            .map_err(|_| "The new browser tab could not open that page.".to_string())?;
        let _ = tab.wait_until_navigated();
        tab.activate()
            .map_err(|_| "The browser could not show the new tab.".to_string())?;
        session.tab = tab;
        return Ok(());
    }
    let tab = observation
        .tabs
        .get(tab_ref.unwrap_or_default())
        .ok_or_else(|| "That browser tab reference is stale. Observe again.".to_string())?;
    let current = available_tabs(session)?;
    if !current
        .iter()
        .any(|candidate| candidate.get_target_id() == tab.get_target_id())
    {
        return Err("That browser tab was closed. Observe again.".into());
    }
    if action == "switch" {
        tab.activate()
            .map_err(|_| "The browser could not switch to that tab.".to_string())?;
        session.tab = tab.clone();
    } else {
        if current.len() <= 1 {
            return Err("Keep one browser tab open; navigate it to another page instead.".into());
        }
        if !tab
            .close(true)
            .map_err(|_| "The browser could not close that tab.".to_string())?
        {
            return Err("The browser tab has not closed. Observe it before trying again.".into());
        }
        if session.tab.get_target_id() == tab.get_target_id() {
            let replacement = current
                .into_iter()
                .find(|candidate| candidate.get_target_id() != tab.get_target_id())
                .ok_or_else(|| "The browser tab list changed. Observe again.".to_string())?;
            replacement
                .activate()
                .map_err(|_| "The browser could not show the remaining tab.".to_string())?;
            session.tab = replacement;
        }
    }
    Ok(())
}

pub(super) fn upload_to_observed_control(
    scope: &ComputerScope,
    session: &LocalBrowserSession,
    control_ref: &str,
    control_name: &str,
    relative_path: &str,
) -> Result<(), String> {
    let workspace = scope.directory.join("workspace");
    confined_upload_path(&workspace, relative_path)?;
    let source = crate::tools::confine_path(relative_path, &workspace)?;
    let bytes = super::artifacts::read_bounded(&workspace, &source)?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The upload file name is invalid.".to_string())?;
    let guest_path = super::container::stage_browser_upload(scope, name, &bytes)?;
    if !control_ref
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("The file upload reference is invalid.".into());
    }
    let element = session
        .tab
        .find_element(&format!(
            "input[type=file][data-fable-control='{control_ref}']"
        ))
        .map_err(|_| "The upload control changed. Observe the page again.".to_string())?;
    let input = serde_json::to_string(&serde_json::json!({"ref":control_ref,"name":control_name}))
        .map_err(|_| "The file upload reference is invalid.".to_string())?;
    // Retain the exact DOM node id after checking it; SetFileInputFiles targets
    // that node, never a newly matched arbitrary selector supplied by a model.
    let script = format!(
        r#"function() {{
      const input={input}; const clean=v=>String(v||'').replace(/\s+/g,' ').trim().slice(0,120);
      const el=this;
      if (!el.isConnected || el.getAttribute('data-fable-control')!==input.ref) return false;
      if (!(el instanceof HTMLInputElement) || el.type!=='file' || el.disabled) return false;
      const hint=[el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' ');
      if (/(password|passcode|verification|secret|token|api.?key|credit.?card|cvv|cvc|otp)/i.test(hint)) return false;
      const by=clean(el.getAttribute('aria-labelledby'));
      const labelled=by?clean(by.split(/\s+/).map(id=>document.getElementById(id)?.textContent).join(' ')):'';
      const own=el.id?clean(document.querySelector(`label[for="${{CSS.escape(el.id)}}"]`)?.textContent):'';
      const name=clean(el.getAttribute('aria-label'))||labelled||own||clean(el.placeholder)||clean(el.title)||clean(el.innerText);
      return name===input.name;
    }}"#
    );
    if element
        .call_js_fn(&script, Vec::new(), false)
        .ok()
        .and_then(|value| value.value)
        .and_then(|value| value.as_bool())
        != Some(true)
    {
        return Err("The observed upload control changed. Observe the page again.".into());
    }
    element
        .set_input_files(&[&guest_path])
        .map_err(|_| "The browser could not upload that staged workspace file.".to_string())?;
    Ok(())
}

fn confined_upload_path(workspace: &Path, relative_path: &str) -> Result<String, String> {
    let path = crate::tools::confine_path(relative_path, workspace)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|_| "Choose an existing file in this agent's workspace for upload.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_UPLOAD_BYTES {
        return Err("Uploads require a regular workspace file no larger than 25 MB.".into());
    }
    let workspace = crate::paths::strict_canonicalize(workspace)
        .map_err(|_| "The upload workspace failed its security check.".to_string())?;
    let path = crate::paths::strict_canonicalize(&path)
        .map_err(|_| "The upload file failed its security check.".to_string())?;
    let relative = path
        .strip_prefix(&workspace)
        .map_err(|_| "The upload file is outside the agent workspace.".to_string())?;
    let relative = relative
        .to_str()
        .filter(|value| !value.chars().any(char::is_control))
        .ok_or_else(|| "The upload file name is invalid.".to_string())?;
    Ok(format!(
        "/home/fable/Workspace/{}",
        relative.replace('\\', "/")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_references_are_bound_to_observation_and_target() {
        let first = tab_reference("observation-1", "target-1");
        assert_eq!(first, tab_reference("observation-1", "target-1"));
        assert_ne!(first, tab_reference("observation-2", "target-1"));
        assert_ne!(first, tab_reference("observation-1", "target-2"));
        validate_tab_arguments("switch", Some(&first), None).unwrap();
        assert!(validate_tab_arguments("new", Some(&first), Some("https://example.com")).is_err());
        assert!(validate_tab_arguments("new", None, Some("file:///private")).is_err());
        assert!(
            validate_tab_arguments("new", None, Some("https://example.com/?token=secret")).is_err()
        );
        assert!(validate_tab_arguments("close", Some("target-1"), None).is_err());
    }

    #[test]
    fn upload_paths_are_existing_bounded_workspace_files() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("report.csv"), "one,two").unwrap();
        assert_eq!(
            confined_upload_path(&workspace, "report.csv").unwrap(),
            "/home/fable/Workspace/report.csv"
        );
        assert!(confined_upload_path(&workspace, "../outside.csv").is_err());
        assert!(confined_upload_path(&workspace, "missing.csv").is_err());
        assert!(confined_upload_path(&workspace, ".").is_err());
        let huge = std::fs::File::create(workspace.join("huge.bin")).unwrap();
        huge.set_len(MAX_UPLOAD_BYTES + 1).unwrap();
        assert!(confined_upload_path(&workspace, "huge.bin").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn upload_rejects_symlinks_even_to_a_file_inside_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("source.txt"), "private").unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("source.txt"),
            temp.path().join("alias.txt"),
        )
        .unwrap();
        assert!(confined_upload_path(temp.path(), "alias.txt").is_err());
    }
}
