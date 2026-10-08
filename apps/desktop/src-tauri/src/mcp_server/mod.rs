//! Mivlet's inbound MCP resource server. This is separate from connector MCP
//! clients and MCP Apps hosting. All authority and credential custody is native.
mod http;
mod models;
mod oauth;
pub(crate) mod repository;
#[cfg(test)]
mod tests;
mod tools;

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::store::{Store, StoreError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
pub(crate) use models::ExternalWorkContext;
use models::*;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
type Result<T> = crate::store::Result<T>;
fn invalid(message: &str) -> StoreError {
    StoreError::Invalid(message.into())
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn random() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| invalid("Secure randomness is unavailable."))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

struct Engine {
    store: &'static Store,
    origin: String,
    config: Config,
    oauth: Mutex<oauth::State>,
    app: Option<tauri::AppHandle>,
    inflight: Arc<tokio::sync::Semaphore>,
    rate: Mutex<(std::time::Instant, u32)>,
}
impl Engine {
    fn transaction<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection, &AuthorizedCommandScope, &mut Saved) -> Result<T>,
    ) -> Result<T> {
        self.store.transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let mut saved = repository::read(conn, self.store, &scope)?;
            let result = f(conn, &scope, &mut saved)?;
            repository::write(conn, self.store, &scope, &saved)?;
            Ok(result)
        })
    }
    fn resource(&self) -> String {
        format!("{}/mcp", self.origin)
    }
    fn changed(&self) {
        if let Some(app) = &self.app {
            let _ = app.emit_to("main", "mivlet-mcp-changed", ());
        }
    }

    fn expire(&self) -> Result<()> {
        let changed = self.transaction(|conn, scope, saved| {
            let now = chrono::Utc::now().timestamp();
            let mut changed = false;
            for grant in &mut saved.grants {
                if !grant.revoked && grant.expires_at <= now {
                    grant.revoked = true;
                    crate::collaboration::external::stop_grant(
                        conn,
                        self.store,
                        scope,
                        Some(&grant.id),
                    )?;
                    changed = true;
                }
            }
            saved.tokens.retain(|t| t.expires_at > now);
            Ok(changed)
        })?;
        if changed {
            self.changed();
        }
        Ok(())
    }
}

struct Running {
    engine: Arc<Engine>,
    task: tauri::async_runtime::JoinHandle<()>,
}
#[derive(Default)]
pub struct Server(Mutex<Option<Running>>);

/// A fresh desktop process starts with no external execution authority.
pub(crate) fn initialize(store: &Store) -> Result<()> {
    store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
        let mut saved = repository::read(conn, store, &scope)?;
        saved.enabled = false;
        saved.tokens.clear();
        crate::collaboration::external::stop_grant(conn, store, &scope, None)?;
        repository::write(conn, store, &scope, &saved)
    })
}

fn main(window: &tauri::WebviewWindow) -> std::result::Result<(), String> {
    if window.label() != "main" {
        return Err("Manage external clients in Mivlet Settings.".into());
    }
    crate::account_session::ensure_current()
}

#[tauri::command]
pub async fn mcp_server_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    config: Config,
) -> std::result::Result<(), String> {
    main(&window)?;
    let store = crate::store::try_global().ok_or("Sign in to Mivlet first.")?;
    http::validate_config(&config).map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
        .await
        .map_err(|_| "This MCP port is unavailable. Choose another port.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "MCP listener unavailable.")?
        .port();
    main(&window)?;
    let server = app.state::<Server>();
    let mut current = server.0.lock().map_err(|_| "MCP server unavailable.")?;
    if current.is_some() {
        return Err("Stop the current MCP server before changing its address.".into());
    }
    let engine = Arc::new(Engine {
        store,
        origin: config
            .public_origin
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}")),
        config,
        oauth: Mutex::new(oauth::State::default()),
        app: Some(app.clone()),
        inflight: Arc::new(tokio::sync::Semaphore::new(16)),
        rate: Mutex::new((std::time::Instant::now(), 0)),
    });
    engine
        .transaction(|_, _, saved| {
            saved.enabled = true;
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    let router = http::router(engine.clone());
    let lifecycle = engine.clone();
    let task = tauri::async_runtime::spawn(async move {
        use std::future::IntoFuture;
        let serving = axum::serve(listener, router).into_future();
        tokio::pin!(serving);
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = &mut serving => break,
                _ = tick.tick() => { if lifecycle.expire().is_err() { break; } }
            }
        }
        let _ = lifecycle.transaction(|conn, scope, saved| {
            saved.enabled = false;
            crate::collaboration::external::stop_grant(conn, lifecycle.store, scope, None)
        });
        lifecycle.changed();
    });
    *current = Some(Running { engine, task });
    Ok(())
}

#[tauri::command]
pub fn mcp_server_stop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> std::result::Result<(), String> {
    main(&window)?;
    let server = app.state::<Server>();
    let mut current = server.0.lock().map_err(|_| "MCP server unavailable.")?;
    if let Some(running) = current.as_ref() {
        running
            .engine
            .transaction(|conn, scope, saved| {
                saved.enabled = false;
                saved.tokens.clear();
                crate::collaboration::external::stop_grant(
                    conn,
                    running.engine.store,
                    scope,
                    None,
                )?;
                saved.record("desktop", "server-stop", None, "stopped");
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        running.engine.changed();
        if let Ok(mut oauth) = running.engine.oauth.lock() {
            *oauth = oauth::State::default();
        }
    }
    if let Some(running) = current.take() {
        running.task.abort();
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_server_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> std::result::Result<Status, String> {
    main(&window)?;
    let store = crate::store::try_global().ok_or("Sign in to Mivlet first.")?;
    let server = app.state::<Server>();
    let mut current = server.0.lock().map_err(|_| "MCP server unavailable.")?;
    let pending = current
        .as_ref()
        .map(|r| {
            r.engine
                .oauth
                .lock()
                .map(|mut state| state.pending())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            let saved = repository::read(conn, store, &scope)?;
            // A failed listener must not leave Settings displaying a live URL
            // or prevent the user from starting a replacement listener.
            if !saved.enabled {
                if let Some(running) = current.take() {
                    running.task.abort();
                }
            }
            Ok(Status {
                endpoint: current.as_ref().map(|r| r.engine.resource()),
                pending,
                grants: saved.grants,
                history: saved.history,
                shareable_work: tools::shareable(conn, store, &scope)?,
            })
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_server_decide(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    decision: Decision,
) -> std::result::Result<(), String> {
    main(&window)?;
    let server = app.state::<Server>();
    let current = server.0.lock().map_err(|_| "MCP server unavailable.")?;
    let engine = &current
        .as_ref()
        .ok_or("Start the MCP server first.")?
        .engine;
    oauth::decide(engine, decision).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_server_revoke(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    grant_id: String,
) -> std::result::Result<(), String> {
    main(&window)?;
    let store = crate::store::try_global().ok_or("Sign in to Mivlet first.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let mut saved = repository::read(conn, store, &scope)?;
            let grant = saved
                .grants
                .iter_mut()
                .find(|g| g.id == grant_id)
                .ok_or_else(|| invalid("Client grant unavailable."))?;
            grant.revoked = true;
            saved.tokens.retain(|t| t.grant_id != grant_id);
            crate::collaboration::external::stop_grant(conn, store, &scope, Some(&grant_id))?;
            saved.record("desktop", "revoke", Some(grant_id), "revoked");
            repository::write(conn, store, &scope, &saved)
        })
        .map_err(|e| e.to_string())?;
    let _ = app.emit_to("main", "mivlet-mcp-changed", ());
    Ok(())
}
