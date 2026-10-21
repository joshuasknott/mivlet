use reqwest::{header, Client, StatusCode};
use serde_json::Value;
use std::time::Duration;

use super::API_BASE;

const MAX_RESPONSE_BYTES: usize = 256 * 1024;

pub fn endpoint(path: &str) -> Result<reqwest::Url, String> {
    let query_ok = path.strip_prefix("/v1/machines?").is_some_and(|query| {
        !query.is_empty()
            && query.len() <= 512
            && query
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"%=&_-.:~".contains(&b))
    });
    if !path.starts_with('/') || path.contains("..") || (path.contains('?') && !query_ok) {
        return Err("Instabox request path is invalid.".into());
    }
    reqwest::Url::parse(&format!("{API_BASE}{path}"))
        .map_err(|_| "Instabox endpoint is invalid.".into())
}

pub fn client() -> Result<Client, String> {
    crate::ensure_rustls_provider();
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "Instabox network client is unavailable.".to_string())
}

pub async fn api_request(
    method: reqwest::Method,
    path: &str,
    key: &str,
    body: Option<Value>,
    idempotency_key: Option<&str>,
) -> Result<Value, String> {
    let url = endpoint(path)?;
    let http = client()?;
    let mut request = http
        .request(method, url)
        .header(header::ACCEPT, "application/json")
        .header("X-API-Key", key);
    if let Some(idempotency_key) = idempotency_key {
        request = request.header("Idempotency-Key", idempotency_key);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| {
        "Instabox could not be reached. Check your connection and try again.".to_string()
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(map_status(status));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Instabox response exceeded Mivlet's safety limit.".into());
    }
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Instabox returned an invalid response.".to_string())?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err("Instabox response exceeded Mivlet's safety limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Instabox returned an invalid response.".into())
}

pub fn map_status(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED => {
            "Instabox rejected this API key. Reconnect or revoke it in Instabox.".into()
        }
        StatusCode::FORBIDDEN => {
            "This Instabox account or key does not have the required computer permission.".into()
        }
        StatusCode::NOT_FOUND => "The selected Instabox computer no longer exists.".into(),
        StatusCode::CONFLICT => {
            "Instabox is already changing this computer. Refresh and try again.".into()
        }
        StatusCode::TOO_MANY_REQUESTS => {
            "Instabox rate-limited this request. Try again shortly.".into()
        }
        s if s.is_server_error() => {
            "Instabox is temporarily unavailable. Try again shortly.".into()
        }
        _ => "Instabox rejected this request.".into(),
    }
}
