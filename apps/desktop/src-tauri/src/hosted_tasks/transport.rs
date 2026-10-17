//! Native-only Clerk capabilities and direct task-worker HTTPS. Tokens and
//! entered cloud keys are never returned to the WebView or persisted locally.
use super::{models::*, *};
use crate::local_computer::authority::OperationTicket;
use crate::store::repos::workspace_directory as directory;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use std::{future::Future, task::Poll};
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    runner_url: String,
    token: String,
    expires_at: i64,
}
pub(crate) fn cloud_scope() -> Result<directory::HostedComputerScope, String> {
    crate::account_session::ensure_current()?;
    crate::store::try_global().ok_or("Account storage unavailable.")?
        .with_conn(directory::resolve_hosted_computer_scope_for_current_user)
        .map_err(|e| e.to_string())?.ok_or("Choose an available hosted workspace and active device before connecting a cloud provider.".into())
}
fn unchanged(scope: &directory::HostedComputerScope) -> Result<(), String> {
    if cloud_scope()? != *scope {
        return Err(
            "The selected hosted workspace or device changed. Review a new cloud request.".into(),
        );
    }
    Ok(())
}
pub(crate) async fn call(
    ticket: &OperationTicket,
    scope: &directory::HostedComputerScope,
    agent: &str,
    kind: &str,
    resource: &str,
    operation: &str,
    body: Value,
    hash_body: Option<Value>,
    expected_runner: Option<&str>,
    work: Option<&Binding>,
) -> Result<(Value, String), String> {
    ticket.check()?;
    unchanged(scope)?;
    valid_id(agent)?;
    valid_id(resource)?;
    if let Some(work) = work {
        super::dispatch::with_current(work, || Ok(()))?;
    }
    let before = crate::clerk_identity::native_identity_generation_snapshot()?;
    let digest = digest_value(hash_body.as_ref().unwrap_or(&body))?;
    let envelope = crate::clerk_identity::call_convex_http_route(
        "/native/task-capability",
        json!({
            "workspaceId": scope.workspace_id, "deviceId": scope.device_id, "agentId": agent,
            "scope": format!("{}:{operation}", if kind == "tasks" { "task" } else { "credential" }),
            "resourceId": resource, "requestSha256": digest,
        }),
    )
    .await?;
    if crate::clerk_identity::native_identity_generation_snapshot()? != before {
        return Err("The account changed during cloud authorization.".into());
    }
    let capability: Capability = serde_json::from_value(
        envelope
            .get("value")
            .cloned()
            .filter(|_| envelope.get("status").and_then(Value::as_str) == Some("success"))
            .ok_or("Cloud task authorization is unavailable.")?,
    )
    .map_err(|_| "The cloud task capability failed validation.")?;
    let base = validate_capability(&capability, expected_runner)?;
    unchanged(scope)?;
    let dispatch = crate::account_session::AccountDispatchFence::capture()?;
    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|_| "Invalid cloud task URL.")?
        .clear()
        .extend(["v1", kind, resource, operation]);
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "The cloud task connection is unavailable.")?;
    // Build only while the pinned identity is current. Request bytes have no
    // renderer-controlled endpoint, host override, credentials or redirect.
    let send = dispatch.with_current(|| {
        if capability.expires_at <= chrono::Utc::now().timestamp_millis() {
            return Err("Cloud task authorization expired.".into());
        }
        client
            .post(url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("MivletTask {}", capability.token),
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .build()
            .map_err(|_| "The cloud task request could not be encoded.".into())
    })?;
    let mut exchange = Box::pin(client.execute(send));
    let guarded = futures_util::future::poll_fn(|cx| {
        let mut poll =
            || ticket.with_current(|| dispatch.with_current(|| Ok(exchange.as_mut().poll(cx))));
        let current = if let Some(work) = work {
            super::dispatch::with_current(work, poll)
        } else {
            poll()
        };
        match current {
            Ok(value) => value.map(|value| value.map_err(|_| "Cloud task delivery is uncertain. Refresh its saved state; it was not sent to a local provider.".to_string())),
            Err(error) => Poll::Ready(Err(error)),
        }
    });
    tokio::pin!(guarded);
    let response = loop {
        tokio::select! {
            value = &mut guarded => break value?,
            _ = tokio::time::sleep(Duration::from_millis(100)) => { ticket.check()?; crate::account_session::ensure_current()?; }
        }
    };
    let status = response.status();
    let mut bytes = Vec::new();
    if response
        .content_length()
        .is_some_and(|length| length > 131_072)
    {
        return Err("The cloud task response exceeded its limit.".into());
    }
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        ticket.check()?;
        let chunk = chunk
            .map_err(|_| "The cloud task response was interrupted. Refresh its saved state.")?;
        if bytes.len() + chunk.len() > 131_072 {
            return Err("The cloud task response exceeded its limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if crate::clerk_identity::native_identity_generation_snapshot()? != before {
        return Err("The account changed during the cloud request.".into());
    }
    unchanged(scope)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The cloud task returned an invalid response.")?;
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|code| {
                code.len() <= 80 && code.bytes().all(|c| c.is_ascii_lowercase() || c == b'-')
            })
            .unwrap_or("hosted-task-unavailable");
        return Err(format!("Cloud task request failed ({code})."));
    }
    Ok((value, base.to_string().trim_end_matches('/').to_string()))
}
fn validate_capability(cap: &Capability, expected: Option<&str>) -> Result<Url, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let base = Url::parse(&cap.runner_url).map_err(|_| "Cloud tasks are not configured.")?;
    if base.scheme() != "https"
        || base.host_str().is_none_or(|host| !host.contains('.'))
        || !base.username().is_empty()
        || base.password().is_some()
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
        || base.port().is_some()
        || cap.expires_at <= now
        || cap.expires_at > now + 120_000
        || !cap.token.starts_with("mt1.")
        || !(16..=4096).contains(&cap.token.len())
        || cap.token.chars().any(char::is_whitespace)
        || expected
            .is_some_and(|value| value.trim_end_matches('/') != base.as_str().trim_end_matches('/'))
    {
        return Err(
            "The configured cloud task target or capability changed. Review a new request.".into(),
        );
    }
    Ok(base)
}
pub(crate) async fn connections(
    ticket: &OperationTicket,
    scope: &directory::HostedComputerScope,
    agent: &str,
) -> Result<(Vec<ProviderConnection>, String), String> {
    let (value, runner) = call(
        ticket,
        scope,
        agent,
        "credentials",
        "connections",
        "read",
        json!({"resourceId":"connections"}),
        None,
        None,
        None,
    )
    .await?;
    let values: Vec<ProviderConnection> =
        serde_json::from_value(value).map_err(|_| "Invalid cloud provider connections.")?;
    if values.len() > 8
        || values.iter().any(|c| {
            valid_id(&c.credential_id).is_err()
                || !supported_provider(&c.provider_id)
                || c.revision == 0
                || c.expires_at < c.created_at
                || c.updated_at < c.created_at
        })
    {
        return Err("Invalid cloud provider connections.".into());
    }
    Ok((values, runner))
}
pub(crate) async fn enroll(
    ticket: &OperationTicket,
    scope: &directory::HostedComputerScope,
    agent: &str,
    metadata: &Enrollment,
    secret: &str,
    runner: &str,
) -> Result<ProviderConnection, String> {
    let metadata = serde_json::to_value(metadata).map_err(|_| "Invalid cloud connection.")?;
    let (value, _) = call(
        ticket,
        scope,
        agent,
        "credentials",
        metadata["credentialId"]
            .as_str()
            .ok_or("Invalid cloud connection.")?,
        "enroll",
        json!({"metadata":metadata,"secret":secret}),
        Some(metadata.clone()),
        Some(runner),
        None,
    )
    .await?;
    serde_json::from_value(value).map_err(|_| "Cloud provider delivery is uncertain. Refresh the connection list before entering it again.".into())
}
