//! Authenticated Convex and runner transport for hosted computer calls.

use super::*;
use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::store::repos::workspace_directory as directory;
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{header, Method};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

fn unwrap_success(envelope: Value) -> Result<Value, String> {
    let object = envelope
        .as_object()
        .ok_or_else(|| "The hosted computer response is malformed.".to_string())?;
    if object.len() != 2 || object.get("status").and_then(Value::as_str) != Some("success") {
        return Err("The hosted computer request was rejected.".into());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(|| "The hosted computer response omitted its value.".into())
}

pub(super) async fn call_convex(
    function_type: ConvexFunctionType,
    path: &str,
    args: Value,
) -> Result<Value, String> {
    let before = clerk_identity::native_identity_generation_snapshot()?;
    let envelope = clerk_identity::call_convex(ConvexIdentityCallRequest {
        function_type,
        function_path: path.to_string(),
        args,
    })
    .await?;
    let after = clerk_identity::native_identity_generation_snapshot()
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != before {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&before)?;
    unwrap_success(envelope)
}

pub(super) fn require_matching_hosted_scope(
    workspace_id: &str,
    device_id: Option<&str>,
) -> Result<directory::HostedComputerScope, String> {
    let store =
        crate::store::try_global().ok_or_else(|| "Account storage unavailable.".to_string())?;
    let scope = store
        .with_conn(directory::resolve_hosted_computer_scope_for_current_user)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "Select an available hosted workspace before using its computer.".to_string()
        })?;
    if !directory::hosted_scope_matches(&scope, workspace_id, device_id) {
        return Err("The hosted computer request does not match the selected workspace.".into());
    }
    Ok(scope)
}

fn validate_capability(
    receipt: HostedExecutionCapabilityReceipt,
) -> Result<(HostedExecutionCapabilityReceipt, Url), String> {
    let now = Utc::now().timestamp_millis();
    if !valid_id(&receipt.computer_id)
        || receipt.generation < 1
        || receipt.expires_at <= now
        || receipt.expires_at > now + 5 * 60_000
        || !(16..=4096).contains(&receipt.token.len())
        || receipt.token.chars().any(char::is_whitespace)
        || !receipt.token.starts_with("v1.")
    {
        return Err("The hosted execution capability failed validation.".into());
    }
    let url = Url::parse(&receipt.runner_url)
        .map_err(|_| "The hosted runner URL failed validation.".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(|host| !host.contains('.'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The hosted runner URL failed validation.".into());
    }
    Ok((receipt, url))
}

pub(super) async fn request_execution_capability(
    workspace_id: &str,
    agent_id: &str,
    device_id: &str,
    scope: &str,
) -> Result<(HostedExecutionCapabilityReceipt, Url), String> {
    require_matching_hosted_scope(workspace_id, Some(device_id))?;
    let before = clerk_identity::native_identity_generation_snapshot()?;
    let envelope = clerk_identity::call_convex_http_route(
        "/native/execution-capability",
        json!({
            "workspaceId": workspace_id,
            "agentId": agent_id,
            "deviceId": device_id,
            "scope": scope
        }),
    )
    .await?;
    let after = clerk_identity::native_identity_generation_snapshot()
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != before {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&before)?;
    let value = unwrap_success(envelope)?;
    let receipt: HostedExecutionCapabilityReceipt = serde_json::from_value(value)
        .map_err(|_| "The hosted execution capability failed validation.".to_string())?;
    validate_capability(receipt)
}

pub(super) fn runner_url(base: &Url, computer_id: &str, suffix: &[&str]) -> Result<Url, String> {
    let mut url = base.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "The hosted runner URL failed validation.".to_string())?;
        segments.clear().extend(["v1", "computers", computer_id]);
        segments.extend(suffix.iter().copied());
    }
    Ok(url)
}

pub(super) async fn runner_json(
    method: Method,
    url: Url,
    token: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Mivlet could not initialize the hosted runner connection.".to_string())?;
    let mut request = client
        .request(method, url)
        .header(header::AUTHORIZATION, format!("MivletCapability {token}"))
        .header(header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The hosted runner is unavailable.".to_string())?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RUNNER_RESPONSE_BYTES as u64)
    {
        return Err("The hosted runner response was too large.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The hosted runner response was interrupted.".to_string())?;
        if bytes.len() + chunk.len() > MAX_RUNNER_RESPONSE_BYTES {
            return Err("The hosted runner response was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The hosted runner returned an invalid response.".to_string())?;
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("request-rejected");
        return Err(format!("The hosted runner rejected the request ({code})."));
    }
    Ok(value)
}

pub(super) async fn fetch_process_snapshot(
    method: Method,
    target: &HostedProcessTarget,
    suffix: &[&str],
) -> Result<HostedProcessSnapshot, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
        || !validate_process_id(&target.process_id)
    {
        return Err("The hosted process target is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let scope = if suffix == ["kill"] {
        "process:kill"
    } else {
        "process:inspect"
    };
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        scope,
    )
    .await?;
    let mut path = vec!["processes", target.process_id.as_str()];
    path.extend_from_slice(suffix);
    let value = runner_json(
        method,
        runner_url(&base, &capability.computer_id, &path)?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedProcessSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process response failed validation.".to_string())?;
    validate_process_snapshot(&snapshot, None, None, Some(&target.process_id))?;
    Ok(snapshot)
}
