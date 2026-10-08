//! Authenticated HTTP ingress binds only to loopback. Public forwarding is an
//! explicit external prerequisite; there is no relay, cloud holding or runner.
use super::super::*;
use super::{delivery, secrets, template};
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    enabled: bool,
    port: u16,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 24_138,
        }
    }
}
struct Listener {
    port: u16,
    shutdown: oneshot::Sender<()>,
}
pub struct EventIngress {
    listener: Mutex<Option<Listener>>,
    configuration: tokio::sync::Mutex<()>,
    rate: Arc<Mutex<HashMap<String, (i64, u32)>>>,
    capacity: Arc<tokio::sync::Semaphore>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressStatus {
    enabled: bool,
    port: u16,
    listening: bool,
    base_url: Option<String>,
    prerequisite: Option<String>,
    availability: &'static str,
    cloud_holding: bool,
}

fn config(store: &Store, scope: &AuthorizedCommandScope) -> crate::store::Result<Config> {
    store
        .with_conn(|conn| {
            crate::store::repos::preferences::get_scoped(conn, store, &scope.data, "event-ingress")
        })?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| StoreError::Invalid("Event ingress configuration is invalid.".into()))
        .map(|value| value.unwrap_or_default())
}

impl EventIngress {
    pub fn new() -> Self {
        Self {
            listener: Mutex::new(None),
            configuration: tokio::sync::Mutex::new(()),
            rate: Arc::new(Mutex::new(HashMap::new())),
            capacity: Arc::new(tokio::sync::Semaphore::new(8)),
        }
    }
    fn status(
        &self,
        config: &Config,
        prerequisite: Option<String>,
    ) -> Result<IngressStatus, String> {
        let port = self
            .listener
            .lock()
            .map_err(|_| "Event ingress is unavailable.")?
            .as_ref()
            .map(|listener| listener.port);
        Ok(IngressStatus {
            enabled: config.enabled,
            port: config.port,
            listening: port.is_some(),
            base_url: port.map(|port| format!("http://127.0.0.1:{port}")),
            prerequisite,
            availability: "app-open",
            cloud_holding: false,
        })
    }
    pub(crate) fn stop(&self) -> Result<(), String> {
        if let Some(listener) = self
            .listener
            .lock()
            .map_err(|_| "Event ingress is unavailable.")?
            .take()
        {
            let _ = listener.shutdown.send(());
        }
        Ok(())
    }
    async fn start(&self, port: u16) -> Result<(), String> {
        if port < 1024 {
            return Err("Choose an event ingress port from 1024 to 65535.".into());
        }
        if self
            .listener
            .lock()
            .map_err(|_| "Event ingress is unavailable.")?
            .as_ref()
            .is_some_and(|listener| listener.port == port)
        {
            return Ok(());
        }
        self.stop()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| "The event ingress port is unavailable. Choose another local port.")?;
        crate::account_session::ensure_current()?;
        let state = HttpState {
            rate: self.rate.clone(),
            capacity: self.capacity.clone(),
            fence: Arc::new(crate::account_session::AccountDispatchFence::capture()?),
        };
        let router = Router::new()
            .route("/events/{schedule}/{route}", post(handle))
            .with_state(state);
        let (shutdown, rx) = oneshot::channel();
        *self
            .listener
            .lock()
            .map_err(|_| "Event ingress is unavailable.")? = Some(Listener { port, shutdown });
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        Ok(())
    }
}

#[derive(Clone)]
struct HttpState {
    rate: Arc<Mutex<HashMap<String, (i64, u32)>>>,
    capacity: Arc<tokio::sync::Semaphore>,
    fence: Arc<crate::account_session::AccountDispatchFence>,
}
fn reply(status: u16, reason: &str, id: Option<String>) -> Response {
    let body = serde_json::json!({"outcome":reason,"deliveryId":id}).to_string();
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        body,
    )
        .into_response()
}

