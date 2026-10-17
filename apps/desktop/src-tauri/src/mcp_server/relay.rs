//! Outbound managed phone owner. The renderer asserts scope, never an endpoint,
//! token, route, HTTP header, target port or task authority.
use super::*;
use crate::account_session::AccountDispatchFence;
use crate::store::repos::workspace_directory::{self as directory, HostedComputerScope};
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::WriteHalf;
use url::Url;

#[derive(Default)]
pub struct PhoneRelay(Mutex<Option<Arc<Owner>>>);
struct Owner {
    local_workspace: String,
    scope: HostedComputerScope,
    epoch: String,
    account: AccountDispatchFence,
    cancelled: AtomicBool,
    retired: AtomicBool,
    delivery: Mutex<()>,
    status: Mutex<PhoneRelayStatus>,
    engine: Mutex<Option<Arc<Engine>>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneRelayStatus {
    state: String,
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phone_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connect {
    workspace_id: String,
    cloud_workspace_id: String,
    device_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Disconnect {
    connection_id: String,
    epoch: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    connection_id: String,
    relay_url: String,
    token: String,
    expires_at: i64,
    session_expires_at: i64,
}

fn delivery_current<T>(
    gate: &Mutex<()>,
    cancelled: &AtomicBool,
    operation: impl FnOnce() -> std::result::Result<T, String>,
) -> std::result::Result<T, String> {
    let _delivery = gate.lock().map_err(|_| "Phone delivery unavailable.")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("The phone connection ended.".into());
    }
    operation()
}
fn cancel_delivery(gate: &Mutex<()>, cancelled: &AtomicBool) {
    match gate.lock() {
        Ok(_delivery) => cancelled.store(true, Ordering::Release),
        Err(_) => cancelled.store(true, Ordering::Release),
    }
}

fn scope() -> std::result::Result<(String, Option<HostedComputerScope>), String> {
    let local = authorized_scope::active_command_scope(ScopeAccess::Read)?;
    let cloud = crate::store::try_global()
        .ok_or("Account storage unavailable.")?
        .with_conn(directory::resolve_hosted_computer_scope_for_current_user)
        .map_err(|e| e.to_string())?;
    Ok((local.data.workspace_id().into(), cloud))
}
impl Owner {
    fn check(&self) -> std::result::Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("The phone connection ended. Connect again in Settings.".into());
        }
        if self
            .status
            .lock()
            .map_err(|_| "Phone status unavailable.")?
            .expires_at
            .is_some_and(|time| time <= chrono::Utc::now().timestamp_millis())
        {
            return Err("The phone link expired. Connect again in Settings.".into());
        }
        self.scope_current()
    }
    fn scope_current(&self) -> std::result::Result<(), String> {
        self.account.with_current(|| Ok(()))?;
        let (workspace, cloud) = scope()?;
        if workspace != self.local_workspace || cloud.as_ref() != Some(&self.scope) {
            return Err(
                "The account, workspace or device changed. Connect your phone again.".into(),
            );
        }
        Ok(())
    }
    fn close(&self, error: Option<&str>) -> bool {
        // Serialize Stop against individual nonblocking network polls. No
        // account/Store I/O runs while holding this short delivery gate.
        cancel_delivery(&self.delivery, &self.cancelled);
        if let Ok(mut state) = self.status.lock() {
            state.state = "disconnected".into();
            state.phone_url = None;
            state.error = error.map(str::to_owned);
        }
        let mut persisted = false;
        if let Ok(mut current) = self.engine.lock() {
            persisted = true;
            if let Some(engine) = current.take() {
                if let Ok(mut sessions) = engine.remote.lock() {
                    *sessions = remote::Sessions::default();
                }
                let stopped = engine.transaction(|conn, scope, saved| {
                    saved.enabled = false;
                    saved.tokens.clear();
                    crate::collaboration::external::stop_grant(conn, engine.store, scope, None)
                });
                engine.changed();
                if stopped.is_err() {
                    *current = Some(engine);
                    persisted = false;
                }
            }
        }
        if persisted {
            self.retired.store(true, Ordering::Release);
        } else if let Ok(mut state) = self.status.lock() {
            state.error = Some("Phone access closed, but its task Stop requests could not be saved. Retry Disconnect when account storage is available.".into());
        }
        persisted
    }
}
fn owner(app: &tauri::AppHandle) -> Option<Arc<Owner>> {
    app.state::<PhoneRelay>().0.lock().ok()?.clone()
}
pub(super) fn active(app: &tauri::AppHandle) -> bool {
    owner(app).is_some_and(|owner| !owner.retired.load(Ordering::Acquire))
}
pub(super) fn engine(app: &tauri::AppHandle) -> Option<Arc<Engine>> {
    let owner = owner(app)?;
    owner.check().ok()?;
    let engine = owner.engine.lock().ok()?.clone();
    engine
}
#[tauri::command]
pub fn phone_relay_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> std::result::Result<PhoneRelayStatus, String> {
    main(&window)?;
    if let Some(owner) = owner(&app) {
        if owner.scope_current().is_err() {
            if !owner.close(Some("Your account sign-in changed or refreshed. Connect again and approve this browser in Settings.")) {
                return Err("Previous phone access is still closing. Restore account storage before reconnecting.".into());
            }
            let relay = app.state::<PhoneRelay>();
            let mut current = relay
                .0
                .lock()
                .map_err(|_| "Phone connection unavailable.")?;
            if current
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &owner))
            {
                *current = None;
            }
        } else {
            return owner
                .status
                .lock()
                .map(|status| status.clone())
                .map_err(|_| "Phone status unavailable.".into());
        }
    }
    let (workspace, cloud) = scope()?;
    Ok(PhoneRelayStatus {
        state: "stopped".into(),
        workspace_id: workspace,
        cloud_workspace_id: cloud.as_ref().map(|s| s.workspace_id.clone()),
        device_id: cloud.map(|s| s.device_id),
        connection_id: None,
        epoch: None,
        phone_url: None,
        expires_at: None,
        error: None,
    })
}
#[tauri::command]
pub async fn phone_relay_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Connect,
) -> std::result::Result<PhoneRelayStatus, String> {
    main(&window)?;
    let account = AccountDispatchFence::capture()?;
    let (workspace, cloud) = scope()?;
    let cloud = cloud.ok_or(
        "Choose an available synced workspace and active device before connecting your phone.",
    )?;
    if request.workspace_id != workspace
        || request.cloud_workspace_id != cloud.workspace_id
        || request.device_id != cloud.device_id
    {
        return Err(
            "The displayed workspace or device changed. Refresh before connecting your phone."
                .into(),
        );
    }
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Secure randomness unavailable.")?;
    let epoch = hex::encode(bytes);
    let next = Arc::new(Owner {
        local_workspace: workspace.clone(),
        scope: cloud.clone(),
        epoch: epoch.clone(),
        account,
        cancelled: AtomicBool::new(false),
        retired: AtomicBool::new(false),
        delivery: Mutex::new(()),
        engine: Mutex::new(None),
        status: Mutex::new(PhoneRelayStatus {
            state: "connecting".into(),
            workspace_id: workspace,
            cloud_workspace_id: Some(cloud.workspace_id),
            device_id: Some(cloud.device_id),
            connection_id: None,
            epoch: Some(epoch),
            phone_url: None,
            expires_at: None,
            error: None,
        }),
    });
    {
        // Both transports reserve under Server -> PhoneRelay lock order. No
        // await or Store I/O occurs inside this admission critical section.
        let server = app.state::<Server>();
        let server = server
            .0
            .lock()
            .map_err(|_| "External access unavailable.")?;
        if server.is_some() {
            return Err(
                "Stop the manual MCP server before connecting managed phone access.".into(),
            );
        }
        let relay = app.state::<PhoneRelay>();
        let mut current = relay
            .0
            .lock()
            .map_err(|_| "Phone connection unavailable.")?;
        if current
            .as_ref()
            .is_some_and(|owner| !owner.retired.load(Ordering::Acquire))
        {
            return Err("Disconnect the current phone link before connecting again.".into());
        }
        next.account.with_current(|| {
            *current = Some(next.clone());
            Ok(())
        })?;
    }
    let result = connect(&app, &next).await;
    if let Err(error) = result {
        next.close(Some(
            "The phone relay could not connect. Check your account connection and try again.",
        ));
        return Err(error);
    }
    next.check()?;
    delivery_current(&next.delivery, &next.cancelled, || {
        next.account.with_current(|| {
            next.status
                .lock()
                .map(|s| s.clone())
                .map_err(|_| "Phone status unavailable.".into())
        })
    })
}
#[tauri::command]
pub fn phone_relay_disconnect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Disconnect,
) -> std::result::Result<PhoneRelayStatus, String> {
    main(&window)?;
    let relay = app.state::<PhoneRelay>();
    let current = relay
        .0
        .lock()
        .map_err(|_| "Phone connection unavailable.")?
        .clone()
        .ok_or("The phone connection already ended.")?;
    {
        let state = current
            .status
            .lock()
            .map_err(|_| "Phone status unavailable.")?;
        if state.connection_id.as_deref() != Some(&request.connection_id)
            || state.epoch.as_deref() != Some(&request.epoch)
        {
            return Err("The phone link changed. Refresh before disconnecting.".into());
        }
    }
    if !current.close(None) {
        return Err("Phone access closed, but its task Stop requests are unconfirmed. Retry Disconnect when account storage is available.".into());
    }
    let mut value = relay
        .0
        .lock()
        .map_err(|_| "Phone connection unavailable.")?;
    if value
        .as_ref()
        .is_some_and(|owner| Arc::ptr_eq(owner, &current))
    {
        *value = None;
    }
    drop(value);
    phone_relay_status(app, window)
}

