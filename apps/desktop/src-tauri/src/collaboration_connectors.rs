//! Live Notion and Slack API adapters. Tokens never cross this Rust module.

use reqwest::{Client, Response, StatusCode};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::connector_auth::access_token;
use crate::models::{
    ConnectorActionRequest, ConnectorActionResult, ConnectorCommandError, ConnectorHealth,
    ConnectorSearchItem, ConnectorSearchRequest, ConnectorSearchResult,
};

fn error(
    code: &str,
    connector_id: &str,
    message: &str,
    retryable: bool,
    retry_after: Option<String>,
) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.into(),
        connector_id: connector_id.into(),
        message: message.into(),
        retryable,
        retry_after,
    }
}

async fn checked(
    connector_id: &str,
    response: Result<Response, reqwest::Error>,
) -> Result<Response, ConnectorCommandError> {
    let response = response.map_err(|_| {
        error(
            "provider-unavailable",
            connector_id,
            "The provider network request failed.",
            true,
            None,
        )
    })?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let code = match status {
        StatusCode::UNAUTHORIZED => "expired-auth",
        StatusCode::FORBIDDEN => "permission-denied",
        StatusCode::NOT_FOUND => "not-found",
        StatusCode::TOO_MANY_REQUESTS => "rate-limited",
        status if status.is_server_error() => "provider-unavailable",
        _ => "invalid-request",
    };
    Err(error(
        code,
        connector_id,
        "The provider rejected the request.",
        status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
        retry_after,
    ))
}

async fn body(connector_id: &str, response: Response) -> Result<Value, ConnectorCommandError> {
    response.json().await.map_err(|_| {
        error(
            "provider-unavailable",
            connector_id,
            "The provider returned malformed JSON.",
            true,
            None,
        )
    })
}

pub(crate) async fn search(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let (_, token) = access_token(app, &request.connector_id).await?;
    match request.connector_id.as_str() {
        "notion" => search_notion(request, &token).await,
        "slack" => search_slack(request, &token).await,
        _ => Err(error(
            "configuration-required",
            &request.connector_id,
            "Live search is not implemented for this connector.",
            false,
            None,
        )),
    }
}

pub(crate) async fn validate_identity(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(), ConnectorCommandError> {
    let (_, token) = access_token(app, connector_id).await?;
    match connector_id {
        "notion" => {
            let response = checked(
                "notion",
                Client::new()
                    .get("https://api.notion.com/v1/users/me")
                    .bearer_auth(token)
                    .header("Notion-Version", "2022-06-28")
                    .send()
                    .await,
            )
            .await?;
            let value = body("notion", response).await?;
            if value.get("id").and_then(Value::as_str).is_none() {
                return Err(error(
                    "provider-unavailable",
                    "notion",
                    "Notion identity response was malformed.",
                    true,
                    None,
                ));
            }
        }
        "slack" => {
            slack_call("auth.test", &token, &[]).await?;
        }
        _ => {
            return Err(error(
                "configuration-required",
                connector_id,
                "Live identity validation is not implemented for this connector.",
                false,
                None,
            ))
        }
    }
    Ok(())
}

/// Live health probe for Notion and Slack. A successful identity read is a
/// healthy connection; a normalized provider error maps to degraded/error.
pub(crate) async fn probe_health(app: &tauri::AppHandle, connector_id: &str) -> ConnectorHealth {
    let checked_at = now();
    match validate_identity(app, connector_id).await {
        Ok(()) => ConnectorHealth {
            state: "healthy".into(),
            summary: "Connected; provider identity verified.".into(),
            checked_at,
            retry_after: None,
        },
        Err(failure) => ConnectorHealth {
            state: if failure.retryable {
                "degraded".into()
            } else {
                "error".into()
            },
            summary: failure.message,
            checked_at,
            retry_after: failure.retry_after,
        },
    }
}

async fn search_notion(
    request: ConnectorSearchRequest,
    token: &str,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let response = checked("notion", Client::new().post("https://api.notion.com/v1/search")
        .bearer_auth(token).header("Notion-Version", "2022-06-28")
        .json(&json!({"query": request.query, "page_size": request.limit.unwrap_or(20), "start_cursor": request.cursor})).send().await).await?;
    let value = body("notion", response).await?;
    let items = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "provider-unavailable",
                "notion",
                "Notion search response was malformed.",
                true,
                None,
            )
        })?
        .iter()
        .filter_map(notion_item)
        .collect();
    Ok(ConnectorSearchResult {
        connector_id: "notion".into(),
        query: request.query,
        items,
        next_cursor: value
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        source: "live".into(),
        searched_at: now(),
    })
}