async fn handle(
    State(state): State<HttpState>,
    Path((schedule, route)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    let Ok(_capacity) = state.capacity.try_acquire() else {
        return reply(429, "ingress_busy", None);
    };
    if !template::identifier(&schedule, 96)
        || route.len() != 64
        || !route.bytes().all(|c| c.is_ascii_hexdigit())
        || request.uri().query().is_some()
    {
        return reply(404, "unknown_endpoint", None);
    }
    if state.fence.with_current(|| Ok(())).is_err() {
        return reply(503, "account_unavailable", None);
    }
    // Browser requests never constitute a supported event source. No CORS or
    // bearer URL is offered, even for local browser origins.
    if request.headers().contains_key("origin") || request.headers().contains_key("sec-fetch-site")
    {
        return reply(403, "browser_delivery_unsupported", None);
    }
    let mut headers = BTreeMap::<String, String>::new();
    let mut header_bytes = 0;
    for (name, value) in request.headers() {
        let Ok(value) = value.to_str() else {
            return reply(400, "invalid_headers", None);
        };
        header_bytes += name.as_str().len() + value.len();
        if header_bytes > 16_384
            || headers.len() >= 64
            || headers.insert(name.as_str().into(), value.into()).is_some()
        {
            return reply(400, "invalid_headers", None);
        }
    }
    if !headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return reply(415, "json_required", None);
    }
    let now = Utc::now();
    let rate = state
        .rate
        .lock()
        .map(|mut rates| {
            rates.retain(|_, (start, _)| now.timestamp() - *start < 60);
            if rates.len() >= 256 && !rates.contains_key(&schedule) {
                return false;
            }
            let entry = rates
                .entry(schedule.clone())
                .or_insert((now.timestamp(), 0));
            entry.1 += 1;
            entry.1 <= 60
        })
        .unwrap_or(false);
    if !rate {
        return reply(429, "rate_limited", None);
    }
    let raw = match tokio::time::timeout(
        Duration::from_secs(5),
        to_bytes(request.into_body(), template::MAX_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return reply(413, "payload_too_large", None),
        Err(_) => return reply(408, "payload_timeout", None),
    };
    let fence = state.fence.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        (|| {
            let store = global_store()?;
            let scope = authorized_scope::active_command_scope(ScopeAccess::Write)?;
            delivery::receive(
                store,
                &scope,
                delivery::IncomingEvent {
                    schedule_id: &schedule,
                    route: &route,
                    headers: &headers,
                    raw: &raw,
                    now,
                },
                |schedule, config, body, signature| {
                    secrets::verify(
                        scope.data.workspace_id(),
                        &schedule.agent_id,
                        &schedule.id,
                        config,
                        body,
                        signature,
                    )
                },
                |schedule, config, preview| {
                    secrets::redact(
                        scope.data.workspace_id(),
                        &schedule.agent_id,
                        &schedule.id,
                        config,
                        preview,
                    )
                },
                fence.as_ref(),
            )
            .map_err(|_| "Event delivery could not be persisted.".to_string())
        })()
    })
    .await;
    match result {
        Ok(Ok(receipt)) => reply(receipt.status, receipt.reason, receipt.id),
        _ => reply(503, "ingress_unavailable", None),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IngressRequest {
    workspace_id: String,
}
#[tauri::command]
pub async fn event_ingress_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, EventIngress>,
    request: IngressRequest,
) -> Result<IngressStatus, String> {
    require_main_window(&window)?;
    let scope =
        authorized_scope::command_scope(Some(request.workspace_id), None, ScopeAccess::Read)?;
    let config = config(global_store()?, &scope).map_err(|e| e.to_string())?;
    state.status(&config, None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureIngressRequest {
    workspace_id: String,
    enabled: bool,
    port: u16,
}
#[tauri::command]
pub async fn event_ingress_configure(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, EventIngress>,
    request: ConfigureIngressRequest,
) -> Result<IngressStatus, String> {
    require_main_window(&window)?;
    let _configuration = state.configuration.lock().await;
    let fence = crate::account_session::AccountDispatchFence::capture()?;
    let scope =
        authorized_scope::command_scope(Some(request.workspace_id), None, ScopeAccess::Write)?;
    let config = Config {
        enabled: request.enabled,
        port: request.port,
    };
    if config.port < 1024 {
        return Err("Choose an event ingress port from 1024 to 65535.".into());
    }
    if config.enabled {
        state.start(config.port).await?;
    } else {
        state.stop()?;
    }
    let store = global_store()?;
    let persisted = store
        .transaction_with_account_fence(&fence, |conn| {
            crate::store::repos::preferences::upsert_scoped(
                conn,
                store,
                &scope.data,
                "event-ingress",
                &encode(&config)?,
                &timestamp(Utc::now()),
            )
        })
        .map_err(|e| e.to_string());
    if let Err(error) = persisted {
        state.stop()?;
        return Err(error);
    }
    state.status(&config, None)
}

#[tauri::command]
pub async fn event_ingress_restore(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, EventIngress>,
    request: IngressRequest,
) -> Result<IngressStatus, String> {
    require_main_window(&window)?;
    let _configuration = state.configuration.lock().await;
    let fence = crate::account_session::AccountDispatchFence::capture()?;
    let scope =
        authorized_scope::command_scope(Some(request.workspace_id), None, ScopeAccess::Read)?;
    let config = config(global_store()?, &scope).map_err(|e| e.to_string())?;
    let prerequisite = if config.enabled {
        state.start(config.port).await.err()
    } else {
        None
    };
    fence.with_current(|| state.status(&config, prerequisite))
}
