//! Native capability routes into an exact restricted command session. Local
//! ports are transport endpoints; no host application port is ever discovered.
mod picker;
#[cfg(windows)]
mod proxy;
use super::LocalComputerState;
#[cfg(windows)]
use serde::Serialize;
#[cfg(windows)]
use serde_json::json;
use serde_json::Value;
use std::sync::Arc;
#[cfg(windows)]
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};

#[cfg(windows)]
const TTL: Duration = Duration::from_secs(10 * 60);
#[cfg(windows)]
const MAX_PREVIEWS: usize = 8;
const HOST_SUFFIX: &str = ".mivlet-preview.localhost";

/// Reserved frame namespace, with an exact native capability label and port.
/// The parent CSP permits this namespace only for frames; it does not establish
/// registration, account authority, or permission to reach another local host.
pub(crate) fn preview_origin(uri: &str) -> Option<String> {
    let parsed = url::Url::parse(uri).ok()?;
    let token = parsed.host_str()?.strip_suffix(HOST_SUFFIX)?;
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_none_or(|port| port == 0)
        || token.len() != 48
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}
#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    id: String,
    job_id: String,
    job_generation: u64,
    repository_id: String,
    generation: u64,
    revision: String,
    url: String,
    origin: String,
    expires_at: String,
    picker_supported: bool,
}
#[cfg(windows)]
struct Entry {
    descriptor: Descriptor,
    workspace: String,
    agent: String,
    state: Weak<LocalComputerState>,
    account: crate::account_session::AccountDispatchFence,
    authority: Arc<super::authority::ComputerAuthority>,
    binding: mivlet_windows_executor::Binding,
    session: mivlet_windows_executor::SessionControl,
    expires: Instant,
    closed: AtomicBool,
    bytes: AtomicU64,
}
#[cfg(windows)]
impl Entry {
    fn current(&self) -> Result<(), String> {
        crate::mcp_app_host::require_live_preview_guards()?;
        if self.closed.load(Ordering::Acquire) || Instant::now() >= self.expires {
            return Err(
                "This live preview expired; reopen it from the current command session.".into(),
            );
        }
        self.state
            .upgrade()
            .ok_or("The local workspace closed.")?
            .ensure_open()?;
        self.account.with_current(|| {
            self.authority
                .check_generation(self.descriptor.generation)?;
            if !self.session.is_current(&self.binding) {
                return Err("This preview's command session stopped or changed.".into());
            }
            Ok(())
        })
    }
}
#[cfg(windows)]
static ENTRIES: OnceLock<Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
#[cfg(windows)]
fn entries() -> &'static Mutex<HashMap<String, Arc<Entry>>> {
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Used only by native frame/Fetch interception. An expired, stopped or changed
/// account cannot keep its origin registered through a renderer URL string.
#[cfg(windows)]
pub(crate) fn registered_origin(uri: &str) -> Option<String> {
    let origin = preview_origin(uri)?;
    let entry = {
        entries()
            .lock()
            .ok()?
            .values()
            .find(|entry| entry.descriptor.origin == origin)
            .cloned()
    }?;
    entry.current().ok()?;
    Some(origin)
}
#[cfg(not(windows))]
pub(crate) fn registered_origin(_uri: &str) -> Option<String> {
    None
}
pub(crate) fn same_registered_origin(expected: &str, uri: &str) -> bool {
    registered_origin(expected).is_some_and(|origin| {
        url::Url::parse(uri).is_ok_and(|url| {
            url.username().is_empty()
                && url.password().is_none()
                && url.origin().ascii_serialization() == origin
        })
    })
}
pub(crate) fn navigation_allowed(expected: &str, uri: &str) -> Option<bool> {
    let parsed = url::Url::parse(expected).ok()?;
    let host = parsed.host_str()?;
    if host != &HOST_SUFFIX[1..] && !host.ends_with(HOST_SUFFIX) {
        return None;
    }
    // A malformed or retired capability cannot become an ordinary frame just
    // because the namespace appears in frame-src.
    if preview_origin(expected).is_none() {
        return Some(false);
    }
    #[cfg(windows)]
    if let Some(allowed) = crate::connection_allowlist_probe::navigation(expected, uri) {
        return Some(allowed);
    }
    Some(same_registered_origin(expected, uri))
}

