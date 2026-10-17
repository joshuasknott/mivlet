//! Optional phone/web client over the existing scoped Work server. OAuth tokens
//! and PKCE stay native; the browser receives only an HttpOnly session cookie.
use super::{hash, invalid, oauth, random, repository, tools, Engine, Result};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode, Uri},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use zeroize::Zeroizing;

pub(crate) mod managed;
pub(super) mod push;
mod session;
pub(super) use session::Sessions;
#[cfg(test)]
mod tests;

pub(super) fn router() -> Router<Arc<Engine>> {
    Router::new()
        .route("/remote", get(page))
        .route("/remote/app.js", get(script))
        .route("/remote/styles.css", get(styles))
        .route("/remote/sw.js", get(worker))
        .route("/remote/manifest.webmanifest", get(manifest))
        .route("/remote/icon.png", get(icon))
        .route("/remote/push", get(push::status).post(push::subscribe))
        .route("/remote/connect", post(connect))
        .route("/remote/callback", get(callback))
        .route("/remote/session", get(current))
        .route("/remote/call", post(call))
        .route("/remote/disconnect", post(disconnect))
}
async fn page() -> Html<&'static str> {
    Html(include_str!("index.html"))
}
async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        Json(json!({
            "id":"/remote", "name":"Mivlet", "short_name":"Mivlet", "start_url":"/remote",
            "scope":"/remote", "display":"standalone", "background_color":"#faf9f7", "theme_color":"#faf9f7",
            "icons":[{"src":"/remote/icon.png","sizes":"256x256","type":"image/png"}]
        })),
    )
}
async fn icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/png")],
        &include_bytes!("../../../icons/128x128@2x.png")[..],
    )
}
async fn script() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("app.js"),
    )
}
async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("styles.css"),
    )
}
async fn worker() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (
                header::HeaderName::from_static("service-worker-allowed"),
                "/remote",
            ),
        ],
        include_str!("sw.js"),
    )
}

fn failure(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
fn cookie_name(engine: &Engine) -> &'static str {
    if engine.origin.starts_with("https://") {
        "__Host-mivlet-remote"
    } else {
        "mivlet-remote-local"
    }
}
fn cookie(engine: &Engine, headers: &HeaderMap) -> Result<String> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        let value = header
            .to_str()
            .map_err(|_| invalid("Connect this browser again."))?;
        for pair in value.split(';') {
            if let Some((name, value)) = pair.trim().split_once('=') {
                if name == cookie_name(engine) {
                    if found.is_some()
                        || value.len() != 43
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                    {
                        return Err(invalid("Connect this browser again."));
                    }
                    found = Some(value.to_owned());
                }
            }
        }
    }
    found.ok_or_else(|| invalid("Connect this browser to Mivlet."))
}
fn set_cookie(engine: &Engine, response: &mut Response, value: &str, seconds: i64) {
    let secure = if engine.origin.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    let value = format!(
        "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={seconds}{secure}",
        cookie_name(engine)
    );
    response
        .headers_mut()
        .insert(header::SET_COOKIE, value.parse().expect("opaque cookie"));
}

async fn connect(State(engine): State<Arc<Engine>>, headers: HeaderMap) -> Response {
    match session::begin(&engine, &headers) {
        Ok((id, ticket)) => {
            let mut response =
                Json(json!({"authorizeUrl":format!("/oauth/wait/{ticket}")})).into_response();
            set_cookie(&engine, &mut response, &id, 300);
            response
        }
        Err(error) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}

async fn callback(State(engine): State<Arc<Engine>>, headers: HeaderMap, uri: Uri) -> Response {
    match session::finish(&engine, &headers, uri.query().unwrap_or_default()) {
        Ok((id, seconds)) => {
            let mut response = Redirect::to("/remote").into_response();
            set_cookie(&engine, &mut response, &id, seconds);
            response
        }
        Err(_) => {
            // Never reflect an authorization code, verifier or token into an error.
            let mut response = Redirect::to("/remote?connection=failed").into_response();
            set_cookie(&engine, &mut response, "", 0);
            response
        }
    }
}

async fn current(State(engine): State<Arc<Engine>>, headers: HeaderMap) -> Response {
    let result = session::authenticated(&engine, &headers).and_then(|(token, grant)| {
        let agents = tools::invoke(&engine, &token, "mivlet_agents", json!({"workspaceId":grant.workspace_id}))?;
        Ok(json!({"workspaceId":grant.workspace_id,"access":grant.access,"expiresAt":grant.expires_at,"agents":agents["agents"]}))
    });
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => failure(
            StatusCode::UNAUTHORIZED,
            "Connect this browser to Mivlet. Access may have expired or been revoked.",
        ),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    name: String,
    arguments: Value,
}
async fn call(State(engine): State<Arc<Engine>>, headers: HeaderMap, body: Bytes) -> Response {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let Ok(request) = serde_json::from_slice::<Call>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "Invalid task request.");
    };
    if session::authenticated(&engine, &headers).is_err() {
        return failure(StatusCode::UNAUTHORIZED, "Connect this browser again.");
    }
    match invoke_call(&engine, &headers, request) {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}
fn invoke_call(engine: &Engine, headers: &HeaderMap, request: Call) -> Result<Value> {
    if ![
        "mivlet_work",
        "mivlet_read_work",
        "mivlet_request_task",
        "mivlet_message_work",
        "mivlet_stop_work",
    ]
    .contains(&request.name.as_str())
    {
        return Err(invalid("This action is unavailable from the phone view."));
    }
    let (token, _) = session::authenticated(engine, headers)?;
    tools::invoke(engine, &token, &request.name, request.arguments)
}

async fn disconnect(State(engine): State<Arc<Engine>>, headers: HeaderMap) -> Response {
    if let Ok(id) = cookie(&engine, &headers) {
        push::remove(&engine, &hash(&id));
        if let Ok(mut sessions) = engine.remote.lock() {
            sessions.remove(&hash(&id));
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    set_cookie(&engine, &mut response, "", 0);
    response
}
