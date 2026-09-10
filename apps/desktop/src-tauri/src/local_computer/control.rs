//! Installation-wide window lease. The renderer can request a window, never
//! choose a driver method. No permission is persisted or restored on reconnect.
use super::{
    authority::{ComputerAuthority, OperationTicket},
    cua::Driver,
    windows::{self, WindowBinding, WindowChoice},
    LocalComputerState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::State;

const STALE: &str =
    "Computer control changed. Start a fresh request and select the current window again.";
const TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DeliveryMode {
    #[default]
    Background,
    Foreground,
}
impl DeliveryMode {
    pub(super) fn is_foreground(self) -> bool {
        self == Self::Foreground
    }
}

pub(super) enum PreparedCall {
    Driver(&'static str, Value),
    ForegroundRequired(&'static str),
}

pub(super) fn foreground_required(message: &str) -> Value {
    serde_json::json!({"status":"foreground-required","inputDispatched":false,
        "requiresObservation":true,"message":message,
        "nextStep":"List current windows, then request local-app-select with deliveryMode foreground under the normal approval policy. Observe again before choosing any action. No action is automatically replayed."})
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;

#[derive(Default)]
pub(super) struct NativeControl {
    inner: Mutex<Inner>,
}
#[derive(Default)]
struct Inner {
    choices: HashMap<String, WindowChoice>,
    choices_at: Option<Instant>,
    choices_scope: Option<Scope>,
    pending: Option<Pending>,
    active: Option<Arc<Grant>>,
    observation: Option<Observation>,
    message: Option<String>,
    retiring: Option<Arc<AtomicBool>>,
}
struct Pending {
    key: Scope,
    request: String,
    choice: WindowChoice,
    preparing_driver: Option<Arc<Driver>>,
    authority: Arc<ComputerAuthority>,
    created: Instant,
    delivery_mode: DeliveryMode,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(driver) = self.preparing_driver.take() {
            driver.stop();
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    workspace: String,
    agent: String,
    generation: u64,
}
struct Grant {
    key: Scope,
    request: String,
    choice: WindowChoice,
    window: Arc<WindowBinding>,
    driver: Arc<Driver>,
    authority: Arc<ComputerAuthority>,
    created: Instant,
    last_activity: Mutex<Instant>,
    delivery_mode: DeliveryMode,
    background_input_in_flight: AtomicBool,
    foreground: Mutex<ForegroundState>,
}
struct ForegroundState {
    last: u64,
    taken_over: bool,
}
impl ForegroundState {
    fn observe(&mut self, window: u64, belongs_to_target: bool) -> bool {
        // Latch takeover: a monitor checking first must not consume the change
        // and let a concurrent action consider the same foreground HWND safe.
        self.taken_over |= belongs_to_target && window != self.last;
        self.last = window;
        !self.taken_over
    }
}
pub(super) struct Observation {
    pub id: String,
    pub snapshot: String,
    pub elements: HashMap<String, String>,
    pub width: u32,
    pub height: u32,
    pub window_size: (u32, u32),
    pub created: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSnapshot {
    pub status: &'static str,
    pub request_id: Option<String>,
    pub generation: Option<u64>,
    pub application: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub delivery_mode: Option<DeliveryMode>,
}

impl NativeControl {
    pub(super) fn active(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| inner.active.is_some())
    }
    pub(super) fn snapshot(&self, workspace: &str, agent: &str) -> Result<ControlSnapshot, String> {
        let inner = self.inner.lock().map_err(|_| STALE)?;
        let (status, request, choice) = if let Some(grant) = &inner.active {
            if grant.key.workspace == workspace && grant.key.agent == agent {
                ("active", Some(grant.request.clone()), Some(&grant.choice))
            } else {
                ("busy", None, None)
            }
        } else if let Some(pending) = &inner.pending {
            if pending.key.workspace == workspace && pending.key.agent == agent {
                (
                    "connecting",
                    Some(pending.request.clone()),
                    Some(&pending.choice),
                )
            } else {
                ("idle", None, None)
            }
        } else {
            ("idle", None, None)
        };
        let generation = inner
            .active
            .as_ref()
            .map(|g| g.key.generation)
            .or_else(|| inner.pending.as_ref().map(|p| p.key.generation));
        Ok(ControlSnapshot {
            status,
            request_id: request,
            generation,
            application: choice.map(|c| c.application.clone()),
            title: choice.map(|c| c.title.clone()),
            message: inner.message.clone(),
            delivery_mode: if choice.is_some() {
                inner
                    .active
                    .as_ref()
                    .map(|g| g.delivery_mode)
                    .or_else(|| inner.pending.as_ref().map(|p| p.delivery_mode))
            } else {
                None
            },
        })
    }

    /// Driver background actions temporarily shield a window from activation.
    /// A killed process cannot run its guards' destructors. Restore only after
    /// termination, off the Stop thread, and fence new leases until it finishes.
    fn retire(inner: &mut Inner, grant: Arc<Grant>) {
        let restore = grant.background_input_in_flight.load(Ordering::Acquire);
        grant.driver.stop();
        grant.authority.revoke_and_drain_later();
        if restore {
            let done = Arc::new(AtomicBool::new(false));
            inner.retiring = Some(done.clone());
            let _ = std::thread::Builder::new()
                .name("mivlet-window-cleanup".into())
                .spawn(move || {
                    if grant.driver.wait_stopped(Duration::from_secs(5))
                        && grant.window.restore_background_state().is_ok()
                    {
                        done.store(true, Ordering::Release);
                    }
                });
        }
    }

    pub(super) fn activity_label(&self) -> &'static str {
        match self
            .inner
            .lock()
            .ok()
            .and_then(|i| i.active.as_ref().map(|g| g.delivery_mode))
        {
            Some(DeliveryMode::Background) => "Agent is using an app in the background",
            _ => "Agent is using the foreground window",
        }
    }

    /// Native input hooks report only a target HWND, never key values or text.
    pub(super) fn user_input(&self, window: u64) {
        let request = self.inner.lock().ok().and_then(|mut i| {
            if i.pending.as_ref().is_some_and(|p| p.choice.identity.hwnd == window) {
                if let Some(pending) = i.pending.take() { pending.authority.revoke_and_drain_later(); }
                i.message = Some("You interacted with the selected app. Selection stopped; start a fresh request to resume.".into());
            }
            i.active.as_ref().filter(|g| g.window.identity.hwnd == window).map(|g| g.request.clone())
        });
        if let Some(request) = request {
            self.stop_if(&request, "You interacted with the selected app. Computer control stopped; start a fresh request to resume.");
        }
    }

    fn check_window(grant: &Grant) -> Result<(), String> {
        grant.window.check(grant.delivery_mode.is_foreground())?;
        let foreground = windows::foreground();
        if !grant.delivery_mode.is_foreground()
            && !grant.foreground.lock().map_err(|_| STALE)?.observe(
                foreground,
                windows::belongs_to_window(foreground, grant.window.identity.hwnd),
            )
        {
            return Err("The background app became foreground. Computer control stopped; start a fresh request to resume.".into());
        }
        Ok(())
    }

    /// Revoke before process termination. A late response can never install an
    /// observation. No response or UIA lock is held while Stop acquires this lock.
    pub(super) fn stop(&self, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(pending) = inner.pending.take() {
                pending.authority.revoke_and_drain_later();
            }
            inner.observation = None;
            inner.message = Some(message.into());
            if let Some(grant) = inner.active.take() {
                Self::retire(&mut inner, grant);
            }
        }
    }

    pub(super) fn stop_scope(&self, workspace: &str, agent: &str, generation: u64, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.pending.as_ref().is_some_and(|p| {
                p.key.workspace == workspace
                    && p.key.agent == agent
                    && p.key.generation == generation
            }) {
                inner.pending = None;
            }
            if inner.active.as_ref().is_some_and(|g| {
                g.key.workspace == workspace
                    && g.key.agent == agent
                    && g.key.generation == generation
            }) {
                inner.observation = None;
                inner.message = Some(message.into());
                if let Some(grant) = inner.active.take() {
                    Self::retire(&mut inner, grant);
                }
            }
        }
    }

    pub(super) fn monitor(&self) {
        let grant = self.inner.lock().ok().and_then(|i| i.active.clone());
        if let Some(grant) = grant {
            let failure = Self::check_window(&grant).err().or_else(|| {
                if !grant.driver.alive()
                    || grant.created.elapsed() > Duration::from_secs(1800)
                    || grant
                        .last_activity
                        .lock()
                        .map_or(true, |time| time.elapsed() > Duration::from_secs(300))
                {
                    Some(
                        "Computer control expired or disconnected. Fresh permission is required."
                            .into(),
                    )
                } else {
                    None
                }
            });
            if let Some(error) = failure {
                self.stop_if(&grant.request, &error);
            }
        }
    }
    fn stop_if(&self, request: &str, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.active.as_ref().is_some_and(|g| g.request == request) {
                inner.observation = None;
                inner.message = Some(message.into());
                if let Some(grant) = inner.active.take() {
                    Self::retire(&mut inner, grant);
                }
            }
        }
    }
    fn grant(&self, key: &Scope) -> Result<Arc<Grant>, String> {
        self.inner
            .lock()
            .map_err(|_| STALE)?
            .active
            .as_ref()
            .filter(|g| &g.key == key && g.driver.alive())
            .cloned()
            .ok_or(STALE.into())
    }
    fn check(inner: &Inner, grant: &Grant, ticket: &OperationTicket) -> Result<(), String> {
        ticket.check()?;
        if inner
            .active
            .as_ref()
            .is_none_or(|g| g.request != grant.request || g.key != grant.key)
        {
            return Err(STALE.into());
        }
        Self::check_window(grant)?;
        if !grant.driver.alive() {
            return Err(STALE.into());
        }
        Ok(())
    }

    pub(super) fn call(
        &self,
        workspace: &str,
        agent: &str,
        generation: u64,
        ticket: &OperationTicket,
        observation: Option<&str>,
        make: impl FnOnce(
            &WindowBinding,
            Option<Observation>,
            DeliveryMode,
        ) -> Result<PreparedCall, String>,
    ) -> Result<(String, Value), String> {
        let key = Scope {
            workspace: workspace.into(),
            agent: agent.into(),
            generation,
        };
        let grant = self.grant(&key)?;
        let _serial = grant.driver.serial()?;
        if let Err(error) = windows::privacy_check(grant.window.identity.hwnd) {
            self.stop_if(&grant.request, &error);
            return Err(error);
        }
        let result = (|| {
            let (name, args) = {
                let mut inner = self.inner.lock().map_err(|_| STALE)?;
                Self::check(&inner, &grant, ticket)?;
                grant.window.check_enabled()?;
                let observed = if let Some(expected) = observation {
                    let value = inner
                        .observation
                        .take()
                        .ok_or("Observe the selected window before acting.")?;
                    if value.id != expected || value.created.elapsed() > TTL {
                        return Err("The observation is stale. Observe again.".into());
                    }
                    if grant.window.dimensions()? != value.window_size {
                        return Err("The window resized after observation. Observe again.".into());
                    }
                    Some(value)
                } else {
                    inner.observation = None;
                    None
                };
                match make(&grant.window, observed, grant.delivery_mode)? {
                    PreparedCall::ForegroundRequired(reason) => {
                        inner.message = Some(reason.into());
                        return Ok((grant.request.clone(), foreground_required(reason)));
                    }
                    PreparedCall::Driver(name, mut args) => {
                        // Only the approved selection chooses delivery. Neither a
                        // tool's raw arguments nor a driver hint can escalate it.
                        if name != "get_window_state" {
                            args["delivery_mode"] = serde_json::json!(grant.delivery_mode);
                            grant
                                .background_input_in_flight
                                .store(!grant.delivery_mode.is_foreground(), Ordering::Release);
                        }
                        (name, args)
                    }
                }
            };
            // This driver instance belongs only to this lease. Its atomic stopped
            // fence is checked immediately before writing. Revocation kills it;
            // even a blocked pipe cannot hold the native Stop lock or reach a
            // subsequent lease's fresh process.
            let id = grant.driver.dispatch(name, args)?;
            let result = grant.driver.receive(id)?;
            let inner = self.inner.lock().map_err(|_| STALE)?;
            Self::check(&inner, &grant, ticket)?;
            grant.window.check_enabled()?;
            if result.get("isError").and_then(Value::as_bool) == Some(true) {
                if grant.delivery_mode == DeliveryMode::Background {
                    return Err("Background action outcome is uncertain. Do not replay it or switch to foreground to retry. Computer control stopped; a fresh user request must first inspect the current state.".into());
                }
                return Err("The application action was not confirmed. Observe the application before deciding what to do; input was not retried.".into());
            }
            grant
                .background_input_in_flight
                .store(false, Ordering::Release);
            *grant.last_activity.lock().map_err(|_| STALE)? = Instant::now();
            Ok((grant.request.clone(), result))
        })();
        if result.is_err() {
            self.stop_if(&grant.request, "Computer control stopped after an unconfirmed action. Previously dispatched Windows input may already have taken effect. Fresh permission is required.");
        }
        result
    }

    pub(super) fn retain(
        &self,
        request: &str,
        observation: Observation,
        ticket: &OperationTicket,
    ) -> Result<(), String> {
        let window = self
            .inner
            .lock()
            .map_err(|_| STALE)?
            .active
            .as_ref()
            .filter(|g| g.request == request)
            .map(|g| g.window.clone())
            .ok_or(STALE)?;
        if let Err(error) = windows::privacy_check(window.identity.hwnd) {
            self.stop_if(request, &error);
            return Err(error);
        }
        let mut inner = self.inner.lock().map_err(|_| STALE)?;
        let grant = inner
            .active
            .as_ref()
            .filter(|g| g.request == request)
            .ok_or(STALE)?;
        Self::check(&inner, grant, ticket)?;
        if window.dimensions()? != observation.window_size {
            return Err("The window resized during observation. Observe again.".into());
        }
        inner.observation = Some(observation);
        Ok(())
    }
    pub(super) fn validate(
        &self,
        workspace: &str,
        agent: &str,
        generation: u64,
    ) -> Result<(), String> {
        let grant = self.grant(&Scope {
            workspace: workspace.into(),
            agent: agent.into(),
            generation,
        })?;
        Self::check_window(&grant)
    }

    /// A screenshot cannot outlive its exact selection or latest observation,
    /// including when another window is selected within the same generation.
    pub(super) fn validate_delivery(
        &self,
        capture: &super::desktop_tools::NativeDesktopCapture,
        ticket: &OperationTicket,
    ) -> Result<(), String> {
        let grant = self.grant(&Scope {
            workspace: capture.workspace_id.clone(),
            agent: capture.agent_id.clone(),
            generation: capture.generation,
        })?;
        if grant.request != capture.selection_id {
            return Err("The screenshot's selected window changed. Observe again.".into());
        }
        windows::privacy_check(grant.window.identity.hwnd)?;
        let inner = self.inner.lock().map_err(|_| STALE)?;
        Self::check(&inner, &grant, ticket)?;
        let observation = inner
            .observation
            .as_ref()
            .filter(|value| value.id == capture.observation_id && value.created.elapsed() <= TTL)
            .ok_or(
                "The screenshot observation was replaced, consumed or expired. Observe again.",
            )?;
        if grant.window.dimensions()? != observation.window_size {
            return Err("The window resized after observation. Observe again.".into());
        }
        Ok(())
    }
}

/// Discovery and selection are ordinary, exactly approved model tools. The
/// renderer exposes status and Stop, never a second permission authority.
pub(crate) fn list_app_windows(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
) -> Result<String, String> {
    let authority = state.authority_for(workspace, agent)?;
    let ticket = authority.begin_agent(generation)?;
    let choices = windows::list_windows()?;
    let mut inner = state.native.inner.lock().map_err(|_| STALE)?;
    ticket.check()?;
    inner.choices = choices.iter().map(|c| (c.id.clone(), c.clone())).collect();
    inner.choices_at = Some(Instant::now());
    inner.choices_scope = Some(Scope {
        workspace: workspace.into(),
        agent: agent.into(),
        generation,
    });
    let output = serde_json::json!({"windows":choices,"trust":"external-untrusted","instructionAuthority":"none"}).to_string();
    drop(inner);
    ticket.finish(Ok(output))
}

/// Caller must consume the exact global tool approval before entering here.
/// A new target gets a new process and request fence. The turn generation stays
/// stable; Stop and failures revoke that generation and reject the old turn.
pub(crate) fn select_app_window(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    window_id: &str,
    delivery_mode: DeliveryMode,
    approved_request: &str,
) -> Result<ControlSnapshot, String> {
    if let Some(error) = state.activity_error.lock().map_err(|_| STALE)?.clone() {
        return Err(error);
    }
    let authority = state.authority_for(workspace, agent)?;
    let ticket = authority.begin_agent(generation)?;
    let key = Scope {
        workspace: workspace.into(),
        agent: agent.into(),
        generation,
    };
    let binding = {
        let mut inner = state.native.inner.lock().map_err(|_| STALE)?;
        ticket.check()?;
        if inner
            .retiring
            .as_ref()
            .is_some_and(|done| !done.load(Ordering::Acquire))
        {
            return Err("The previous Windows action is still being cleaned up. Computer control remains stopped.".into());
        }
        inner.retiring = None;
        if inner.active.as_ref().is_some_and(|g| g.key != key)
            || inner.pending.as_ref().is_some_and(|p| p.key != key)
        {
            return Err("Another agent is controlling this Windows session.".into());
        }
        if inner.choices_scope.as_ref() != Some(&key)
            || inner
                .choices_at
                .is_none_or(|at| at.elapsed() > Duration::from_secs(120))
        {
            return Err("The application list expired. List the current windows again.".into());
        }
        let choice = inner
            .choices
            .remove(window_id)
            .ok_or("This window choice expired. List the current windows again.")?;
        let binding = Arc::new(WindowBinding::new(
            choice.identity.clone(),
            &choice.application,
        )?);
        if inner
            .active
            .as_ref()
            .is_some_and(|g| g.background_input_in_flight.load(Ordering::Acquire))
        {
            return Err("Wait for the current background action to finish before changing the selected window or delivery mode.".into());
        }
        if let Some(grant) = inner.active.take() {
            grant.driver.stop();
        }
        inner.observation = None;
        inner.pending = Some(Pending {
            key: key.clone(),
            request: approved_request.into(),
            choice,
            preparing_driver: None,
            authority: authority.clone(),
            created: Instant::now(),
            delivery_mode,
        });
        inner.message = None;
        binding
    };
    let setup = || -> Result<(), String> {
        binding.check(false)?;
        windows::privacy_check(binding.identity.hwnd)?;
        ticket.check()?;
        let driver = Driver::start(
            &state.driver_directory,
            (binding.identity.pid, binding.identity.hwnd),
        )?;
        {
            let mut inner = state.native.inner.lock().map_err(|_| STALE)?;
            ticket.check()?;
            let pending = inner
                .pending
                .as_mut()
                .filter(|p| p.key == key && p.request == approved_request)
                .ok_or(STALE)?;
            pending.preparing_driver = Some(driver.clone());
        }
        // Never hold the control lock across foreground activation: Windows can
        // synchronously invoke another input queue, including our Stop thread.
        if delivery_mode.is_foreground() {
            binding.focus()?;
        }
        let mut inner = state.native.inner.lock().map_err(|_| STALE)?;
        ticket.check()?;
        binding.check(delivery_mode.is_foreground())?;
        binding.check_enabled()?;
        if inner.active.is_some() || !driver.alive() {
            return Err(STALE.into());
        }
        let pending = inner
            .pending
            .as_mut()
            .filter(|p| {
                p.key == key
                    && p.request == approved_request
                    && p.created.elapsed() <= Duration::from_secs(120)
            })
            .ok_or(STALE)?;
        pending.preparing_driver.take();
        let choice = pending.choice.clone();
        inner.pending = None;
        inner.message = Some(if delivery_mode.is_foreground() {
            "Using the foreground window. Stop anytime with Ctrl+Alt+Esc."
        } else {
            "Using supported app controls in the background. Click or type in that app to stop control, or press Ctrl+Alt+Esc."
        }.into());
        inner.active = Some(Arc::new(Grant {
            key,
            request: approved_request.into(),
            choice,
            window: binding,
            driver,
            authority,
            created: Instant::now(),
            last_activity: Mutex::new(Instant::now()),
            delivery_mode,
            background_input_in_flight: AtomicBool::new(false),
            foreground: Mutex::new(ForegroundState {
                last: windows::foreground(),
                taken_over: false,
            }),
        }));
        Ok(())
    };
    if let Err(error) = setup() {
        let mut inner = state.native.inner.lock().map_err(|_| STALE)?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|p| p.request == approved_request)
        {
            inner.pending = None;
            inner.message = Some(error.clone());
        }
        return Err(error);
    }
    ticket.finish(state.native.snapshot(workspace, agent))
}

#[tauri::command]
pub fn local_app_stop(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<(), String> {
    if !["main", "computer-activity"].contains(&window.label()) {
        return Err("Stop belongs to Mivlet's control windows.".into());
    }
    state.native.stop("Stopped. Queued actions were cancelled; already dispatched Windows input may have taken effect. Fresh permission is required.");
    Ok(())
}