#[cfg(windows)]
fn open(
    state: Arc<LocalComputerState>,
    workspace: &str,
    agent: &str,
    generation: u64,
    job: &str,
    job_generation: u64,
) -> Result<Value, String> {
    crate::mcp_app_host::require_live_preview_guards()?;
    state.validate_target(workspace, agent)?;
    let ticket = state
        .authority_for(workspace, agent)?
        .begin_viewer(generation)?;
    if generation != job_generation {
        return Err("The preview command belongs to an earlier generation.".into());
    }
    let (binding, session) =
        state.command_preview(workspace, agent, generation, job, job_generation)?;
    let spec = session.preview_spec().ok_or(
        "Start a command with an explicitly approved preview port before opening its app.",
    )?;
    if spec.port == 0 {
        return Err("This session has no approved preview port.".into());
    }
    let revision = session.input_id(&binding)?;
    let repository_id = state
        .command_jobs(workspace, agent)?
        .list()?
        .into_iter()
        .find(|record| record.id == job && record.generation == job_generation)
        .and_then(|record| record.repository_id)
        .ok_or("Live previews require an exact task repository copy.")?;
    let account = crate::account_session::AccountDispatchFence::capture()?;
    let mut guard = entries()
        .lock()
        .map_err(|_| "Live previews are unavailable.")?;
    guard.retain(|_, entry| {
        let current = entry.current().is_ok();
        if !current {
            entry.closed.store(true, Ordering::Release);
        }
        current
    });
    if let Some(entry) = guard.values().find(|entry| {
        entry.workspace == workspace
            && entry.agent == agent
            && entry.descriptor.job_id == job
            && entry.descriptor.job_generation == job_generation
            && entry.descriptor.revision == revision
    }) {
        return ticket.finish(Ok(json!({"status":"ready","preview":entry.descriptor})));
    }
    if guard.len() >= MAX_PREVIEWS {
        return Err("Close another live preview before opening this app.".into());
    }
    drop(guard);
    // Connecting verifies the peer Job/AppContainer before issuing a usable URL.
    // No HTTP bytes or probing request is sent to the application here.
    drop(session.open_preview(&binding)?);
    let id = super::desktop_tools::opaque_id()?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "The isolated preview transport is unavailable.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "The isolated preview transport is unavailable.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "The preview address is unavailable.")?
        .port();
    let origin = format!("http://{id}{HOST_SUFFIX}:{port}");
    let descriptor = Descriptor {
        id: id.clone(),
        job_id: job.into(),
        job_generation,
        repository_id,
        generation,
        revision,
        url: format!("{origin}/"),
        origin,
        expires_at: (chrono::Utc::now() + chrono::Duration::seconds(TTL.as_secs() as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        picker_supported: true,
    };
    let entry = Arc::new(Entry {
        descriptor: descriptor.clone(),
        workspace: workspace.into(),
        agent: agent.into(),
        state: Arc::downgrade(&state),
        account,
        authority: state.authority_for(workspace, agent)?,
        binding,
        session,
        expires: Instant::now() + TTL,
        closed: AtomicBool::new(false),
        bytes: AtomicU64::new(0),
    });
    let mut guard = entries()
        .lock()
        .map_err(|_| "Live previews are unavailable.")?;
    if guard.len() >= MAX_PREVIEWS {
        return Err("Close another live preview before opening this app.".into());
    }
    guard.insert(id, entry.clone());
    drop(guard);
    if let Err(error) = proxy::start(listener, entry.clone()) {
        entry.closed.store(true, Ordering::Release);
        entries()
            .lock()
            .map_err(|_| "Live previews are unavailable.")?
            .remove(&entry.descriptor.id);
        return Err(error);
    }
    ticket.finish(Ok(json!({"status":"ready","preview":descriptor})))
}

#[cfg(windows)]
fn target(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    job: &str,
    job_generation: u64,
    id: &str,
) -> Result<Arc<Entry>, String> {
    state.validate_target(workspace, agent)?;
    state
        .authority_for(workspace, agent)?
        .check_generation(generation)?;
    let entry = entries()
        .lock()
        .map_err(|_| "Live previews are unavailable.")?
        .get(id)
        .cloned()
        .ok_or("This preview is no longer open.")?;
    if entry.workspace != workspace
        || entry.agent != agent
        || entry.descriptor.generation != generation
        || entry.descriptor.job_id != job
        || entry.descriptor.job_generation != job_generation
    {
        return Err("This preview belongs to another session or generation.".into());
    }
    entry.current()?;
    Ok(entry)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_command_preview(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: String,
    job_generation: u64,
    preview_id: Option<String>,
    close: Option<bool>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Live previews belong to the main window.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (
            state,
            workspace_id,
            agent_id,
            expected_generation,
            job_id,
            job_generation,
            preview_id,
            close,
        );
        Err("Restricted live previews require Windows.".into())
    }
    #[cfg(windows)]
    {
        state.validate_target(&workspace_id, &agent_id)?;
        let proof_session = if close != Some(true) {
            if crate::background_worker::commands::should_route("command-output")? {
                return Err("This command is owned by background execution. Stop that exact job, turn off background execution, then start a new foreground-owned command with its approved preview port.".into());
            }
            let (binding, session) = state.command_preview(
                &workspace_id,
                &agent_id,
                expected_generation,
                &job_id,
                job_generation,
            )?;
            session
                .preview_spec()
                .ok_or("Start this restricted command with an explicitly approved preview port.")?;
            Some((binding, session))
        } else {
            None
        };
        let proof_ticket = state
            .authority_for(&workspace_id, &agent_id)?
            .begin_viewer(expected_generation)?;
        let account = crate::account_session::AccountDispatchFence::capture()?;
        if close != Some(true) {
            crate::interactive_network_guard::verify_connection_allowlist(&window,||{state.ensure_open()?;account.with_current(|| {
                proof_ticket.check()?;
                if !proof_session.as_ref().is_some_and(|(binding,session)|session.is_current(binding)) {
                    return Err("The exact command session stopped during preview verification. No app preview was exposed.".into());
                }
                Ok(())
            })}).await?;
        }
        proof_ticket.finish(Ok(()))?;
        // Foreground/background command ownership must not be split by a view.
        let _handoff = crate::background_worker::commands::foreground_fence("command-output")?;
        if crate::background_worker::commands::should_route("command-output")? {
            return Err(
                "This command is owned by background execution. Stop that exact job, turn off background execution, then start a new foreground-owned command with its approved preview port.".into(),
            );
        }
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move|| {
            if close==Some(true) {
                let id=preview_id.ok_or("Choose the exact preview to close.")?;
                let entry=target(&state,&workspace_id,&agent_id,expected_generation,&job_id,job_generation,&id)?;
                entry.closed.store(true,Ordering::Release);
                entries().lock().map_err(|_|"Live previews are unavailable.")?.remove(&id);
                return Ok(json!({"status":"closed","message":"Live preview closed. The restricted command session is unchanged."}));
            }
            open(state,&workspace_id,&agent_id,expected_generation,&job_id,job_generation)
        }).await.map_err(|_|"Live preview opening was interrupted.".to_owned())?
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_preview_feedback(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: String,
    job_generation: u64,
    preview_id: String,
    pick: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Preview feedback belongs to the main window.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (
            state,
            workspace_id,
            agent_id,
            expected_generation,
            job_id,
            job_generation,
            preview_id,
            pick,
        );
        Err("Restricted live previews require Windows.".into())
    }
    #[cfg(windows)]
    {
        let entry = target(
            &state,
            &workspace_id,
            &agent_id,
            expected_generation,
            &job_id,
            job_generation,
            &preview_id,
        )?;
        let pick: picker::Pick =
            serde_json::from_value(pick).map_err(|_| "Choose one public preview element.")?;
        picker::feedback(
            &pick,
            &entry.descriptor.id,
            &entry.descriptor.job_id,
            entry.descriptor.job_generation,
            &entry.descriptor.revision,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_origin_requires_the_exact_reserved_capability_shape() {
        let origin = format!("http://{}.mivlet-preview.localhost:41234", "a".repeat(48));
        assert_eq!(
            preview_origin(&format!("{origin}/work?version=1")),
            Some(origin.clone())
        );
        for invalid in [
            origin.replace(".mivlet-preview", ""),
            origin.replace(".localhost", ".localhost.evil"),
            origin.replace("http://", "http://extra."),
            origin.replace(&"a".repeat(48), &"g".repeat(48)),
            origin.replace(&"a".repeat(48), &"a".repeat(47)),
            origin.replace("http://", "https://"),
            origin.replace("http://", "http://user@"),
            origin.replace(":41234", ""),
            origin.replace(":41234", ":0"),
            "http://mivlet-preview.localhost:41234".into(),
        ] {
            assert!(preview_origin(&invalid).is_none(), "{invalid}");
        }
        assert_eq!(navigation_allowed(&origin, &origin), Some(false));
        assert_eq!(
            navigation_allowed("https://example.com", "https://example.com"),
            None
        );
    }
}