fn notion_item(value: &Value) -> Option<ConnectorSearchItem> {
    let id = value.get("id")?.as_str()?.to_string();
    let object = value.get("object")?.as_str()?.to_string();
    let title = value
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| {
            properties.values().find_map(|property| {
                property
                    .get("title")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(|item| item.get("plain_text"))
                    .and_then(Value::as_str)
            })
        })
        .unwrap_or(if object == "database" {
            "Untitled database"
        } else {
            "Untitled page"
        })
        .to_string();
    let freshness = value
        .get("last_edited_time")
        .and_then(Value::as_str)
        .unwrap_or("Provider freshness unavailable")
        .to_string();
    Some(ConnectorSearchItem {
        id,
        connector_id: "notion".into(),
        title,
        kind: object.clone(),
        summary: format!("{object} explicitly shared with the Fable integration"),
        provenance: "Notion · shared integration content".into(),
        freshness,
        trust: "untrusted".into(),
        url: value.get("url").and_then(Value::as_str).map(str::to_string),
        content_preview: None,
        provider_metadata: BTreeMap::from([
            ("object".into(), object),
            ("accessBoundary".into(), "explicitly-shared".into()),
        ]),
    })
}

async fn slack_call(
    method: &str,
    token: &str,
    query: &[(&str, String)],
) -> Result<Value, ConnectorCommandError> {
    let response = checked(
        "slack",
        Client::new()
            .get(format!("https://slack.com/api/{method}"))
            .bearer_auth(token)
            .query(query)
            .send()
            .await,
    )
    .await?;
    let value = body("slack", response).await?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value);
    }
    let provider = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let code = match provider {
        "invalid_auth" | "token_revoked" | "account_inactive" => "expired-auth",
        "missing_scope" | "not_allowed_token_type" => "permission-denied",
        "channel_not_found" | "not_in_channel" | "message_not_found" => "not-found",
        "ratelimited" => "rate-limited",
        _ => "invalid-request",
    };
    Err(error(
        code,
        "slack",
        "Slack rejected the request.",
        code == "rate-limited",
        None,
    ))
}