async fn capability(owner: &Owner) -> std::result::Result<Capability, String> {
    owner.check()?;
    let envelope = crate::clerk_identity::call_convex_http_route("/native/phone-relay-capability", json!({
        "workspaceId":owner.scope.workspace_id,"deviceId":owner.scope.device_id,"epoch":owner.epoch,
    })).await?;
    owner.check()?;
    let cap: Capability = serde_json::from_value(
        envelope
            .get("value")
            .cloned()
            .filter(|_| envelope.get("status").and_then(Value::as_str) == Some("success"))
            .ok_or("Managed phone access is not configured.")?,
    )
    .map_err(|_| "Invalid phone connection capability.")?;
    validate_capability(&cap)?;
    Ok(cap)
}
fn validate_capability(cap: &Capability) -> std::result::Result<Url, String> {
    let url = Url::parse(&cap.relay_url).map_err(|_| "Managed phone access is not configured.")?;
    let now = chrono::Utc::now().timestamp_millis();
    if url.scheme() != "https"
        || url.host_str().is_none_or(|host| !host.contains('.'))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || cap.connection_id.len() != 64
        || !cap
            .connection_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || cap.expires_at <= now
        || cap.expires_at > now + 120_000
        || cap.session_expires_at < cap.expires_at
        || cap.session_expires_at > now + 8 * 3600 * 1000
        || !cap.token.starts_with("mp1.")
        || !(16..=4096).contains(&cap.token.len())
        || cap.token.chars().any(char::is_whitespace)
    {
        return Err("The phone relay target or capability failed validation.".into());
    }
    Ok(url)
}
type Writer = Arc<tokio::sync::Mutex<WriteHalf<reqwest::Upgraded>>>;
async fn send(owner: &Owner, writer: &Writer, value: &Value) -> std::result::Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Invalid phone relay message.")?;
    let mut writer = writer.lock().await;
    owner.check()?;
    let mut delivery = Box::pin(super::relay_socket::write(&mut *writer, 1, &bytes));
    use std::future::Future;
    futures_util::future::poll_fn(|cx| {
        let result = (|| {
            let _gate = owner
                .delivery
                .lock()
                .map_err(|_| "Phone delivery unavailable.")?;
            if owner.cancelled.load(Ordering::Acquire) {
                return Err("Phone connection ended.".to_string());
            }
            owner
                .account
                .with_current(|| Ok(delivery.as_mut().poll(cx)))
        })();
        result.unwrap_or_else(|error| std::task::Poll::Ready(Err(error)))
    })
    .await
}
async fn connect(app: &tauri::AppHandle, owner: &Arc<Owner>) -> std::result::Result<(), String> {
    let cap = capability(owner).await?;
    let base = validate_capability(&cap)?;
    let mut url = base.clone();
    url.set_path(&format!("/v1/phone/{}/connect", cap.connection_id));
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .no_proxy()
        .http1_only()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Phone relay connection unavailable.")?;
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "Secure randomness unavailable.")?;
    let key = STANDARD.encode(random);
    let request = client
        .get(url)
        .header("Authorization", format!("MivletPhone {}", cap.token))
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", &key)
        .build()
        .map_err(|_| "Invalid phone relay connection.")?;
    owner.check()?;
    let mut exchange = Box::pin(client.execute(request));
    use std::future::Future;
    let exchange = futures_util::future::poll_fn(|cx| {
        let result = (|| {
            let _gate = owner
                .delivery
                .lock()
                .map_err(|_| "Phone delivery unavailable.")?;
            owner.account.with_current(|| {
                if owner.cancelled.load(Ordering::Acquire) {
                    return Err("The phone connection ended.".into());
                }
                Ok(exchange.as_mut().poll(cx))
            })
        })();
        result.map_or_else(
            |error| std::task::Poll::Ready(Err(error)),
            |poll| poll.map(|v| v.map_err(|_| "Phone relay connection unavailable.".to_string())),
        )
    });
    let response = tokio::time::timeout(Duration::from_secs(10), exchange)
        .await
        .map_err(|_| "Phone relay connection timed out.")??;
    owner.check()?;
    if response.status().as_u16() != 101
        || response
            .headers()
            .get("Upgrade")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|h| !h.eq_ignore_ascii_case("websocket"))
        || response
            .headers()
            .get("Connection")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|h| {
                !h.split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
        || response
            .headers()
            .get("Sec-WebSocket-Accept")
            .and_then(|h| h.to_str().ok())
            != Some(super::relay_socket::accept(&key).as_str())
        || response.headers().contains_key("Sec-WebSocket-Extensions")
        || response.headers().contains_key("Sec-WebSocket-Protocol")
    {
        return Err("Phone relay handshake was rejected.".into());
    }
    let socket = tokio::time::timeout(Duration::from_secs(5), response.upgrade())
        .await
        .map_err(|_| "Phone relay upgrade timed out.")?
        .map_err(|_| "Phone relay upgrade failed.")?;
    let (read, write) = tokio::io::split(socket);
    let writer = Arc::new(tokio::sync::Mutex::new(write));
    let mut reader = super::relay_socket::Reader::new(read);
    let hello = tokio::time::timeout(Duration::from_secs(5), reader.read())
        .await
        .map_err(|_| "Phone relay did not confirm the connection.")??;
    let super::relay_socket::Message::Text(hello) = hello else {
        return Err("Invalid phone relay confirmation.".into());
    };
    let hello: Hello =
        serde_json::from_str(&hello).map_err(|_| "Invalid phone relay confirmation.")?;
    if hello.version != 1
        || hello.kind != "hello"
        || hello.connection_id != cap.connection_id
        || hello.epoch != owner.epoch
        || hello.revision == 0
        || hello.expires_at != cap.expires_at
    {
        return Err("Phone relay confirmation changed scope.".into());
    }
    owner.check()?;
    let store = crate::store::try_global().ok_or("Account storage unavailable.")?;
    let engine = Arc::new(Engine {
        store,
        origin: base.origin().ascii_serialization(),
        config: Config {
            remote_access: true,
            ..Config::default()
        },
        oauth: Mutex::new(oauth::State::default()),
        remote: Mutex::new(remote::Sessions::default()),
        push: remote::push::PushState::default(),
        app: Some(app.clone()),
        inflight: Arc::new(tokio::sync::Semaphore::new(16)),
        rate: Mutex::new((std::time::Instant::now(), 0)),
    });
    owner.check()?;
    {
        let _delivery = owner
            .delivery
            .lock()
            .map_err(|_| "Phone connection unavailable.")?;
        if owner.cancelled.load(Ordering::Acquire) {
            return Err("The phone connection ended before admission.".into());
        }
        *owner
            .engine
            .lock()
            .map_err(|_| "Phone connection unavailable.")? = Some(engine.clone());
    }
    // Store preparation runs outside native gates. Only COMMIT is serialized
    // against exact owner Stop/account closure, so an old await cannot enable a
    // retired engine after its replacement has been admitted.
    engine
        .store
        .transaction_with_commit_fence(
            |conn| {
                let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
                let mut saved = repository::read(conn, engine.store, &scope)?;
                saved.enabled = true;
                repository::write(conn, engine.store, &scope, &saved)
            },
            |tx| {
                let _delivery = owner
                    .delivery
                    .lock()
                    .map_err(|_| invalid("Phone admission unavailable."))?;
                if owner.cancelled.load(Ordering::Acquire) {
                    return Err(invalid("The phone connection ended before admission."));
                }
                owner
                    .account
                    .with_current(|| Ok(tx.commit().map_err(StoreError::from)))
                    .map_err(StoreError::Invalid)??;
                Ok(())
            },
        )
        .map_err(|e| e.to_string())?;
    owner.check()?;
    delivery_current(&owner.delivery, &owner.cancelled, || {
        let mut status = owner
            .status
            .lock()
            .map_err(|_| "Phone status unavailable.")?;
        status.state = "connected".into();
        status.connection_id = Some(cap.connection_id.clone());
        status.phone_url = Some(format!(
            "{}/d/{}/remote",
            base.origin().ascii_serialization(),
            cap.connection_id
        ));
        status.expires_at = Some(cap.session_expires_at);
        Ok(())
    })?;
    engine.changed();
    let owner = owner.clone();
    let origin = base.to_string();
    tauri::async_runtime::spawn(async move {
        let renewal_owner = owner.clone();
        let renewal_writer = writer.clone();
        let connection_id = cap.connection_id.clone();
        let renewal = tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                renewal_owner.check()?;
                let cap = capability(&renewal_owner).await?;
                if cap.connection_id != connection_id
                    || cap.relay_url.trim_end_matches('/') != origin.trim_end_matches('/')
                {
                    return Err::<(), String>("The phone relay target changed.".into());
                }
                renewal_owner.check()?;
                send(
                    &renewal_owner,
                    &renewal_writer,
                    &json!({"version":1,"kind":"renew","token":cap.token}),
                )
                .await?;
            }
        });
        let result = run(
            &owner,
            &engine,
            &mut reader,
            &writer,
            &cap.connection_id,
            hello.revision,
            hello.expires_at,
        )
        .await;
        renewal.abort();
        let _ = super::relay_socket::write(&mut *writer.lock().await, 8, &[]).await;
        owner.close(result.err().as_deref());
    });
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    version: u8,
    kind: String,
    connection_id: String,
    epoch: String,
    revision: u64,
    expires_at: i64,
}

