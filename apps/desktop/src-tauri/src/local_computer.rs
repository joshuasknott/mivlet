//! Local teammate computer boundary.
//!
//! Every workspace/agent pair gets a distinct Docker Linux desktop, persistent
//! home volume, bounded host-workspace bridge, Chromium profile, and control
//! lease. Docker/Chromium endpoints, container names, volume names, host paths,
//! cookies, and process handles never cross into the renderer.

pub(crate) mod artifacts;
pub(crate) mod authority;
mod browser_tools;
mod container;
pub(crate) mod desktop_tools;
pub(crate) mod lifecycle;
pub(crate) mod plugins;
pub(crate) mod repositories;
pub(crate) mod viewer;

use authority::ComputerAuthority;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use headless_chrome::{
    browser::tab::Tab,
    protocol::cdp::Page::{GetNavigationHistory, NavigateToHistoryEntry},
    Browser,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use url::Url;

const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;
const MAX_URL_CHARACTERS: usize = 2_048;
const MAX_FILE_ENTRIES: usize = 200;
const MAX_FILE_DEPTH: usize = 8;
const MAX_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_SAFE_UI_BYTES: u64 = 9_007_199_254_740_991;
const HUMAN_CONTROL_LEASE_MINUTES: i64 = 5;

/// Drain both independently running guest commands and browser download writes.
/// Attempt each cleanup even when the other transport has already failed.
pub(super) fn cancel_external_operations(scope: &ComputerScope) -> Result<(), String> {
    let commands = container::cancel_agent_processes(scope);
    let downloads = container::cancel_browser_downloads(scope);
    commands.and(downloads)
}

pub struct LocalComputerState {
    plugins: plugins::PluginAuthority,
    closing: AtomicBool,
    root: PathBuf,
    image_context: PathBuf,
    snapshot_path: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Mutex<LocalBrowserSession>>>>,
    launch_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    authorities: Mutex<HashMap<String, Arc<ComputerAuthority>>>,
    desktop_observations: Mutex<HashMap<String, desktop_tools::DesktopObservationState>>,
}

struct LocalBrowserSession {
    _browser: Browser,
    tab: Arc<Tab>,
    authority: Arc<ComputerAuthority>,
    browser_product: String,
    observation_counter: u64,
    observation: Option<LocalBrowserObservationState>,
}

struct LocalBrowserObservationState {
    id: String,
    generation: u64,
    controls: HashMap<String, LocalBrowserObservedControl>,
    tabs: HashMap<String, Arc<Tab>>,
}

struct LocalBrowserObservedControl {
    role: String,
    name: String,
    actions: Vec<String>,
    options: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalComputerController {
    Agent,
    Human,
    Paused,
}

impl LocalComputerController {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Human => "human",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerSnapshot {
    plugins: plugins::BuiltinPlugins,
    computer_id: String,
    workspace_id: String,
    agent_id: String,
    locality: &'static str,
    backend: &'static str,
    isolation: &'static str,
    lifecycle: &'static str,
    browser_available: bool,
    browser_active: bool,
    controller: &'static str,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_expires_at: Option<String>,
    capabilities: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBrowserSnapshot {
    computer_id: String,
    current_url: String,
    title: String,
    preview_data_url: String,
    viewport: LocalBrowserViewportSnapshot,
    can_go_back: bool,
    can_go_forward: bool,
    controller: &'static str,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_expires_at: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBrowserViewportSnapshot {
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerFilesSnapshot {
    computer_id: String,
    entries: Vec<LocalComputerFileEntry>,
    truncated: bool,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalComputerFileEntry {
    path: String,
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerFileRequest {
    workspace_id: String,
    agent_id: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerFilePreview {
    computer_id: String,
    path: String,
    content: String,
    size_bytes: u64,
    truncated: bool,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalBrowserAgentResult {
    computer_id: String,
    current_url: String,
    title: String,
    trust: &'static str,
    generation: u64,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalComputerShellResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalBrowserAgentObservation {
    observation_id: String,
    computer_id: String,
    current_url: String,
    title: String,
    trust: &'static str,
    generation: u64,
    controls: Vec<LocalBrowserAgentControl>,
    text: String,
    tabs: Vec<browser_tools::BrowserTabObservation>,
    active_tab_ref: String,
    downloads: serde_json::Value,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBrowserAgentControl {
    #[serde(rename = "ref")]
    control_ref: String,
    role: String,
    name: String,
    actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    options: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerTarget {
    workspace_id: String,
    agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBrowserNavigateRequest {
    workspace_id: String,
    agent_id: String,
    url: String,
    expected_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerControlRequest {
    workspace_id: String,
    agent_id: String,
    controller: LocalComputerController,
    expected_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerCancelRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBrowserPointerRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    x: f64,
    y: f64,
    action: String,
    #[serde(default)]
    delta_y: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBrowserKeyRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBrowserHistoryRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    direction: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerLaunchRequest {
    workspace_id: String,
    agent_id: String,
    application: String,
    expected_generation: u64,
}

impl LocalComputerState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let app_data = crate::paths::app_data_dir(app)?;
        let root = app_data.join("local-computers");
        std::fs::create_dir_all(&root)
            .map_err(|_| "Mivlet could not initialize local computer storage.".to_string())?;
        let source_context = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("local-computer");
        let resource_root = app.path().resource_dir().unwrap_or_else(|_| PathBuf::new());
        let image_context = [
            source_context,
            resource_root.join("resources").join("local-computer"),
            resource_root.join("local-computer"),
        ]
        .into_iter()
        .find(|candidate| candidate.join("Dockerfile").is_file())
        .unwrap_or_else(|| resource_root.join("local-computer"));
        Ok(Self {
            plugins: plugins::PluginAuthority::load(&root.join("plugins.json"))?,
            closing: AtomicBool::new(false),
            root,
            image_context,
            snapshot_path: crate::paths::runtime_snapshot_path(app)?,
            sessions: Mutex::new(HashMap::new()),
            launch_gates: Mutex::new(HashMap::new()),
            authorities: Mutex::new(HashMap::new()),
            desktop_observations: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    fn for_test(root: PathBuf) -> Self {
        let image_context = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("local-computer");
        Self {
            plugins: plugins::PluginAuthority::for_test(),
            closing: AtomicBool::new(false),
            snapshot_path: root.join("runtime-snapshot.json"),
            root,
            image_context,
            sessions: Mutex::new(HashMap::new()),
            launch_gates: Mutex::new(HashMap::new()),
            authorities: Mutex::new(HashMap::new()),
            desktop_observations: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn scope(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<ComputerScope, String> {
        self.ensure_open()?;
        validate_scope_id(workspace_id)?;
        validate_scope_id(agent_id)?;
        let mut digest = Sha256::new();
        digest.update(b"fable-local-computer-v1\0");
        digest.update(workspace_id.as_bytes());
        digest.update(b"\0");
        digest.update(agent_id.as_bytes());
        let key = hex::encode(digest.finalize());
        let directory = self.root.join(&key[..32]);
        if !directory.starts_with(&self.root) {
            return Err("The local computer scope is invalid.".into());
        }
        Ok(ComputerScope {
            key: key[..32].to_string(),
            computer_id: format!("local-{}", &key[..24]),
            directory,
        })
    }

    pub(crate) fn validate_target(&self, workspace_id: &str, agent_id: &str) -> Result<(), String> {
        self.ensure_open()?;
        validate_scope_id(agent_id)?;
        let scope = crate::authorized_scope::command_scope(
            Some(workspace_id.into()),
            None,
            crate::authorized_scope::ScopeAccess::Write,
        )?;
        let snapshot: Option<crate::models::RuntimeSnapshot> =
            crate::store::read_workspace_document(&self.snapshot_path, &scope.data)?;
        if !snapshot
            .is_some_and(|snapshot| snapshot.agents.iter().any(|agent| agent.id == agent_id))
        {
            return Err(
                "Choose a saved agent in this workspace before accessing its computer.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn validate_viewer_generation(
        &self,
        workspace_id: &str,
        agent_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        self.authority_for(workspace_id, agent_id)?
            .check_generation(generation)
            .map(|_| ())
    }

    pub(crate) fn pause_disconnected_viewer(
        &self,
        workspace_id: &str,
        agent_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        self.validate_target(workspace_id, agent_id)?;
        let authority = self.authority_for(workspace_id, agent_id)?;
        authority.pause_disconnected(generation)
    }

    pub(crate) fn authority_for(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<Arc<ComputerAuthority>, String> {
        self.authority(&self.scope(workspace_id, agent_id)?)
    }

    fn authority(&self, scope: &ComputerScope) -> Result<Arc<ComputerAuthority>, String> {
        let mut authorities = self
            .authorities
            .lock()
            .map_err(|_| "Computer control state is unavailable.".to_string())?;
        self.ensure_open()?;
        if let Some(authority) = authorities.get(&scope.key) {
            return Ok(authority.clone());
        }
        let cancel_scope = scope.clone();
        let authority = ComputerAuthority::load_with_plugins(
            &scope.directory,
            Some(Arc::new(move || cancel_external_operations(&cancel_scope))),
            self.plugins.bits.clone(),
        )?;
        authorities.insert(scope.key.clone(), authority.clone());
        Ok(authority)
    }

    fn ensure_open(&self) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            Err("Mivlet is closing. Computer actions are paused.".into())
        } else {
            Ok(())
        }
    }

    pub(crate) fn with_agent_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_scoped_files(
            workspace_id,
            agent_id,
            expected_generation,
            false,
            operation,
        )
    }

    /// Admit an asynchronous agent operation while preserving the same plugin,
    /// lease, generation, cancellation, and drain semantics as file/browser work.
    pub(crate) fn begin_agent_operation(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
    ) -> Result<authority::OperationTicket, String> {
        self.validate_target(workspace_id, agent_id)?;
        self.authority_for(workspace_id, agent_id)?
            .begin_agent(expected_generation)
    }

    pub(crate) fn with_artifact_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_scoped_files(workspace_id, agent_id, expected_generation, true, operation)
    }

    fn with_scoped_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        artifact: bool,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let root = self.tool_workspace_root(workspace_id, agent_id)?;
        let authority = self.authority_for(workspace_id, agent_id)?;
        let ticket = if artifact {
            authority.begin_artifact(expected_generation)?
        } else {
            authority.begin_agent(expected_generation)?
        };
        ticket.check()?;
        // Revocation drains this admitted operation before human input is enabled.
        let result = operation(&root);
        ticket.finish(result)
    }

    pub(crate) fn tool_workspace_root(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<PathBuf, String> {
        let scope = self.scope(workspace_id, agent_id)?;
        let workspace = scope.directory.join("workspace");
        if !workspace.is_dir() {
            return Err("Set up this agent's local computer before using its files.".into());
        }
        if !workspace.starts_with(&self.root) {
            return Err("The agent computer workspace is invalid.".into());
        }
        crate::paths::strict_canonicalize(&workspace)
            .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
        Ok(workspace)
    }

    pub(crate) async fn navigate_for_agent(
        self: Arc<Self>,
        workspace_id: String,
        agent_id: String,
        raw_url: String,
        expected_generation: u64,
    ) -> Result<LocalBrowserAgentResult, String> {
        let url = normalize_agent_navigation(&raw_url)?;
        let scope = self.scope(&workspace_id, &agent_id)?;
        if !scope.directory.join("workspace").is_dir() {
            return Err("Set up this agent's local computer before using its browser.".into());
        }
        ensure_browser_session(self.clone(), scope, Some((expected_generation, true))).await?;
        let scope = self.scope(&workspace_id, &agent_id)?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?
            .get(&scope.key)
            .cloned()
            .ok_or_else(|| "The agent browser is not running.".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "The agent browser state is unavailable.".to_string())?;
            let operation = session.authority.begin_browser(expected_generation)?;
            operation.check()?;
            browser_tools::follow_active_tab(&mut session)?;
            session.observation = None;
            container::focus_browser(&scope)?;
            session
                .tab
                .activate()
                .map_err(|_| "The browser could not show its active tab.".to_string())?;
            session
                .tab
                .navigate_to(&url)
                .map_err(|_| "The local browser could not open that page.".to_string())?;
            let _ = session.tab.wait_until_navigated();
            operation.finish(agent_result_from_session(&scope, &session))
        })
        .await
        .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
    }

    pub(crate) async fn observe_for_agent(
        self: Arc<Self>,
        workspace_id: String,
        agent_id: String,
        expected_generation: u64,
    ) -> Result<LocalBrowserAgentObservation, String> {
        let scope = self.scope(&workspace_id, &agent_id)?;
        if !scope.directory.join("workspace").is_dir() {
            return Err("Set up this agent's local computer before using its browser.".into());
        }
        ensure_browser_session(self.clone(), scope, Some((expected_generation, true))).await?;
        let scope = self.scope(&workspace_id, &agent_id)?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?
            .get(&scope.key)
            .cloned()
            .ok_or_else(|| "The agent browser is not running.".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "The agent browser state is unavailable.".to_string())?;
            let operation = session.authority.begin_browser(expected_generation)?;
            operation.check()?;
            operation.finish(observe_agent_controls(&scope, &mut session))
        })
        .await
        .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn act_for_agent(
        self: Arc<Self>,
        workspace_id: String,
        agent_id: String,
        observation_id: String,
        control_ref: String,
        control_role: String,
        control_name: String,
        action: String,
        value: Option<String>,
        key: Option<String>,
        expected_generation: u64,
    ) -> Result<LocalBrowserAgentResult, String> {
        let scope = self.scope(&workspace_id, &agent_id)?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?
            .get(&scope.key)
            .cloned()
            .ok_or_else(|| "The agent browser is not running.".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "The agent browser state is unavailable.".to_string())?;
            let operation = session.authority.begin_browser(expected_generation)?;
            operation.check()?;
            let observation = session
                .observation
                .take()
                .ok_or_else(|| "Observe the local browser again before acting.".to_string())?;
            if observation.id != observation_id || observation.generation != operation.generation {
                return Err("That local browser observation is stale.".into());
            }
            let control = observation
                .controls
                .get(&control_ref)
                .ok_or_else(|| "That local browser control is stale.".to_string())?;
            if control.role != control_role || control.name != control_name {
                return Err("The observed local browser control changed.".into());
            }
            if !control.actions.iter().any(|allowed| allowed == &action) {
                return Err("That action is not allowed for the observed browser control.".into());
            }
            validate_observed_control_action(control, &action, value.as_deref(), key.as_deref())?;
            container::focus_browser(&scope)?;
            session
                .tab
                .activate()
                .map_err(|_| "The browser could not show the observed tab.".to_string())?;
            if action == "upload" {
                browser_tools::upload_to_observed_control(
                    &scope,
                    &session,
                    &control_ref,
                    &control_name,
                    value.as_deref().unwrap_or_default(),
                )?;
            } else {
                perform_agent_control_action(
                    &session,
                    &control_ref,
                    &control_role,
                    &control_name,
                    &action,
                    value.as_deref(),
                    key.as_deref(),
                )?;
            }
            if matches!(action.as_str(), "click" | "press" | "select") {
                let _ = session.tab.wait_until_navigated();
            }
            operation.finish(agent_result_from_session(&scope, &session))
        })
        .await
        .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn tab_for_agent(
        self: Arc<Self>,
        workspace_id: String,
        agent_id: String,
        observation_id: String,
        action: String,
        tab_ref: Option<String>,
        url: Option<String>,
        expected_generation: u64,
    ) -> Result<LocalBrowserAgentResult, String> {
        browser_tools::validate_tab_arguments(&action, tab_ref.as_deref(), url.as_deref())?;
        let scope = self.scope(&workspace_id, &agent_id)?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?
            .get(&scope.key)
            .cloned()
            .ok_or_else(|| "Reconnect this computer before using its browser.".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "The local browser state is unavailable.".to_string())?;
            let operation = session.authority.begin_browser(expected_generation)?;
            let observation = session
                .observation
                .take()
                .ok_or_else(|| "Observe the browser before changing tabs.".to_string())?;
            if observation.id != observation_id || observation.generation != operation.generation {
                return Err("That browser tab observation is stale. Observe again.".into());
            }
            operation.check()?;
            container::focus_browser(&scope)?;
            browser_tools::act_on_tab(
                &mut session,
                observation,
                &action,
                tab_ref.as_deref(),
                url.as_deref(),
            )?;
            operation.finish(agent_result_from_session(&scope, &session))
        })
        .await
        .map_err(|_| "The browser tab task stopped unexpectedly.".to_string())?
    }

    pub(crate) async fn run_shell_for_agent(
        self: Arc<Self>,
        workspace_id: String,
        agent_id: String,
        command: String,
        expected_generation: u64,
    ) -> Result<LocalComputerShellResult, String> {
        let scope = self.scope(&workspace_id, &agent_id)?;
        if !scope.directory.join("workspace").is_dir() {
            return Err("Set up this agent's local computer before using its terminal.".into());
        }
        ensure_browser_session(
            self.clone(),
            scope.clone(),
            Some((expected_generation, false)),
        )
        .await?;
        let authority = self.authority(&scope)?;
        tauri::async_runtime::spawn_blocking(move || {
            let operation = authority.begin_agent(expected_generation)?;
            operation.check()?;
            let result =
                container::run_shell_cancellable(&scope, &command, operation.cancellation());
            operation.finish(result)
        })
        .await
        .map_err(|_| "The isolated terminal task stopped unexpectedly.".to_string())?
    }
}

fn sanitize_agent_result_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return "unavailable".into();
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return "unavailable".into();
    }
    if url.set_username("").is_err() || url.set_password(None).is_err() {
        return "unavailable".into();
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn sanitize_browser_title(value: String) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded = compact.chars().take(160).collect::<String>();
    if bounded.is_empty() {
        "Local browser".into()
    } else {
        bounded
    }
}

fn observe_agent_controls(
    scope: &ComputerScope,
    session: &mut LocalBrowserSession,
) -> Result<LocalBrowserAgentObservation, String> {
    browser_tools::follow_active_tab(session)?;
    session.observation_counter = session.observation_counter.saturating_add(1);
    let mut digest = Sha256::new();
    digest.update(b"fable-local-browser-observation-v1\0");
    digest.update(scope.key.as_bytes());
    digest.update(b"\0");
    digest.update(session.observation_counter.to_le_bytes());
    digest.update(b"\0");
    digest.update(Utc::now().to_rfc3339().as_bytes());
    let token = hex::encode(digest.finalize());
    let observation_id = format!("observation-{}", &token[..24]);
    let control_prefix = format!("control-{}", &token[24..48]);
    let prefix_json = serde_json::to_string(&control_prefix)
        .map_err(|_| "Mivlet could not prepare browser observation refs.".to_string())?;
    let expression = format!(
        r#"(() => {{
          const prefix = {prefix_json};
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
          const roleOf = (el) => {{
            const tag = el.tagName.toLowerCase();
            const type = clean(el.getAttribute("type")).toLowerCase();
            if (tag === "select") return el.multiple ? "listbox" : "combobox";
            if (type === "file") return "file";
            const explicit = clean(el.getAttribute("role"));
            if (explicit) return explicit;
            if (tag === "a") return "link";
            if (tag === "button" || type === "button" || type === "submit") return "button";
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            return "textbox";
          }};
          const nameOf = (el, role) => {{
            const labelledBy = clean(el.getAttribute("aria-labelledby"));
            const labelled = labelledBy ? clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ")) : "";
            const ownLabel = el.id ? clean(document.querySelector(`label[for="${{CSS.escape(el.id)}}"]`)?.textContent) : "";
            return clean(el.getAttribute("aria-label")) || labelled || ownLabel || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || (role !== "textbox" && role !== "file" ? clean(el.innerText) : "") || `Unnamed ${{role}}`;
          }};
          const isSecret = (el) => {{
            const hint = [el.getAttribute("type"), el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label")].join(" ").toLowerCase();
            return el.getAttribute("type")?.toLowerCase() === "password" || /(password|passcode|one.?time|verification|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|otp)/i.test(hint);
          }};
          document.querySelectorAll("[data-fable-control]").forEach((el) => el.removeAttribute("data-fable-control"));
          const output = [];
          const candidates = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]"));
          for (const el of candidates) {{
            if (output.length >= 40 || isSecret(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
            if (el instanceof HTMLSelectElement && el.multiple) continue;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
            const role = roleOf(el);
            const name = nameOf(el, role);
            if (!name || name.startsWith("Unnamed ")) continue;
            const isNativeSelect = el instanceof HTMLSelectElement;
            const options = isNativeSelect
              ? Array.from(new Set(Array.from(el.options)
                  .filter((option) => !option.disabled && !option.hidden && !option.closest("optgroup")?.disabled)
                  .map((option) => clean(option.label || option.textContent))
                  .filter(Boolean))).slice(0, 50)
              : [];
            if (isNativeSelect && options.length === 0) continue;
            const actions = role === "file" ? ["upload"] : isNativeSelect ? ["select"] : role === "textbox" ? ["fill", "press"] : ["click", "press"];
            const ref = `${{prefix}}-${{output.length}}`;
            el.setAttribute("data-fable-control", ref);
            output.push({{ ref, role, name, actions, options }});
          }}
          return JSON.stringify(output);
        }})()"#
    );
    let remote = session
        .tab
        .evaluate(&expression, false)
        .map_err(|_| "Mivlet could not inspect visible browser controls.".to_string())?;
    let encoded = remote
        .value
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "The local browser returned no control observation.".to_string())?;
    let controls: Vec<LocalBrowserAgentControl> = serde_json::from_str(&encoded)
        .map_err(|_| "The local browser returned an invalid control observation.".to_string())?;
    if controls.len() > 40 {
        return Err("The local browser returned too many controls.".into());
    }
    let mut retained = HashMap::new();
    for control in &controls {
        validate_agent_control_observation(control, &control_prefix)?;
        if retained
            .insert(
                control.control_ref.clone(),
                LocalBrowserObservedControl {
                    role: control.role.clone(),
                    name: control.name.clone(),
                    actions: control.actions.clone(),
                    options: control.options.clone(),
                },
            )
            .is_some()
        {
            return Err("The local browser returned duplicate controls.".into());
        }
    }
    let generation = session.authority.snapshot()?.generation;
    let page = browser_tools::observe_page(session, &observation_id)?;
    session.observation = Some(LocalBrowserObservationState {
        id: observation_id.clone(),
        generation,
        controls: retained,
        tabs: page.retained_tabs,
    });
    Ok(LocalBrowserAgentObservation {
        observation_id,
        computer_id: scope.computer_id.clone(),
        current_url: sanitize_agent_result_url(&session.tab.get_url()),
        title: sanitize_browser_title(
            session
                .tab
                .get_title()
                .unwrap_or_else(|_| "Local browser".into()),
        ),
        trust: "external-untrusted",
        generation,
        controls,
        text: page.text,
        tabs: page.tabs,
        active_tab_ref: page.active_tab_ref,
        downloads: container::download_status(scope).unwrap_or_else(|_| {
            serde_json::json!({"state":"unavailable", "message":"Download status is unavailable. Reconnect before downloading more files."})
        }),
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn validate_agent_control_observation(
    control: &LocalBrowserAgentControl,
    control_prefix: &str,
) -> Result<(), String> {
    let actions = control.actions.iter().collect::<HashSet<_>>();
    let options = control.options.iter().collect::<HashSet<_>>();
    let has_select = control.actions.iter().any(|action| action == "select");
    if !control.control_ref.starts_with(control_prefix)
        || control.role.is_empty()
        || control.role.chars().count() > 40
        || control.role.chars().any(char::is_control)
        || control.name.is_empty()
        || control.name.chars().count() > 120
        || control.name.chars().any(char::is_control)
        || control.actions.is_empty()
        || control.actions.len() > 2
        || actions.len() != control.actions.len()
        || control.actions.iter().any(|action| {
            !matches!(
                action.as_str(),
                "click" | "fill" | "press" | "select" | "upload"
            )
        })
        || control.options.len() > 50
        || options.len() != control.options.len()
        || control.options.iter().any(|option| {
            option.is_empty()
                || option.chars().count() > 120
                || option.chars().any(char::is_control)
        })
        || (control.actions.iter().any(|action| action == "upload")
            && (control.role != "file" || control.actions != ["upload"]))
        || has_select == control.options.is_empty()
        || (has_select
            && (control.role != "combobox"
                || control.actions.len() != 1
                || control.actions[0] != "select"))
    {
        return Err("The local browser returned an invalid control.".into());
    }
    Ok(())
}

fn validate_observed_control_action(
    control: &LocalBrowserObservedControl,
    action: &str,
    value: Option<&str>,
    key: Option<&str>,
) -> Result<(), String> {
    if !control.actions.iter().any(|allowed| allowed == action) {
        return Err("That action is not allowed for the observed browser control.".into());
    }
    let valid = match action {
        "click" => value.is_none() && key.is_none(),
        "fill" => value.is_some() && key.is_none(),
        "upload" => {
            control.role == "file"
                && value.is_some_and(|value| !value.trim().is_empty())
                && key.is_none()
        }
        "press" => value.is_none() && key.is_some(),
        "select" => {
            key.is_none()
                && control.role == "combobox"
                && value.is_some_and(|label| control.options.iter().any(|option| option == label))
        }
        _ => false,
    };
    if !valid {
        return Err("The local browser action does not match the observed control.".into());
    }
    Ok(())
}

fn perform_agent_control_action(
    session: &LocalBrowserSession,
    control_ref: &str,
    control_role: &str,
    control_name: &str,
    action: &str,
    value: Option<&str>,
    key: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = value {
        if value.chars().count() > 2_000
            || value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err("The local browser action value is invalid.".into());
        }
    }
    let allowed_key = key.is_none_or(|key| {
        matches!(
            key,
            "Enter"
                | "Escape"
                | "Tab"
                | "ArrowUp"
                | "ArrowDown"
                | "ArrowLeft"
                | "ArrowRight"
                | "Space"
        )
    });
    let arguments_valid = match action {
        "click" => value.is_none() && key.is_none(),
        "fill" | "select" => value.is_some() && key.is_none(),
        "press" => value.is_none() && key.is_some(),
        _ => false,
    };
    if !allowed_key || !arguments_valid {
        return Err("The local browser action arguments are incomplete.".into());
    }
    let input = serde_json::json!({
        "ref": control_ref,
        "role": control_role,
        "name": control_name,
        "action": action,
        "value": value,
    });
    let input_json = serde_json::to_string(&input)
        .map_err(|_| "Mivlet could not prepare the browser action.".to_string())?;
    let expression = format!(
        r#"(() => {{
          const input = {input_json};
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
          const roleOf = (el) => {{
            const tag = el.tagName.toLowerCase();
            const type = clean(el.getAttribute("type")).toLowerCase();
            if (tag === "select") return el.multiple ? "listbox" : "combobox";
            if (type === "file") return "file";
            const explicit = clean(el.getAttribute("role"));
            if (explicit) return explicit;
            if (tag === "a") return "link";
            if (tag === "button" || type === "button" || type === "submit") return "button";
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            return "textbox";
          }};
          const nameOf = (el, role) => {{
            const labelledBy = clean(el.getAttribute("aria-labelledby"));
            const labelled = labelledBy ? clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ")) : "";
            const ownLabel = el.id ? clean(document.querySelector(`label[for="${{CSS.escape(el.id)}}"]`)?.textContent) : "";
            return clean(el.getAttribute("aria-label")) || labelled || ownLabel || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || (role !== "textbox" && role !== "file" ? clean(el.innerText) : "") || `Unnamed ${{role}}`;
          }};
          const isSecret = (el) => {{
            const hint = [el.getAttribute("type"), el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label")].join(" ").toLowerCase();
            return el.getAttribute("type")?.toLowerCase() === "password" || /(password|passcode|one.?time|verification|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|otp)/i.test(hint);
          }};
          const el = Array.from(document.querySelectorAll("[data-fable-control]")).find((candidate) => candidate.getAttribute("data-fable-control") === input.ref);
          if (!el || isSecret(el)) return JSON.stringify({{ ok: false }});
          const role = roleOf(el);
          if (role !== input.role || nameOf(el, role) !== input.name) return JSON.stringify({{ ok: false }});
          if (input.action === "click") {{ el.click(); return JSON.stringify({{ ok: true }}); }}
          if (input.action === "fill") {{
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return JSON.stringify({{ ok: false }});
            const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) return JSON.stringify({{ ok: false }});
            el.focus();
            setter.call(el, input.value);
            el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: null }}));
            el.dispatchEvent(new Event("change", {{ bubbles: true }}));
            return JSON.stringify({{ ok: true }});
          }}
          if (input.action === "select") {{
            if (!(el instanceof HTMLSelectElement) || el.multiple) return JSON.stringify({{ ok: false }});
            const matches = Array.from(el.options).filter((option) =>
              !option.disabled && !option.hidden && !option.closest("optgroup")?.disabled && clean(option.label || option.textContent) === input.value
            );
            if (matches.length !== 1) return JSON.stringify({{ ok: false }});
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")?.set;
            if (!setter) return JSON.stringify({{ ok: false }});
            el.focus();
            setter.call(el, matches[0].index);
            el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertReplacementText", data: null }}));
            el.dispatchEvent(new Event("change", {{ bubbles: true }}));
            return JSON.stringify({{ ok: true }});
          }}
          if (input.action === "press") {{ el.focus(); return JSON.stringify({{ ok: true, press: true }}); }}
          return JSON.stringify({{ ok: false }});
        }})()"#
    );
    let remote = session
        .tab
        .evaluate(&expression, false)
        .map_err(|_| "The local browser could not use that control.".to_string())?;
    let encoded = remote
        .value
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "The local browser returned no action result.".to_string())?;
    let result: serde_json::Value = serde_json::from_str(&encoded)
        .map_err(|_| "The local browser returned an invalid action result.".to_string())?;
    if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("The observed browser control changed. Observe the page again.".into());
    }
    if action == "press" {
        let key =
            key.ok_or_else(|| "The local browser action arguments are incomplete.".to_string())?;
        session
            .tab
            .press_key(key)
            .map_err(|_| "The local browser could not press that key.".to_string())?;
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct ComputerScope {
    key: String,
    computer_id: String,
    directory: PathBuf,
}

fn validate_scope_id(value: &str) -> Result<(), String> {
    if !(3..=160).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        return Err("The local computer scope is invalid.".into());
    }
    Ok(())
}

pub(crate) fn normalize_user_navigation(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_URL_CHARACTERS {
        return Err("Enter a valid page address.".into());
    }
    let mut url = Url::parse(value).map_err(|_| "Enter a valid page address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("The local browser accepts credential-free HTTP or HTTPS addresses.".into());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn normalize_agent_navigation(value: &str) -> Result<String, String> {
    let normalized = normalize_user_navigation(value)?;
    let url = Url::parse(&normalized).map_err(|_| "Enter a valid page address.".to_string())?;
    let contains_sensitive_query = url.query_pairs().any(|(key, _)| {
        let compact = key
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        matches!(
            compact.as_str(),
            "code"
                | "token"
                | "accesstoken"
                | "refreshtoken"
                | "idtoken"
                | "key"
                | "apikey"
                | "secret"
                | "password"
                | "passcode"
                | "credential"
                | "authorization"
                | "auth"
                | "session"
                | "signature"
                | "sig"
        )
    });
    if contains_sensitive_query {
        return Err("Agent browser addresses cannot contain credential or authorization parameters. Take control to complete sign-in yourself.".into());
    }
    Ok(normalized)
}

async fn ensure_browser_session(
    state: Arc<LocalComputerState>,
    scope: ComputerScope,
    agent_generation: Option<(u64, bool)>,
) -> Result<(), String> {
    let key = scope.key.clone();
    let launch_gate = {
        let mut gates = state
            .launch_gates
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?;
        gates
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let launch_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _launch_guard = launch_gate
            .lock()
            .map_err(|_| "The local computer launch state is unavailable.".to_string())?;
        let authority = launch_state.authority(&scope)?;
        let admission = agent_generation
            .map(|(generation, browser)| {
                if browser {
                    authority.begin_browser(generation)
                } else {
                    authority.begin_agent(generation)
                }
            })
            .transpose()?;
        let existing = launch_state
            .sessions
            .lock()
            .map_err(|_| "The local computer state is unavailable.".to_string())?
            .get(&key)
            .cloned();
        let healthy = existing
            .as_ref()
            .map(|session| {
                let session = session
                    .lock()
                    .map_err(|_| "The agent browser state is unavailable.".to_string())?;
                Ok::<_, String>(session.tab.get_target_info().is_ok())
            })
            .transpose()?
            .unwrap_or(false);
        if !healthy {
            let expected_generation = agent_generation
                .map(|(generation, _)| generation)
                .unwrap_or(authority.snapshot()?.generation);
            if let Some(admission) = admission {
                admission.finish(Ok(()))?;
            }
            if existing.is_some() {
                let generation = authority.revoke(expected_generation)?;
                let result = cancel_external_operations(&scope)
                    .and_then(|()| authority.drain(generation, Duration::from_secs(20)))
                    .and_then(|()| cancel_external_operations(&scope));
                if let Err(error) = result {
                    authority.abandon_transition(generation);
                    return Err(error);
                }
                authority.complete_transition(generation, LocalComputerController::Paused)?;
            }
            let launch_generation = authority.snapshot()?.generation;
            let session = launch_browser(&scope, &launch_state.image_context, authority.clone())?;
            authority.check_generation(launch_generation)?;
            launch_state
                .sessions
                .lock()
                .map_err(|_| "The local computer state is unavailable.".to_string())?
                .insert(key, Arc::new(Mutex::new(session)));
        } else if let Some(admission) = admission {
            admission.finish(Ok(()))?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Mivlet could not start the local browser.".to_string())?
}

fn ensure_scope_directories(scope: &ComputerScope) -> Result<(), String> {
    std::fs::create_dir_all(&scope.directory)
        .map_err(|_| "Mivlet could not create the agent computer workspace.".to_string())?;
    crate::paths::strict_canonicalize(&scope.directory)
        .map_err(|_| "The agent computer directory failed its security check.".to_string())?;
    let workspace = scope.directory.join("workspace");
    std::fs::create_dir_all(&workspace)
        .map_err(|_| "Mivlet could not create the agent computer workspace.".to_string())?;
    crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "A agent computer directory failed its security check.".to_string())?;
    Ok(())
}

fn launch_browser(
    scope: &ComputerScope,
    image_context: &Path,
    authority: Arc<ComputerAuthority>,
) -> Result<LocalBrowserSession, String> {
    ensure_scope_directories(scope)?;
    container::ensure_running(scope, image_context)?;
    if authority.snapshot()?.controller != LocalComputerController::Agent {
        // A newly started native process has no inherited operation tickets.
        // Remove guest jobs left by the previous process before exposing its
        // restored paused desktop or accepting an explicit human transition.
        cancel_external_operations(scope)?;
    }
    let debugger_url = container::debugger_websocket_url(scope)?;
    let browser = Browser::connect_with_timeout(debugger_url, Duration::from_secs(24 * 60 * 60))
        .map_err(|_| {
            "Mivlet could not connect to Chromium inside the agent computer.".to_string()
        })?;
    browser.set_default_timeout(Duration::from_secs(15));
    let tabs = browser.get_tabs();
    let tab = tabs
        .lock()
        .ok()
        .and_then(|tabs| tabs.first().cloned())
        .map(Ok)
        .unwrap_or_else(|| browser.new_tab())
        .map_err(|_| "Mivlet could not open the browser inside the agent computer.".to_string())?;
    tab.set_default_timeout(Duration::from_secs(15));
    Ok(LocalBrowserSession {
        _browser: browser,
        tab,
        authority,
        browser_product: "Chromium in Docker/WSL".into(),
        observation_counter: 0,
        observation: None,
    })
}

fn snapshot_from_session(
    scope: &ComputerScope,
    session: &mut LocalBrowserSession,
) -> Result<LocalBrowserSnapshot, String> {
    let authority = session.authority.snapshot()?;
    if authority.transitioning {
        return Err("Computer control is changing. Wait for the previous action to stop.".into());
    }
    let viewport = LocalBrowserViewportSnapshot {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
    };
    let (can_go_back, can_go_forward) = browser_history_availability(session)?;
    let bytes = container::capture_desktop(scope)?;
    let current_url = session.tab.get_url();
    let title = sanitize_browser_title(
        session
            .tab
            .get_title()
            .unwrap_or_else(|_| "Local browser".into()),
    );
    Ok(LocalBrowserSnapshot {
        computer_id: scope.computer_id.clone(),
        current_url,
        title,
        preview_data_url: format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)),
        viewport,
        can_go_back,
        can_go_forward,
        controller: session
            .authority
            .check_generation(authority.generation)?
            .controller
            .as_str(),
        generation: authority.generation,
        lease_expires_at: authority.lease_expires_at,
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn history_availability(current_index: u32, entry_count: usize) -> (bool, bool) {
    let Ok(current_index) = usize::try_from(current_index) else {
        return (false, false);
    };
    if current_index >= entry_count {
        return (false, false);
    }
    (current_index > 0, current_index + 1 < entry_count)
}

fn browser_history_availability(session: &LocalBrowserSession) -> Result<(bool, bool), String> {
    let history = session
        .tab
        .call_method(GetNavigationHistory(None))
        .map_err(|_| "Mivlet could not inspect the local browser history.".to_string())?;
    Ok(history_availability(
        history.current_index,
        history.entries.len(),
    ))
}

fn agent_result_from_session(
    scope: &ComputerScope,
    session: &LocalBrowserSession,
) -> Result<LocalBrowserAgentResult, String> {
    Ok(LocalBrowserAgentResult {
        computer_id: scope.computer_id.clone(),
        current_url: sanitize_agent_result_url(&session.tab.get_url()),
        title: sanitize_browser_title(
            session
                .tab
                .get_title()
                .unwrap_or_else(|_| "Local browser".into()),
        ),
        trust: "external-untrusted",
        generation: session.authority.snapshot()?.generation,
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn computer_snapshot(
    state: &LocalComputerState,
    workspace_id: String,
    agent_id: String,
) -> Result<LocalComputerSnapshot, String> {
    let scope = state.scope(&workspace_id, &agent_id)?;
    let container_status = container::status(&scope);
    let session = state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned();
    let authority = state.authority(&scope)?.snapshot()?;
    let browser_product = session.as_ref().and_then(|session| {
        session
            .try_lock()
            .ok()
            .map(|session| session.browser_product.clone())
    });
    let lifecycle = if !container_status.engine_available {
        "degraded"
    } else if !container_status.container_exists {
        "unprovisioned"
    } else if container_status.suspended {
        "sleeping"
    } else if !container_status.running {
        "stopped"
    } else if !container_status.healthy {
        "degraded"
    } else {
        "ready"
    };
    Ok(LocalComputerSnapshot {
        plugins: state.plugins.snapshot(),
        computer_id: scope.computer_id,
        workspace_id,
        agent_id,
        locality: "local",
        backend: "docker",
        isolation: "linux-container",
        lifecycle,
        browser_available: container_status.engine_available,
        browser_active: container_status.running
            && !container_status.suspended
            && session.is_some(),
        controller: authority.controller.as_str(),
        generation: authority.generation,
        lease_expires_at: authority.lease_expires_at,
        capabilities: vec![
            "persistent-files",
            "persistent-home",
            "desktop-observe",
            "desktop-control",
            "browser-observe",
            "browser-control",
            "terminal",
            "file-manager",
            "process-execution",
        ],
        browser_product: browser_product.or_else(|| {
            container_status
                .container_exists
                .then(|| "Chromium in Docker/WSL".into())
        }),
        message: if authority.transitioning {
            Some("Stopping the previous computer action before changing control.".into())
        } else if !container_status.engine_available {
            Some("Start Docker Desktop with its WSL 2 Linux engine to use this computer.".into())
        } else if !container_status.image_available && !container_status.container_exists {
            Some("Set up this computer to build its private Linux desktop.".into())
        } else if container_status.suspended {
            Some("This computer is sleeping after being idle. Start it to restore the open applications.".into())
        } else if container_status.container_exists && !container_status.running {
            Some("Start this agent's private Linux desktop.".into())
        } else if authority.controller == LocalComputerController::Paused {
            Some("Computer actions and agent observation are paused. Explicitly return control when ready.".into())
        } else if container_status.running && !container_status.healthy {
            Some("This agent's Linux desktop is still starting.".into())
        } else {
            None
        },
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn workspace_files_snapshot(scope: &ComputerScope) -> Result<LocalComputerFilesSnapshot, String> {
    let workspace = scope.directory.join("workspace");
    let canonical_root = crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let mut pending = VecDeque::from([(canonical_root.clone(), 0_usize)]);
    let mut entries = Vec::new();
    let mut truncated = false;

    while let Some((directory, depth)) = pending.pop_front() {
        let canonical_directory = crate::paths::strict_canonicalize(&directory)
            .map_err(|_| "A agent folder failed its security check.".to_string())?;
        if !canonical_directory.starts_with(&canonical_root) {
            return Err("A agent folder escaped its private workspace.".into());
        }
        let mut children = std::fs::read_dir(&canonical_directory)
            .map_err(|_| "Mivlet could not list this agent's files.".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Mivlet could not list this agent's files.".to_string())?;
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for child in children {
            if entries.len() >= MAX_FILE_ENTRIES {
                truncated = true;
                break;
            }
            let path = child.path();
            if crate::paths::contains_symlink(&path) {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                truncated = true;
                continue;
            };
            if !metadata.is_file() && !metadata.is_dir() {
                continue;
            }
            let relative = path
                .strip_prefix(&canonical_root)
                .map_err(|_| "A agent file escaped its private workspace.".to_string())?;
            let Some(relative_path) = relative.to_str() else {
                continue;
            };
            let relative_path = relative_path.replace('\\', "/");
            let Some(name) = child.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if relative_path.is_empty()
                || relative_path.chars().count() > 512
                || contains_unsafe_display_characters(&relative_path)
                || name.is_empty()
                || name.chars().count() > 160
                || contains_unsafe_display_characters(&name)
            {
                truncated = true;
                continue;
            }
            let is_directory = metadata.is_dir();
            entries.push(LocalComputerFileEntry {
                path: relative_path,
                name,
                kind: if is_directory { "directory" } else { "file" },
                size_bytes: metadata
                    .is_file()
                    .then_some(metadata.len().min(MAX_SAFE_UI_BYTES)),
            });
            if is_directory {
                if depth < MAX_FILE_DEPTH {
                    pending.push_back((path, depth + 1));
                } else {
                    truncated = true;
                }
            }
        }
        if entries.len() >= MAX_FILE_ENTRIES {
            truncated = true;
            break;
        }
    }
    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(LocalComputerFilesSnapshot {
        computer_id: scope.computer_id.clone(),
        entries,
        truncated,
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn contains_unsafe_display_characters(value: &str) -> bool {
    value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
    })
}

fn workspace_file_preview(
    scope: &ComputerScope,
    requested_path: &str,
) -> Result<LocalComputerFilePreview, String> {
    if requested_path.is_empty()
        || requested_path.chars().count() > 512
        || contains_unsafe_display_characters(requested_path)
    {
        return Err("Choose a valid relative file path.".into());
    }
    let workspace = scope.directory.join("workspace");
    let canonical_root = crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let confined = crate::tools::confine_path(requested_path, &workspace)
        .map_err(|_| "That file is outside this agent's private workspace.".to_string())?;
    let canonical_file = crate::paths::strict_canonicalize(&confined)
        .map_err(|_| "Choose an existing private file.".to_string())?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("That file is outside this agent's private workspace.".into());
    }
    let metadata = std::fs::metadata(&canonical_file)
        .map_err(|_| "Mivlet could not inspect that private file.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular text file to preview.".into());
    }
    let relative = canonical_file
        .strip_prefix(&canonical_root)
        .map_err(|_| "That file is outside this agent's private workspace.".to_string())?;
    let path = relative
        .to_str()
        .map(|value| value.replace('\\', "/"))
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= 512
                && !contains_unsafe_display_characters(value)
        })
        .ok_or_else(|| "That private file name cannot be displayed safely.".to_string())?;
    let mut file = std::fs::File::open(&canonical_file)
        .map_err(|_| "Mivlet could not open that private file.".to_string())?;
    let mut bytes = Vec::with_capacity(MAX_FILE_PREVIEW_BYTES + 1);
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, (MAX_FILE_PREVIEW_BYTES + 1) as u64),
        &mut bytes,
    )
    .map_err(|_| "Mivlet could not read that private file.".to_string())?;
    let truncated = bytes.len() > MAX_FILE_PREVIEW_BYTES;
    bytes.truncate(MAX_FILE_PREVIEW_BYTES);
    let content = match std::str::from_utf8(&bytes) {
        Ok(value) => value,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| "Only UTF-8 text files can be previewed.".to_string())?
        }
        Err(_) => return Err("Only UTF-8 text files can be previewed.".into()),
    };
    if content
        .chars()
        .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
    {
        return Err("Only plain UTF-8 text files can be previewed.".into());
    }
    Ok(LocalComputerFilePreview {
        computer_id: scope.computer_id.clone(),
        path,
        content: content.to_string(),
        size_bytes: metadata.len().min(MAX_SAFE_UI_BYTES),
        truncated,
        updated_at: Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn local_computer_status(
    workspace_id: String,
    agent_id: String,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    state.validate_target(&workspace_id, &agent_id)?;
    computer_snapshot(&state, workspace_id, agent_id)
}

#[tauri::command]
pub async fn local_computer_provision(
    workspace_id: String,
    agent_id: String,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    state.validate_target(&workspace_id, &agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&workspace_id, &agent_id)?;
    ensure_browser_session(owned_state.clone(), scope, None).await?;
    computer_snapshot(&owned_state, workspace_id, agent_id)
}

#[tauri::command]
pub async fn local_computer_files(
    target: LocalComputerTarget,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerFilesSnapshot, String> {
    state.validate_target(&target.workspace_id, &target.agent_id)?;
    let scope = state.scope(&target.workspace_id, &target.agent_id)?;
    if !scope.directory.join("workspace").is_dir() {
        return Err("Set up this agent's local computer before viewing its files.".into());
    }
    tauri::async_runtime::spawn_blocking(move || workspace_files_snapshot(&scope))
        .await
        .map_err(|_| "The local file-list task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_file_preview(
    request: LocalComputerFileRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerFilePreview, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let scope = state.scope(&request.workspace_id, &request.agent_id)?;
    if !scope.directory.join("workspace").is_dir() {
        return Err("Set up this agent's local computer before viewing its files.".into());
    }
    tauri::async_runtime::spawn_blocking(move || workspace_file_preview(&scope, &request.path))
        .await
        .map_err(|_| "The local file-preview task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_browser_navigate(
    request: LocalBrowserNavigateRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    let url = normalize_user_navigation(&request.url)?;
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "Set up this agent's local computer first.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent browser state is unavailable.".to_string())?;
        let operation = session.authority.begin_human(request.expected_generation)?;
        operation.check()?;
        session.observation = None;
        container::focus_browser(&scope)?;
        session
            .tab
            .navigate_to(&url)
            .map_err(|_| "The local browser could not open that page.".to_string())?;
        let _ = session.tab.wait_until_navigated();
        operation.renew_human()?;
        operation.finish(snapshot_from_session(&scope, &mut session))
    })
    .await
    .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_browser_snapshot(
    target: LocalComputerTarget,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    state.validate_target(&target.workspace_id, &target.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&target.workspace_id, &target.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "The agent browser is not running.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent browser state is unavailable.".to_string())?;
        snapshot_from_session(&scope, &mut session)
    })
    .await
    .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_cancel(
    request: LocalComputerCancelRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let authority = owned_state.authority(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        let generation = authority.revoke(request.expected_generation)?;
        let stopped = cancel_external_operations(&scope)
            .and_then(|()| authority.drain(generation, Duration::from_secs(20)))
            .and_then(|()| cancel_external_operations(&scope));
        if let Err(error) = stopped {
            authority.abandon_transition(generation);
            return Err(error);
        }
        authority.complete_transition(generation, LocalComputerController::Paused)?;
        computer_snapshot(&owned_state, request.workspace_id, request.agent_id)
    })
    .await
    .map_err(|_| {
        "The computer cancellation task stopped unexpectedly. Control remains paused.".to_string()
    })?
}

/// Main-window shutdown revokes every scope before waiting for any process.
/// No renderer unmount or provider turn completion is needed to stop admission.
pub(crate) async fn shutdown_all(state: Arc<LocalComputerState>) {
    if state.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    let authorities = state
        .authorities
        .lock()
        .map(|registry| registry.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let draining = authorities
        .into_iter()
        .filter_map(|authority| {
            authority
                .pause_for_shutdown()
                .ok()
                .map(|generation| (authority, generation))
        })
        .collect::<Vec<_>>();
    if let Ok(mut observations) = state.desktop_observations.lock() {
        observations.clear();
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        for (authority, generation) in draining {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let _ = authority.drain(generation, remaining);
        }
    })
    .await;
}

#[tauri::command]
pub async fn local_computer_set_controller(
    request: LocalComputerControlRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    change_controller(state.inner().clone(), request).await
}

pub(crate) async fn change_controller(
    owned_state: Arc<LocalComputerState>,
    request: LocalComputerControlRequest,
) -> Result<LocalBrowserSnapshot, String> {
    owned_state.validate_target(&request.workspace_id, &request.agent_id)?;
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let authority = owned_state.authority(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        let generation = authority.revoke(request.expected_generation)?;
        let transition = (|| {
            cancel_external_operations(&scope)?;
            authority.drain(generation, Duration::from_secs(20))?;
            // A previously admitted root launch may have created its UID1001
            // child while the first cancellation was running. Launches must
            // acknowledge their actual child before their native ticket drops.
            cancel_external_operations(&scope)?;
            let session = owned_state
                .sessions
                .lock()
                .map_err(|_| "The local computer state is unavailable.".to_string())?
                .get(&scope.key)
                .cloned()
                .ok_or_else(|| "Reconnect this computer before changing control.".to_string())?;
            let mut session = session
                .lock()
                .map_err(|_| "The agent browser state is unavailable.".to_string())?;
            session.observation = None;
            authority.complete_transition(generation, request.controller)?;
            snapshot_from_session(&scope, &mut session)
        })();
        if transition.is_err() {
            authority.abandon_transition(generation);
        }
        transition
    })
    .await
    .map_err(|_| {
        "The computer control task stopped unexpectedly. Control remains paused.".to_string()
    })?
}

#[tauri::command]
pub async fn local_browser_pointer(
    request: LocalBrowserPointerRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    if !request.x.is_finite() || !request.y.is_finite() || request.x < 0.0 || request.y < 0.0 {
        return Err("The browser pointer position is invalid.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "The agent browser is not running.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent browser state is unavailable.".to_string())?;
        let operation = session.authority.begin_human(request.expected_generation)?;
        operation.check()?;
        if request.x > f64::from(VIEWPORT_WIDTH) || request.y > f64::from(VIEWPORT_HEIGHT) {
            return Err("The pointer position is outside the live desktop.".into());
        }
        let delta = match request.action.as_str() {
            "click" => None,
            "scroll" => {
                let delta = request.delta_y.unwrap_or(0.0).clamp(-800.0, 800.0);
                if delta.abs() < 1.0 {
                    return Err("The desktop scroll amount is invalid.".into());
                }
                Some(delta)
            }
            _ => return Err("The desktop pointer action is not supported.".into()),
        };
        container::pointer(
            &scope,
            request.x.round() as u32,
            request.y.round() as u32,
            &request.action,
            delta,
        )?;
        operation.renew_human()?;
        operation.finish(snapshot_from_session(&scope, &mut session))
    })
    .await
    .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_browser_key(
    request: LocalBrowserKeyRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    if request.key.is_empty()
        || request.key.chars().count() > 16
        || request.key.chars().any(char::is_control)
    {
        return Err("The browser key is invalid.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "The agent browser is not running.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent browser state is unavailable.".to_string())?;
        let operation = session.authority.begin_human(request.expected_generation)?;
        operation.check()?;
        if request.key.chars().count() != 1
            && !matches!(
                request.key.as_str(),
                "Enter"
                    | "Tab"
                    | "Escape"
                    | "Backspace"
                    | "Delete"
                    | "ArrowUp"
                    | "ArrowDown"
                    | "ArrowLeft"
                    | "ArrowRight"
                    | "Home"
                    | "End"
                    | "PageUp"
                    | "PageDown"
            )
        {
            return Err("That desktop key is not supported.".into());
        }
        container::key(&scope, &request.key)?;
        operation.renew_human()?;
        operation.finish(snapshot_from_session(&scope, &mut session))
    })
    .await
    .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_launch_app(
    request: LocalComputerLaunchRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    if !matches!(
        request.application.as_str(),
        "browser" | "files" | "terminal" | "writer" | "spreadsheet"
    ) {
        return Err("That agent computer application is not supported.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "The agent computer is not running.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent computer state is unavailable.".to_string())?;
        let operation = session.authority.begin_human(request.expected_generation)?;
        operation.check()?;
        container::launch_application(&scope, &request.application)?;
        operation.renew_human()?;
        operation.finish(snapshot_from_session(&scope, &mut session))
    })
    .await
    .map_err(|_| "The agent application task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_browser_history(
    request: LocalBrowserHistoryRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalBrowserSnapshot, String> {
    if !matches!(request.direction.as_str(), "back" | "forward") {
        return Err("The browser history direction is not supported.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let owned_state = state.inner().clone();
    let scope = owned_state.scope(&request.workspace_id, &request.agent_id)?;
    let session = owned_state
        .sessions
        .lock()
        .map_err(|_| "The local computer state is unavailable.".to_string())?
        .get(&scope.key)
        .cloned()
        .ok_or_else(|| "The agent browser is not running.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session
            .lock()
            .map_err(|_| "The agent browser state is unavailable.".to_string())?;
        let operation = session.authority.begin_human(request.expected_generation)?;
        operation.check()?;
        container::focus_browser(&scope)?;
        let history = session
            .tab
            .call_method(GetNavigationHistory(None))
            .map_err(|_| "Mivlet could not inspect the local browser history.".to_string())?;
        let current_index = usize::try_from(history.current_index)
            .map_err(|_| "The local browser returned invalid history.".to_string())?;
        let target_index = match request.direction.as_str() {
            "back" => current_index.checked_sub(1),
            "forward" => current_index.checked_add(1),
            _ => None,
        }
        .filter(|index| *index < history.entries.len())
        .ok_or_else(|| "There is no page in that browser-history direction.".to_string())?;
        session.observation = None;
        session
            .tab
            .call_method(NavigateToHistoryEntry {
                entry_id: history.entries[target_index].id,
            })
            .map_err(|_| "The local browser could not move through its history.".to_string())?;
        let _ = session.tab.wait_until_navigated();
        operation.renew_human()?;
        operation.finish(snapshot_from_session(&scope, &mut session))
    })
    .await
    .map_err(|_| "The local browser task stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct LiveComputerCleanup(ComputerScope);
    impl Drop for LiveComputerCleanup {
        fn drop(&mut self) {
            let _ = container::cleanup_test_computer(&self.0);
        }
    }

    fn live_test_scope(state: &LocalComputerState) -> (String, String, ComputerScope) {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let suffix = hex::encode(nonce);
        let workspace_id = format!("workspace-native-test-{suffix}");
        let agent_id = format!("agent-native-test-{suffix}");
        let scope = state.scope(&workspace_id, &agent_id).unwrap();
        (workspace_id, agent_id, scope)
    }

    #[test]
    fn scope_directories_are_stable_and_agent_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let first = state.scope("workspace-one", "agent-one").unwrap();
        let replay = state.scope("workspace-one", "agent-one").unwrap();
        let second = state.scope("workspace-one", "agent-two").unwrap();
        assert_eq!(first.directory, replay.directory);
        assert_eq!(first.computer_id, replay.computer_id);
        assert_ne!(first.directory, second.directory);
        assert!(first.directory.starts_with(temp.path()));
    }

    #[test]
    fn native_shutdown_revokes_every_scope_and_prevents_new_admission() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(LocalComputerState::for_test(temp.path().to_path_buf()));
        let mut retained = Vec::new();
        for agent in ["agent-one", "agent-two"] {
            let scope = state.scope("workspace-one", agent).unwrap();
            let authority = ComputerAuthority::load(&scope.directory).unwrap();
            let ticket = authority.begin_agent(1).unwrap();
            state
                .authorities
                .lock()
                .unwrap()
                .insert(scope.key, authority.clone());
            retained.push((authority, ticket));
        }
        let owned = state.clone();
        let shutdown =
            std::thread::spawn(move || tauri::async_runtime::block_on(shutdown_all(owned)));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !state.closing.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(state.scope("workspace-one", "agent-new").is_err());
        for (authority, ticket) in retained {
            while ticket.check().is_ok() && std::time::Instant::now() < deadline {
                std::thread::yield_now();
            }
            assert!(ticket.check().is_err());
            assert_eq!(
                authority.snapshot().unwrap().controller,
                LocalComputerController::Paused
            );
            assert!(authority.begin_agent(1).is_err());
            drop(ticket);
        }
        shutdown.join().unwrap();
    }

    #[test]
    fn scope_rejects_paths_and_ambiguous_identifiers() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        for value in ["..", "C:/Users", "agent/name", " agent", "a"] {
            assert!(state.scope("workspace-one", value).is_err(), "{value}");
        }
    }

    #[test]
    fn user_navigation_is_credential_free_and_http_only() {
        assert_eq!(
            normalize_user_navigation("https://example.com/path#private").unwrap(),
            "https://example.com/path"
        );
        for value in [
            "file:///C:/Users/example",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "not a url",
        ] {
            assert!(normalize_user_navigation(value).is_err(), "{value}");
        }
    }

    #[test]
    fn agent_result_url_returns_only_the_http_origin() {
        assert_eq!(
            sanitize_agent_result_url(
                "https://user:private@example.com/callback/private?code=private#state"
            ),
            "https://example.com/"
        );
        assert_eq!(sanitize_agent_result_url("not a url"), "unavailable");
        assert_eq!(
            sanitize_agent_result_url("file:///tmp/private"),
            "unavailable"
        );
    }

    #[test]
    fn agent_navigation_rejects_secret_shaped_query_parameters() {
        assert_eq!(
            normalize_agent_navigation("https://example.com/search?q=fable").unwrap(),
            "https://example.com/search?q=fable"
        );
        for value in [
            "https://example.com/callback?code=private",
            "https://example.com/?access_token=private",
            "https://example.com/?api-key=private",
            "https://example.com/?session=private",
        ] {
            assert!(normalize_agent_navigation(value).is_err(), "{value}");
        }
        assert!(normalize_user_navigation("https://example.com/callback?code=private").is_ok());
    }

    #[test]
    fn provisioned_directories_are_bounded_to_the_scope() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-one", "agent-one").unwrap();
        ensure_scope_directories(&scope).unwrap();
        assert!(scope.directory.join("workspace").is_dir());
        assert!(!scope.directory.join("browser-profile").exists());
        assert!(!scope.directory.join("downloads").exists());
        assert_eq!(
            state
                .tool_workspace_root("workspace-one", "agent-one")
                .unwrap(),
            scope.directory.join("workspace")
        );
        assert!(state
            .tool_workspace_root("workspace-one", "agent-two")
            .is_err());
    }

    #[test]
    fn file_operation_is_drained_before_human_control_and_its_revoked_output_is_discarded() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(LocalComputerState::for_test(temp.path().to_path_buf()));
        let scope = state.scope("workspace-files", "agent-files").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let authority = state.authority(&scope).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker_state = state.clone();
        let worker = std::thread::spawn(move || {
            worker_state.with_agent_files("workspace-files", "agent-files", 1, |root| {
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                std::fs::write(root.join("in-flight.txt"), "completed before human input")
                    .map_err(|error| error.to_string())?;
                Ok("stale file observation")
            })
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let generation = authority.revoke(1).unwrap();
        assert!(authority
            .complete_transition(generation, LocalComputerController::Human)
            .is_err());
        assert!(state
            .with_agent_files("workspace-files", "agent-files", 1, |_| Ok(()))
            .is_err());
        finish_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        authority.drain(generation, Duration::from_secs(2)).unwrap();
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        assert!(scope.directory.join("workspace/in-flight.txt").is_file());
        assert!(state
            .with_agent_files("workspace-files", "agent-files", generation, |_| Ok(()))
            .is_err());
    }

    #[test]
    fn workspace_file_projection_is_relative_bounded_and_content_free() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-files", "agent-files").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("notes")).unwrap();
        std::fs::write(workspace.join("notes").join("plan.md"), "private plan").unwrap();
        std::fs::write(workspace.join("summary.txt"), "ready").unwrap();

        let snapshot = workspace_files_snapshot(&scope).unwrap();
        assert_eq!(snapshot.computer_id, scope.computer_id);
        assert!(!snapshot.truncated);
        assert!(snapshot.entries.iter().any(|entry| {
            entry.path == "notes" && entry.name == "notes" && entry.kind == "directory"
        }));
        assert!(snapshot.entries.iter().any(|entry| {
            entry.path == "notes/plan.md"
                && entry.name == "plan.md"
                && entry.kind == "file"
                && entry.size_bytes == Some(12)
        }));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("private plan"));
    }

    #[test]
    fn workspace_file_projection_reports_its_entry_limit() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-many", "agent-many").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        for index in 0..=MAX_FILE_ENTRIES {
            std::fs::write(workspace.join(format!("file-{index:03}.txt")), "x").unwrap();
        }

        let snapshot = workspace_files_snapshot(&scope).unwrap();
        assert_eq!(snapshot.entries.len(), MAX_FILE_ENTRIES);
        assert!(snapshot.truncated);
    }

    #[test]
    fn workspace_file_preview_is_relative_utf8_and_content_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-preview", "agent-preview").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("notes")).unwrap();
        std::fs::write(workspace.join("notes").join("plan.md"), "hello\nworld").unwrap();

        let preview = workspace_file_preview(&scope, "notes/./plan.md").unwrap();
        assert_eq!(preview.path, "notes/plan.md");
        assert_eq!(preview.content, "hello\nworld");
        assert_eq!(preview.size_bytes, 11);
        assert!(!preview.truncated);
        let encoded = serde_json::to_string(&preview).unwrap();
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));

        std::fs::write(
            workspace.join("large.txt"),
            vec![b'a'; MAX_FILE_PREVIEW_BYTES + 10],
        )
        .unwrap();
        let large = workspace_file_preview(&scope, "large.txt").unwrap();
        assert_eq!(large.content.len(), MAX_FILE_PREVIEW_BYTES);
        assert!(large.truncated);
    }

    #[test]
    fn workspace_file_preview_rejects_escape_binary_and_directory() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-reject", "agent-reject").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("folder")).unwrap();
        std::fs::write(workspace.join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();
        std::fs::write(workspace.join("spoof-\u{202e}txt.md"), "text").unwrap();

        assert!(workspace_file_preview(&scope, "../outside.txt").is_err());
        assert!(workspace_file_preview(&scope, "binary.bin").is_err());
        assert!(workspace_file_preview(&scope, "folder").is_err());
        assert!(workspace_file_preview(&scope, "spoof-\u{202e}txt.md").is_err());
    }

    #[test]
    fn browser_history_availability_fails_closed_at_every_boundary() {
        assert_eq!(history_availability(0, 0), (false, false));
        assert_eq!(history_availability(0, 1), (false, false));
        assert_eq!(history_availability(0, 2), (false, true));
        assert_eq!(history_availability(1, 2), (true, false));
        assert_eq!(history_availability(1, 3), (true, true));
        assert_eq!(history_availability(4, 2), (false, false));
    }

    #[test]
    fn native_select_observations_are_bounded_and_exact() {
        let control = LocalBrowserAgentControl {
            control_ref: "control-1234567890abcdef-0".into(),
            role: "combobox".into(),
            name: "Region".into(),
            actions: vec!["select".into()],
            options: vec!["Europe".into(), "Asia".into()],
        };
        validate_agent_control_observation(&control, "control-1234567890abcdef").unwrap();
        let retained = LocalBrowserObservedControl {
            role: control.role,
            name: control.name,
            actions: control.actions,
            options: control.options,
        };
        validate_observed_control_action(&retained, "select", Some("Europe"), None).unwrap();
        assert!(
            validate_observed_control_action(&retained, "select", Some("Hidden"), None).is_err()
        );
        assert!(validate_observed_control_action(
            &retained,
            "select",
            Some("Europe"),
            Some("Enter")
        )
        .is_err());
    }

    #[test]
    fn malformed_native_select_observations_fail_closed() {
        let duplicate_options = LocalBrowserAgentControl {
            control_ref: "control-1234567890abcdef-0".into(),
            role: "combobox".into(),
            name: "Region".into(),
            actions: vec!["select".into()],
            options: vec!["Europe".into(), "Europe".into()],
        };
        assert!(
            validate_agent_control_observation(&duplicate_options, "control-1234567890abcdef")
                .is_err()
        );

        let options_on_button = LocalBrowserAgentControl {
            control_ref: "control-1234567890abcdef-1".into(),
            role: "button".into(),
            name: "Continue".into(),
            actions: vec!["click".into()],
            options: vec!["Unexpected".into()],
        };
        assert!(
            validate_agent_control_observation(&options_on_button, "control-1234567890abcdef")
                .is_err()
        );
    }

    #[test]
    #[ignore = "requires Docker Desktop and the local computer image"]
    fn real_local_browser_navigates_types_and_captures_a_frame() {
        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = [0_u8; 2_048];
                let _ = stream.read(&mut request);
                let body = r#"<!doctype html><html><head><title>Mivlet local computer</title></head><body><label>Name <input id="name"></label><button id="save">Save</button></body></html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let (_, _, scope) = live_test_scope(&state);
        let _cleanup = LiveComputerCleanup(scope.clone());
        let mut session = launch_browser(
            &scope,
            &state.image_context,
            state.authority(&scope).unwrap(),
        )
        .unwrap();
        let generation = session.authority.revoke(1).unwrap();
        session
            .authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        let operation = session.authority.begin_human(generation).unwrap();
        session
            .tab
            .navigate_to(&format!("http://host.docker.internal:{port}/"))
            .unwrap()
            .wait_until_navigated()
            .unwrap();
        session.tab.find_element("#name").unwrap().click().unwrap();
        session.tab.send_character("Mivlet").unwrap();
        let typed = session
            .tab
            .evaluate("document.querySelector('#name').value", false)
            .unwrap()
            .value
            .unwrap();
        assert_eq!(typed, serde_json::json!("Mivlet"));
        let snapshot = snapshot_from_session(&scope, &mut session).unwrap();
        assert_eq!(snapshot.title, "Mivlet local computer");
        assert!(snapshot
            .current_url
            .starts_with("http://host.docker.internal:"));
        assert!(snapshot
            .preview_data_url
            .starts_with("data:image/jpeg;base64,"));
        assert!(snapshot.can_go_back);
        assert!(!snapshot.can_go_forward);
        let history = session.tab.call_method(GetNavigationHistory(None)).unwrap();
        session
            .tab
            .call_method(NavigateToHistoryEntry {
                entry_id: history.entries[history.current_index as usize - 1].id,
            })
            .unwrap();
        let _ = session.tab.wait_until_navigated();
        assert_eq!(
            browser_history_availability(&session).unwrap(),
            (false, true)
        );
        operation.finish(Ok(())).unwrap();
        drop(session);
        let _ = server.join();
    }

    #[test]
    #[ignore = "requires Docker Desktop and the local computer image"]
    fn real_agent_navigation_uses_the_isolated_browser_and_returns_no_frame() {
        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = [0_u8; 2_048];
                let _ = stream.read(&mut request);
                let body = r#"<!doctype html><html><head><title>Agent browser result</title></head><body><label for="visual">Notes</label><input id="visual">local</body></html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(LocalComputerState::for_test(temp.path().to_path_buf()));
        let (workspace_id, agent_id, scope) = live_test_scope(&state);
        let _cleanup = LiveComputerCleanup(scope.clone());
        ensure_scope_directories(&scope).unwrap();
        let result = tauri::async_runtime::block_on(state.clone().navigate_for_agent(
            workspace_id.clone(),
            agent_id.clone(),
            format!("http://host.docker.internal:{port}/"),
            1,
        ))
        .unwrap();
        assert_eq!(result.title, "Agent browser result");
        assert!(result
            .current_url
            .starts_with("http://host.docker.internal:"));
        assert!(result.computer_id.starts_with("local-"));
        assert_eq!(result.trust, "external-untrusted");
        let retained = state
            .sessions
            .lock()
            .unwrap()
            .get(&scope.key)
            .unwrap()
            .clone();
        retained
            .lock()
            .unwrap()
            .tab
            .find_element("#visual")
            .unwrap()
            .click()
            .unwrap();
        let capture = desktop_tools::observe(&state, &workspace_id, &agent_id, 1).unwrap();
        assert!(capture.jpeg.len() > 1000);
        assert!(!capture.output.contains("base64"));
        let observation: serde_json::Value = serde_json::from_str(&capture.output).unwrap();
        let action = serde_json::json!({"observationId":observation["observationId"],"action":"type","text":"Visual fixture"});
        desktop_tools::act(
            &state,
            &workspace_id,
            &agent_id,
            1,
            serde_json::from_value(action.clone()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            retained
                .lock()
                .unwrap()
                .tab
                .evaluate("document.querySelector('#visual').value", false)
                .unwrap()
                .value
                .unwrap(),
            serde_json::json!("Visual fixture")
        );
        assert!(desktop_tools::act(
            &state,
            &workspace_id,
            &agent_id,
            1,
            serde_json::from_value(action).unwrap()
        )
        .is_err());
        retained
            .lock()
            .unwrap()
            .tab
            .evaluate(
                "setTimeout(() => alert('Continue fixture'), 0); true",
                false,
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert!(container::desktop_privacy_check(&scope).is_err());
        retained
            .lock()
            .unwrap()
            .tab
            .call_method(
                headless_chrome::protocol::cdp::Page::HandleJavaScriptDialog {
                    accept: false,
                    prompt_text: None,
                },
            )
            .unwrap();
        retained
            .lock()
            .unwrap()
            .tab
            .evaluate("document.querySelector('#visual').type='password'", false)
            .unwrap();
        assert!(desktop_tools::observe(&state, &workspace_id, &agent_id, 1).is_err());
        let authority = state.authority(&scope).unwrap();
        let generation = authority.revoke(1).unwrap();
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        assert!(desktop_tools::observe(&state, &workspace_id, &agent_id, generation).is_err());
        let _ = server.join();
    }

    #[test]
    #[ignore = "requires Docker Desktop and the local computer image"]
    fn real_agent_observation_omits_secrets_and_uses_exact_controls() {
        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut stream = stream.unwrap();
                let mut request = [0_u8; 2_048];
                let _ = stream.read(&mut request);
                let body = r#"<!doctype html><html><head><title>Controls</title></head><body><p>Visible research evidence</p><p hidden>hiddenresearch</p><div id="secret-panel">privatesecretpanel</div><div contenteditable="true">privateeditable</div><label for="upload">Upload report</label><input id="upload" type="file"><label for="query">Query</label><input id="query"><input value="private@example.com"><label for="password">Password</label><input id="password" type="password"><label for="region">Region</label><select id="region"><option value="private-eu-code">Europe</option><option value="private-asia-code">Asia</option><option disabled value="private-hidden-code">Hidden</option></select><button>Save</button></body></html>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let (_, _, scope) = live_test_scope(&state);
        let _cleanup = LiveComputerCleanup(scope.clone());
        let mut session = launch_browser(
            &scope,
            &state.image_context,
            state.authority(&scope).unwrap(),
        )
        .unwrap();
        session
            .tab
            .navigate_to(&format!("http://host.docker.internal:{port}/"))
            .unwrap()
            .wait_until_navigated()
            .unwrap();
        let observation = observe_agent_controls(&scope, &mut session).unwrap();
        assert!(observation.text.contains("Visible research evidence"));
        assert!(!observation.text.contains("hiddenresearch"));
        assert!(!observation.text.contains("privatesecretpanel"));
        assert!(!observation.text.contains("privateeditable"));
        assert!(!serde_json::to_string(&observation)
            .unwrap()
            .contains("privateeditable"));
        assert_eq!(observation.generation, 1);
        assert!(observation.active_tab_ref.starts_with("tab-"));
        assert_eq!(observation.tabs.iter().filter(|tab| tab.active).count(), 1);
        assert!(observation
            .tabs
            .iter()
            .any(|tab| tab.active && tab.tab_ref == observation.active_tab_ref));
        let upload = observation
            .controls
            .iter()
            .find(|control| control.role == "file")
            .unwrap();
        assert_eq!(upload.actions, ["upload"]);
        std::fs::write(
            scope.directory.join("workspace/upload.txt"),
            "upload fixture",
        )
        .unwrap();
        browser_tools::upload_to_observed_control(
            &scope,
            &session,
            &upload.control_ref,
            &upload.name,
            "upload.txt",
        )
        .unwrap();
        let uploaded = session
            .tab
            .evaluate("document.getElementById('upload').files[0].name", false)
            .unwrap()
            .value
            .unwrap();
        assert_eq!(uploaded, serde_json::json!("upload.txt"));
        assert!(observation
            .controls
            .iter()
            .any(|control| control.name == "Query"));
        assert!(observation
            .controls
            .iter()
            .any(|control| control.name == "Save"));
        assert!(!observation
            .controls
            .iter()
            .any(|control| control.name.contains("Password")));
        assert!(!serde_json::to_string(&observation.controls)
            .unwrap()
            .contains("private@example.com"));
        let encoded_observation = serde_json::to_string(&observation.controls).unwrap();
        assert!(!encoded_observation.contains("private-eu-code"));
        assert!(!encoded_observation.contains("private-asia-code"));
        assert!(!encoded_observation.contains("Hidden"));
        let query = observation
            .controls
            .iter()
            .find(|control| control.name == "Query")
            .unwrap();
        perform_agent_control_action(
            &session,
            &query.control_ref,
            &query.role,
            &query.name,
            "fill",
            Some("Mivlet"),
            None,
        )
        .unwrap();
        let value = session
            .tab
            .evaluate("document.querySelector('#query').value", false)
            .unwrap()
            .value
            .unwrap();
        assert_eq!(value, serde_json::json!("Mivlet"));
        let region = observation
            .controls
            .iter()
            .find(|control| control.name == "Region")
            .unwrap();
        assert_eq!(region.actions, vec!["select"]);
        assert_eq!(region.options, vec!["Europe", "Asia"]);
        perform_agent_control_action(
            &session,
            &region.control_ref,
            &region.role,
            &region.name,
            "select",
            Some("Asia"),
            None,
        )
        .unwrap();
        let selected_label = session
            .tab
            .evaluate(
                "document.querySelector('#region').selectedOptions[0].label",
                false,
            )
            .unwrap()
            .value
            .unwrap();
        assert_eq!(selected_label, serde_json::json!("Asia"));
        let _ = server.join();
    }
}