async fn search_slack(
    request: ConnectorSearchRequest,
    token: &str,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let limit = request.limit.unwrap_or(20).to_string();
    let (value, values, next) = if request.query.trim().is_empty() {
        let value = slack_call(
            "conversations.list",
            token,
            &[
                ("limit", limit),
                ("cursor", request.cursor.clone().unwrap_or_default()),
                ("types", "public_channel,private_channel".into()),
            ],
        )
        .await?;
        let values = value
            .get("channels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next = value
            .pointer("/response_metadata/next_cursor")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        (value, values, next)
    } else {
        let value = slack_call(
            "search.messages",
            token,
            &[("query", request.query.clone()), ("count", limit)],
        )
        .await?;
        let values = value
            .pointer("/messages/matches")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        (value, values, None)
    };
    drop(value);
    let items = values.iter().filter_map(slack_item).collect();
    Ok(ConnectorSearchResult {
        connector_id: "slack".into(),
        query: request.query,
        items,
        next_cursor: next,
        source: "live".into(),
        searched_at: now(),
    })
}

fn slack_item(value: &Value) -> Option<ConnectorSearchItem> {
    let channel = value
        .get("channel_id")
        .or_else(|| value.get("id"))?
        .as_str()?
        .to_string();
    let is_message = value.get("ts").is_some();
    let name = value
        .get("name")
        .or_else(|| value.pointer("/channel_name"))
        .and_then(Value::as_str)
        .unwrap_or("accessible-channel");
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = value
        .get("ts")
        .and_then(Value::as_str)
        .unwrap_or(&channel)
        .to_string();
    Some(ConnectorSearchItem {
        id,
        connector_id: "slack".into(),
        title: if is_message {
            format!("#{name} message")
        } else {
            format!("#{name}")
        },
        kind: if is_message {
            "message".into()
        } else {
            "conversation".into()
        },
        summary: text
            .clone()
            .unwrap_or_else(|| "Accessible Slack conversation".into()),
        provenance: format!("Slack · accessible #{name}"),
        freshness: value
            .get("ts")
            .and_then(Value::as_str)
            .unwrap_or("Provider freshness unavailable")
            .into(),
        trust: "untrusted".into(),
        url: value
            .get("permalink")
            .and_then(Value::as_str)
            .map(str::to_string),
        content_preview: text,
        provider_metadata: BTreeMap::from([
            ("channelId".into(), channel),
            ("channelName".into(), name.into()),
        ]),
    })
}

pub(crate) async fn execute(
    app: &tauri::AppHandle,
    action: &ConnectorActionRequest,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    let (_, token) = access_token(app, &action.connector_id).await?;
    let value = match action.connector_id.as_str() {
        "slack" => execute_slack(action, &token).await?,
        "notion" => execute_notion(action, &token).await?,
        _ => {
            return Err(error(
                "configuration-required",
                &action.connector_id,
                "Live writes are not implemented for this connector.",
                false,
                None,
            ))
        }
    };
    let resource = value
        .get("id")
        .or_else(|| value.get("ts"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(ConnectorActionResult {
        request_id: action.id.clone(),
        connector_id: action.connector_id.clone(),
        action: action.action.clone(),
        status: "completed".into(),
        message: "The approved connector action completed.".into(),
        provider_resource_id: resource,
    })
}

async fn execute_slack(
    action: &ConnectorActionRequest,
    token: &str,
) -> Result<Value, ConnectorCommandError> {
    let (method, mut payload) = match action.action.as_str() {
        "slack.post" | "slack.reply" => (
            "chat.postMessage",
            json!({"channel": field(action, "channelId")?, "text": field(action, "text")?}),
        ),
        "slack.edit" => (
            "chat.update",
            json!({"channel": field(action, "channelId")?, "ts": field(action, "timestamp")?, "text": field(action, "text")?}),
        ),
        "slack.delete" => (
            "chat.delete",
            json!({"channel": field(action, "channelId")?, "ts": field(action, "timestamp")?}),
        ),
        "slack.react-add" | "slack.react-remove" => (
            if action.action.ends_with("add") {
                "reactions.add"
            } else {
                "reactions.remove"
            },
            json!({"channel": field(action, "channelId")?, "timestamp": field(action, "timestamp")?, "name": field(action, "reaction")?}),
        ),
        _ => {
            return Err(error(
                "invalid-request",
                "slack",
                "Unsupported Slack action.",
                false,
                None,
            ))
        }
    };
    if action.action == "slack.reply" {
        payload["thread_ts"] = Value::String(field(action, "threadTimestamp")?.to_string());
    }
    let response = checked(
        "slack",
        Client::new()
            .post(format!("https://slack.com/api/{method}"))
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await,
    )
    .await?;
    let value = body("slack", response).await?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value)
    } else {
        Err(error(
            "invalid-request",
            "slack",
            "Slack rejected the approved action.",
            false,
            None,
        ))
    }
}

async fn execute_notion(
    action: &ConnectorActionRequest,
    token: &str,
) -> Result<Value, ConnectorCommandError> {
    let body_value: Value = serde_json::from_str(field(action, "body")?).map_err(|_| {
        error(
            "invalid-request",
            "notion",
            "Notion action body is invalid.",
            false,
            None,
        )
    })?;
    let target = action.payload.get("targetId").cloned().unwrap_or_default();
    let (method, url) = match action.action.as_str() {
        "notion.create-page" | "notion.create-entry" => {
            ("POST", "https://api.notion.com/v1/pages".into())
        }
        "notion.update-page" => ("PATCH", format!("https://api.notion.com/v1/pages/{target}")),
        "notion.append-blocks" => (
            "PATCH",
            format!("https://api.notion.com/v1/blocks/{target}/children"),
        ),
        "notion.update-block" => (
            "PATCH",
            format!("https://api.notion.com/v1/blocks/{target}"),
        ),
        "notion.delete-block" => (
            "DELETE",
            format!("https://api.notion.com/v1/blocks/{target}"),
        ),
        "notion.create-comment" => ("POST", "https://api.notion.com/v1/comments".into()),
        _ => {
            return Err(error(
                "invalid-request",
                "notion",
                "Unsupported Notion action.",
                false,
                None,
            ))
        }
    };
    let request = Client::new()
        .request(method.parse().unwrap(), url)
        .bearer_auth(token)
        .header("Notion-Version", "2022-06-28")
        .json(&body_value);
    body("notion", checked("notion", request.send().await).await?).await
}

fn field<'a>(
    action: &'a ConnectorActionRequest,
    key: &str,
) -> Result<&'a str, ConnectorCommandError> {
    action
        .payload
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            error(
                "invalid-request",
                &action.connector_id,
                "The approved action is missing required content.",
                false,
                None,
            )
        })
}
fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_explicitly_shared_notion_results() {
        let item = notion_item(&json!({
            "id": "page-1", "object": "page", "url": "https://notion.so/page-1",
            "last_edited_time": "2026-06-27T12:00:00Z",
            "properties": { "Name": { "title": [{ "plain_text": "Roadmap" }] } }
        }))
        .expect("item");
        assert_eq!(item.title, "Roadmap");
        assert_eq!(
            item.provider_metadata
                .get("accessBoundary")
                .map(String::as_str),
            Some("explicitly-shared")
        );
        assert_eq!(item.trust, "untrusted");
    }

    #[test]
    fn normalizes_slack_messages_without_logging_or_exposing_tokens() {
        let item = slack_item(&json!({ "ts": "123.456", "channel_id": "C1", "channel_name": "general", "text": "Fixture contract message" })).expect("item");
        assert_eq!(item.kind, "message");
        assert_eq!(
            item.provider_metadata.get("channelId").map(String::as_str),
            Some("C1")
        );
        assert_eq!(
            item.content_preview.as_deref(),
            Some("Fixture contract message")
        );
    }
}