async fn run<R: tokio::io::AsyncRead + Unpin>(
    owner: &Owner,
    engine: &Arc<Engine>,
    reader: &mut super::relay_socket::Reader<R>,
    writer: &Writer,
    connection: &str,
    revision: u64,
    mut deadline: i64,
) -> std::result::Result<(), String> {
    let mut sequence = 0;
    loop {
        let message = reader.read();
        tokio::pin!(message);
        let message = loop {
            tokio::select! {
                value = &mut message => break value?,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    owner.check()?;
                    if chrono::Utc::now().timestamp_millis() >= deadline { return Err("Phone connection authorization expired.".into()); }
                    engine.expire().map_err(|e| e.to_string())?;
                    remote::push::schedule(engine.clone());
                }
            }
        };
        owner.check()?;
        match message {
            super::relay_socket::Message::Close => {
                return Err("Phone relay connection ended. Connect again.".into())
            }
            super::relay_socket::Message::Ping(bytes) => {
                super::relay_socket::write(&mut *writer.lock().await, 10, &bytes).await?
            }
            super::relay_socket::Message::Pong => {}
            super::relay_socket::Message::Text(text) => {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid phone relay message.")?;
                if value.get("kind").and_then(Value::as_str) == Some("renewed") {
                    let renewed: Hello = serde_json::from_value(value)
                        .map_err(|_| "Invalid renewal confirmation.")?;
                    let now = chrono::Utc::now().timestamp_millis();
                    if renewed.version != 1
                        || renewed.connection_id != connection
                        || renewed.epoch != owner.epoch
                        || renewed.revision != revision
                        || renewed.expires_at <= deadline
                        || renewed.expires_at > now + 120_000
                    {
                        return Err("Phone renewal changed scope.".into());
                    }
                    let session_deadline = owner
                        .status
                        .lock()
                        .map_err(|_| "Phone status unavailable.")?
                        .expires_at
                        .ok_or("Phone session lifetime unavailable.")?;
                    deadline = renewed.expires_at.min(session_deadline);
                    continue;
                }
                let request: remote::managed::Request =
                    serde_json::from_value(value).map_err(|_| "Invalid phone relay request.")?;
                if request.version != 1
                    || request.kind != "request"
                    || request.connection_id != connection
                    || request.epoch != owner.epoch
                    || request.revision != revision
                    || request.sequence != sequence + 1
                    || request.request_id.len() > 64
                    || request.request_id.len() < 16
                    || !request
                        .request_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err("Phone relay request did not match this connection.".into());
                }
                sequence = request.sequence;
                owner.check()?;
                if chrono::Utc::now().timestamp_millis() >= deadline {
                    return Err("Phone authorization expired before the request.".into());
                }
                let reply = remote::managed::execute(engine, request);
                owner.check()?;
                send(
                    owner,
                    writer,
                    &serde_json::to_value(reply).map_err(|_| "Invalid phone relay result.")?,
                )
                .await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_paused_connection_cannot_publish_or_deliver_after_stop() {
        let gate = Arc::new(Mutex::new(()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let published = Arc::new(AtomicBool::new(false));
        let (ready, reached) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let worker_gate = gate.clone();
        let worker_cancelled = cancelled.clone();
        let worker_published = published.clone();
        let worker = std::thread::spawn(move || {
            ready.send(()).unwrap();
            paused.recv().unwrap();
            delivery_current(&worker_gate, &worker_cancelled, || {
                worker_published.store(true, Ordering::Release);
                Ok(())
            })
        });
        reached.recv().unwrap();
        cancel_delivery(&gate, &cancelled);
        resume.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(!published.load(Ordering::Acquire));
    }
    #[test]
    fn capability_accepts_only_a_bounded_root_target_and_closed_scope_request() {
        let now = chrono::Utc::now().timestamp_millis();
        let mut cap = Capability {
            connection_id: "a".repeat(64),
            relay_url: "https://phone.example".into(),
            token: "mp1.native-fixture.signature".into(),
            expires_at: now + 60000,
            session_expires_at: now + 28800000,
        };
        assert!(validate_capability(&cap).is_ok());
        for target in [
            "http://phone.example",
            "https://user@phone.example",
            "https://phone.example/path",
            "https://phone.example:8443",
            "https://phone.example/?token=private",
        ] {
            cap.relay_url = target.into();
            assert!(validate_capability(&cap).is_err());
        }
        assert!(serde_json::from_value::<Connect>(json!({"workspaceId":"default","cloudWorkspaceId":"cloud-one","deviceId":"device-one","relayUrl":"https://attacker.example"})).is_err());
        assert!(serde_json::from_value::<Disconnect>(
            json!({"connectionId":"a","epoch":"b","all":true})
        )
        .is_err());
    }
}
