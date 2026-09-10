//! Native-only screenshot sessions for direct API tool loops. The renderer sees
//! opaque approval IDs and observation metadata, never image bytes or credentials.
mod stream;
mod wire;

use crate::local_computer::{
    authority::{ComputerAuthority, OperationTicket},
    desktop_tools::{self, NativeDesktopCapture},
    LocalComputerState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const UNAVAILABLE: &str = "This route cannot deliver native screenshots for the selected model. Use a supported image-and-tool route.";
const STALE: &str = "The native computer provider session ended or changed. Start a fresh request.";
const MAX_SESSIONS: usize = 16;
const MAX_CALLS: usize = 80;
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

/// These exact models also have vision + tools in the connector catalogue.
/// New/unknown models and arbitrary compatible hosts fail closed.
pub(crate) fn supported_model(provider: &str, model: &str) -> bool {
    matches!(
        (provider, model),
        ("openai", "gpt-5.2" | "gpt-5" | "gpt-4.1")
            | ("anthropic", "claude-sonnet-4-6" | "claude-opus-4-8")
            | ("xai", "grok-4")
    )
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerScope {
    workspace_id: String,
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerSessionRequest {
    provider_id: String,
    model: String,
    computer: ComputerScope,
    provider_route: crate::models::ProviderRouteExecutionBinding,
}

struct PendingCall {
    call_id: String,
    tool: String,
    arguments: Value,
    request_id: String,
    ready: bool,
    claimed: bool,
    capture: Option<NativeDesktopCapture>,
    awaiting_image: bool,
}

struct SessionState {
    in_flight: Option<String>,
    calls: HashMap<String, PendingCall>,
    seen_calls: HashSet<String>,
}

struct Session {
    provider_id: String,
    model: String,
    account: String,
    route: String,
    scope: ComputerScope,
    generation: u64,
    authority: Arc<ComputerAuthority>,
    created: Instant,
    active: AtomicBool,
    state: Mutex<SessionState>,
}

impl Session {
    fn check(&self) -> Result<(), String> {
        if !self.active.load(Ordering::Acquire) || self.created.elapsed() >= SESSION_TTL {
            return Err(STALE.into());
        }
        self.authority.check_generation(self.generation).map(|_| ())
    }

    fn retire(&self) {
        self.active.store(false, Ordering::Release);
        if let Ok(mut state) = self.state.lock() {
            state.calls.clear(); // Drop every retained screenshot immediately.
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn begin_native_computer_session(
    request: ComputerSessionRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<String, String> {
    crate::execution_control::ensure_active_execution_allowed()?;
    if !supported_model(&request.provider_id, &request.model) {
        return Err(UNAVAILABLE.into());
    }
    crate::backends::validate_current_native_provider_route(
        &request.provider_id,
        &request.model,
        &request.provider_route,
    )?;
    if request.provider_route.workspace_id != request.computer.workspace_id {
        return Err("The computer and provider route workspaces do not match.".into());
    }
    computers.validate_target(&request.computer.workspace_id, &request.computer.agent_id)?;
    let authority =
        computers.authority_for(&request.computer.workspace_id, &request.computer.agent_id)?;
    let generation = authority.snapshot()?.generation;
    authority.begin_agent(generation)?.finish(Ok(()))?;
    let session = Arc::new(Session {
        provider_id: request.provider_id,
        model: request.model,
        account: crate::backends::require_current_internal_user()?,
        route: serde_json::to_string(&request.provider_route).map_err(|_| STALE)?,
        scope: request.computer,
        generation,
        authority,
        created: Instant::now(),
        active: AtomicBool::new(true),
        state: Mutex::new(SessionState {
            in_flight: None,
            calls: HashMap::new(),
            seen_calls: HashSet::new(),
        }),
    });
    let id = format!("api-vision-{}", desktop_tools::opaque_id()?);
    let mut runs = sessions().lock().map_err(|_| STALE)?;
    runs.retain(|_, run| {
        if run.check().is_err() {
            run.retire();
            false
        } else {
            true
        }
    });
    if runs.len() >= MAX_SESSIONS {
        return Err(
            "Too many active computer provider sessions. Finish or stop an existing request."
                .into(),
        );
    }
    runs.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub fn end_native_computer_session(session_id: String) -> Result<(), String> {
    let run = sessions().lock().map_err(|_| STALE)?.remove(&session_id);
    if let Some(run) = run {
        run.retire();
        let request = run.state.lock().map_err(|_| STALE)?.in_flight.clone();
        if let Some(request) = request {
            let _ = super::cancel_backend_completion(request);
        }
    }
    Ok(())
}

pub(crate) struct DesktopToolClaim {
    session: Arc<Session>,
    approval_id: String,
}

impl DesktopToolClaim {
    pub(crate) fn check(&self) -> Result<(), String> {
        self.session.check()
    }
}

pub(crate) fn claim_desktop_tool(
    approval_id: &str,
    tool: &str,
    arguments: &Value,
    workspace: &str,
    agent: &str,
    generation: u64,
) -> Result<DesktopToolClaim, String> {
    let runs = sessions().lock().map_err(|_| STALE)?;
    for session in runs.values() {
        let mut state = session.state.lock().map_err(|_| STALE)?;
        let Some(call) = state.calls.get_mut(approval_id) else {
            continue;
        };
        session.check()?;
        if session.scope.workspace_id != workspace
            || session.scope.agent_id != agent
            || session.generation != generation
            || !call.ready
            || call.claimed
            || call.tool != tool
            || call.arguments != *arguments
        {
            return Err("The desktop tool does not match its exact pending provider call, scope or generation.".into());
        }
        call.claimed = true;
        return Ok(DesktopToolClaim {
            session: session.clone(),
            approval_id: approval_id.into(),
        });
    }
    Err("No current provider-emitted desktop tool call matches this approval.".into())
}

pub(crate) fn retain_desktop_capture(
    claim: DesktopToolClaim,
    capture: NativeDesktopCapture,
) -> Result<String, String> {
    claim.session.check()?;
    let mut state = claim.session.state.lock().map_err(|_| STALE)?;
    claim.session.check()?;
    let call = state.calls.get_mut(&claim.approval_id).ok_or(STALE)?;
    if !call.claimed
        || call.tool != "local-desktop-observe"
        || call.capture.is_some()
        || claim.session.generation != capture.generation
        || claim.session.scope.workspace_id != capture.workspace_id
        || claim.session.scope.agent_id != capture.agent_id
    {
        return Err("The screenshot does not match its native provider call.".into());
    }
    let output = capture.output.clone();
    call.awaiting_image = true;
    call.capture = Some(capture);
    // Approval UI delays or a disconnected renderer cannot retain pixels forever.
    let weak = Arc::downgrade(&claim.session);
    let approval_id = claim.approval_id;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if let Some(session) = weak.upgrade() {
            if let Ok(mut state) = session.state.lock() {
                if let Some(call) = state.calls.get_mut(&approval_id) {
                    call.capture = None;
                }
            }
        }
    });
    Ok(output)
}

/// Holds a generation ticket through egress. Stop cancels it independently of
/// the network future, and cancelled/dropped streams cannot authorize tools.
pub(crate) struct ComputerStream {
    session: Arc<Session>,
    request_id: String,
    ticket: OperationTicket,
    images: Vec<NativeDesktopCapture>,
    parser: stream::ToolCalls,
    advertised: HashSet<String>,
    completed: bool,
}

pub(crate) fn begin_stream(
    request: &super::BackendStreamRequest,
    body: &mut Value,
    computers: &Arc<LocalComputerState>,
) -> Result<Option<ComputerStream>, String> {
    let advertised = wire::visual_tools(body);
    let Some(id) = request.computer_session_id.as_ref() else {
        return if advertised.is_empty() {
            Ok(None)
        } else {
            Err(UNAVAILABLE.into())
        };
    };
    wire::validate_text_messages(&request.provider_id, body)?;
    let session = sessions()
        .lock()
        .map_err(|_| STALE)?
        .get(id)
        .cloned()
        .ok_or(STALE)?;
    session.check()?;
    if session.provider_id != request.provider_id
        || session.model != request.model
        || session.account != crate::backends::require_current_internal_user()?
        || Some(session.route.clone())
            != request
                .provider_route
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| STALE)?
    {
        return Err("The screenshot provider route or account changed.".into());
    }
    computers.validate_target(&session.scope.workspace_id, &session.scope.agent_id)?;
    let ticket = session.authority.begin_agent(session.generation)?;
    let mut state = session.state.lock().map_err(|_| STALE)?;
    if state.in_flight.is_some() {
        return Err("This computer provider session already has an active request.".into());
    }
    let mut images = Vec::new();
    for call in state.calls.values_mut() {
        if call.awaiting_image && call.capture.is_none() {
            return Err("Screenshot delivery expired. Pixels were discarded; observe again in a fresh request.".into());
        }
        if let Some(capture) = call.capture.take() {
            // Delivery is one-shot. Any mismatch or stale selection discards it.
            desktop_tools::delivery_ticket(computers, &capture)?.finish(Ok(()))?;
            wire::attach(&request.provider_id, body, &call.call_id, &capture)?;
            call.awaiting_image = false;
            images.push(capture);
        }
    }
    // Once the next model request starts, denied, failed and completed calls
    // from the previous response can no longer be claimed. IDs remain retired.
    state.calls.clear();
    state.in_flight = Some(request.request_id.clone());
    drop(state);
    Ok(Some(ComputerStream {
        session,
        request_id: request.request_id.clone(),
        ticket,
        images,
        parser: stream::ToolCalls::new(&request.provider_id),
        advertised,
        completed: false,
    }))
}

impl ComputerStream {
    pub(crate) fn has_image(&self) -> bool {
        !self.images.is_empty()
    }

    pub(crate) fn before_send(&self, computers: &Arc<LocalComputerState>) -> Result<(), String> {
        self.session.check()?;
        self.ticket.check()?;
        for capture in &self.images {
            desktop_tools::delivery_ticket(computers, capture)?.finish(Ok(()))?;
        }
        Ok(())
    }

    pub(crate) async fn wait_for_cancel(&self) {
        while self.session.check().is_ok() && self.ticket.check().is_ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Called before the corresponding provider SSE payload reaches React.
    pub(crate) fn observe(&mut self, payload: &str) -> Result<Vec<Value>, String> {
        let calls = self.parser.observe(payload)?;
        let mut bindings = Vec::new();
        let mut state = self.session.state.lock().map_err(|_| STALE)?;
        self.session.check()?;
        for call in calls {
            if !call.tool.starts_with("local-desktop-") {
                continue;
            }
            if !self.advertised.contains(&call.tool)
                || state.seen_calls.len() >= MAX_CALLS
                || !state.seen_calls.insert(call.call_id.clone())
                || (call.tool == "local-desktop-observe"
                    && state.calls.values().any(|old| {
                        old.request_id == self.request_id && old.tool == "local-desktop-observe"
                    }))
            {
                return Err("The provider returned an unavailable, duplicate or excessive desktop tool call.".into());
            }
            let approval_id = format!("api-visual-{}", desktop_tools::opaque_id()?);
            bindings.push(
                json!({"__fableComputerTool":{"callId":call.call_id,"approvalId":approval_id}}),
            );
            state.calls.insert(
                approval_id,
                PendingCall {
                    call_id: call.call_id,
                    tool: call.tool,
                    arguments: call.arguments,
                    request_id: self.request_id.clone(),
                    ready: false,
                    claimed: false,
                    capture: None,
                    awaiting_image: false,
                },
            );
        }
        Ok(bindings)
    }

    pub(crate) fn complete(&mut self, ok: bool) -> Result<(), String> {
        self.session.check()?;
        self.ticket.check()?;
        self.completed = ok && self.parser.complete();
        if !self.completed {
            return Err(
                "The computer provider response ended without a complete tool protocol.".into(),
            );
        }
        let mut state = self.session.state.lock().map_err(|_| STALE)?;
        for call in state
            .calls
            .values_mut()
            .filter(|call| call.request_id == self.request_id)
        {
            call.ready = true;
        }
        Ok(())
    }
}

impl Drop for ComputerStream {
    fn drop(&mut self) {
        if !self.completed {
            self.session.retire();
        }
        if let Ok(mut state) = self.session.state.lock() {
            if state.in_flight.as_deref() == Some(&self.request_id) {
                state.in_flight = None;
            }
        }
    }
}

#[cfg(test)]
mod tests;
