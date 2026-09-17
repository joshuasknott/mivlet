//! Authenticated provider egress for developer connectors.
//! Tokens are resolved from `connector_auth` and never returned to JavaScript.

use std::{collections::BTreeMap, time::Duration};

use reqwest::{Method, Response, StatusCode};
use serde_json::{json, Map, Value};

use crate::{
    connector_auth::{provider_access_token, provider_access_token_for_connection},
    models::{
        ConnectorActionRequest, ConnectorCapabilityRequest, ConnectorCapabilityResult,
        ConnectorCommandError, ConnectorHealth, ConnectorSearchItem, ConnectorSearchRequest,
        ConnectorSearchResult,
    },
    paths::{normalize_spaces, truncate_characters},
};

const MAX_RETRIES: usize = 2;

type QueryParams = Vec<(String, String)>;
type ReadRequestSpec = (Method, String, QueryParams, Option<Value>);
type WriteRequestSpec = (Method, String, QueryParams, Value);

struct ApiResponse {
    value: Value,
    next_cursor: Option<String>,
    remaining: Option<u64>,
    reset_at: Option<String>,
}

fn error(code: &str, connector_id: &str, message: &str, retryable: bool) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable,
        retry_after: None,
    }
}

async fn request_json(
    connector_id: &str,
    token: &str,
    method: Method,
    url: &str,
    query: &[(String, String)],
    body: Option<Value>,
    read_only: bool,
) -> Result<ApiResponse, ConnectorCommandError> {
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Mivlet/0.1 connector-runtime")
        .build()
        .map_err(|_| {
            error(
                "unknown",
                connector_id,
                "Connector HTTP client could not start.",
                false,
            )
        })?;
    for attempt in 0..=MAX_RETRIES {
        let mut builder = client
            .request(method.clone(), url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .query(query);
        if connector_id == "github" {
            builder = builder
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28");
        }
        if let Some(payload) = body.clone() {
            builder = builder.json(&payload);
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(_) if read_only && attempt < MAX_RETRIES => {
                tokio::time::sleep(Duration::from_millis(100 * 2_u64.pow(attempt as u32))).await;
                continue;
            }
            Err(_) => {
                if !read_only {
                    return Err(uncertain_action(connector_id));
                }
                return Err(error(
                    "provider-unavailable",
                    connector_id,
                    "Provider network request failed.",
                    true,
                ));
            }
        };
        if response.status().is_success() {
            return decode_response(connector_id, response)
                .await
                .map_err(|failure| {
                    if read_only {
                        failure
                    } else {
                        uncertain_action(connector_id)
                    }
                });
        }
        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let retryable = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        if retryable && !read_only {
            return Err(uncertain_action(connector_id));
        }
        if retryable && attempt < MAX_RETRIES {
            let wait = retry_after
                .as_deref()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(1)
                .min(10);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        let code = match status {
            StatusCode::UNAUTHORIZED => "expired-auth",
            StatusCode::FORBIDDEN => {
                if response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .and_then(|v| v.to_str().ok())
                    == Some("0")
                {
                    "rate-limited"
                } else {
                    "permission-denied"
                }
            }
            StatusCode::NOT_FOUND => "not-found",
            StatusCode::TOO_MANY_REQUESTS => "rate-limited",
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "invalid-request",
            status if status.is_server_error() => "provider-unavailable",
            _ => "unknown",
        };
        let mut command = error(
            code,
            connector_id,
            provider_message(code),
            retryable || code == "rate-limited",
        );
        command.retry_after = retry_after;
        return Err(command);
    }
    Err(error(
        "provider-unavailable",
        connector_id,
        "Provider request failed.",
        true,
    ))
}

fn uncertain_action(connector_id: &str) -> ConnectorCommandError {
    error("outcome-unknown", connector_id, "The provider may have applied this action, but its response was lost. Check the current state before trying again.", false)
}

async fn decode_response(
    connector_id: &str,
    response: Response,
) -> Result<ApiResponse, ConnectorCommandError> {
    let remaining = header_u64(&response, "x-ratelimit-remaining")
        .or_else(|| header_u64(&response, "x-ratelimit-requests-remaining"));
    let reset_at = response
        .headers()
        .get("x-ratelimit-reset")
        .or_else(|| response.headers().get("x-ratelimit-requests-reset"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let next_cursor = if connector_id == "github" {
        response
            .headers()
            .get("link")
            .and_then(|v| v.to_str().ok())
            .and_then(github_next_page)
    } else {
        None
    };
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(ApiResponse {
            value: json!({"success": true}),
            next_cursor,
            remaining,
            reset_at,
        });
    }
    let value = response.json::<Value>().await.map_err(|_| {
        error(
            "provider-unavailable",
            connector_id,
            "Provider returned a malformed response.",
            true,
        )
    })?;
    if connector_id == "linear" {
        if let Some(errors) = value.get("errors").and_then(Value::as_array) {
            if let Some(first) = errors.first() {
                let provider_code = first
                    .pointer("/extensions/code")
                    .and_then(Value::as_str)
                    .unwrap_or("invalid-request");
                let code = match provider_code {
                    "RATELIMITED" => "rate-limited",
                    "AUTHENTICATION_ERROR" => "expired-auth",
                    "FORBIDDEN" => "permission-denied",
                    _ => "invalid-request",
                };
                return Err(error(
                    code,
                    connector_id,
                    provider_message(code),
                    code == "rate-limited",
                ));
            }
        }
    }
    Ok(ApiResponse {
        value,
        next_cursor,
        remaining,
        reset_at,
    })
}

fn provider_message(code: &str) -> &'static str {
    match code {
        "expired-auth" => "Provider authorization expired; reconnect the account.",
        "permission-denied" => "Provider access lacks the required scope or permission.",
        "not-found" => "The requested provider resource was not found.",
        "rate-limited" => "The provider rate limit was reached.",
        "invalid-request" => "The provider rejected the connector request.",
        "provider-unavailable" => "The provider is temporarily unavailable.",
        _ => "The connector request failed.",
    }
}

fn header_u64(response: &Response, name: &str) -> Option<u64> {
    response.headers().get(name)?.to_str().ok()?.parse().ok()
}
fn github_next_page(link: &str) -> Option<String> {
    link.split(',')
        .find(|part| part.contains("rel=\"next\""))?
        .split("page=")
        .nth(1)?
        .split(['&', '>'])
        .next()
        .map(str::to_string)
}

pub(crate) async fn search(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let connector_id = request.connector_id.as_str();
    let token = provider_access_token(app, connector_id).await?;
    let limit = request.limit.unwrap_or(20).clamp(1, 50);
    let response = match connector_id {
        "github" => {
            let (url, mut query) = if request.query.trim().is_empty() {
                (
                    "https://api.github.com/user/repos",
                    vec![("sort".into(), "updated".into())],
                )
            } else {
                (
                    "https://api.github.com/search/repositories",
                    vec![("q".into(), request.query.clone())],
                )
            };
            query.push(("per_page".into(), limit.to_string()));
            if let Some(cursor) = &request.cursor {
                query.push(("page".into(), cursor.clone()));
            }
            request_json(connector_id, &token, Method::GET, url, &query, None, true).await?
        }
        "vercel" => {
            let mut query = vec![("limit".into(), limit.to_string())];
            if let Some(cursor) = &request.cursor {
                query.push(("until".into(), cursor.clone()));
            }
            request_json(
                connector_id,
                &token,
                Method::GET,
                "https://api.vercel.com/v9/projects",
                &query,
                None,
                true,
            )
            .await?
        }
        "linear" => {
            let query = "query Search($term:String!,$first:Int!,$after:String){ searchIssues(term:$term,first:$first,after:$after){ nodes { id identifier title description url updatedAt team { id key name } state { id name type } } pageInfo { hasNextPage endCursor } } }";
            request_json(connector_id, &token, Method::POST, "https://api.linear.app/graphql", &[], Some(json!({"query": query, "variables": {"term": request.query, "first": limit, "after": request.cursor}})), true).await?
        }
        _ => {
            return Err(error(
                "configuration-required",
                connector_id,
                "This connector does not have a live developer-provider adapter.",
                false,
            ))
        }
    };
    normalize_search(request, response)
}

fn normalize_search(
    request: ConnectorSearchRequest,
    response: ApiResponse,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let values: Vec<Value> = match request.connector_id.as_str() {
        "github" => response
            .value
            .get("items")
            .or(Some(&response.value))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        "vercel" => response
            .value
            .get("projects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        "linear" => response
            .value
            .pointer("/data/searchIssues/nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => vec![],
    };
    let query = request.query.to_ascii_lowercase();
    let items = values
        .into_iter()
        .filter_map(|value| normalize_item(&request.connector_id, value))
        .filter(|item| {
            query.is_empty()
                || item.title.to_ascii_lowercase().contains(&query)
                || item.summary.to_ascii_lowercase().contains(&query)
        })
        .collect();
    let linear_cursor = response
        .value
        .pointer("/data/searchIssues/pageInfo/endCursor")
        .and_then(Value::as_str)
        .map(str::to_string);
    let vercel_cursor = response
        .value
        .pointer("/pagination/next")
        .and_then(Value::as_u64)
        .map(|v| v.to_string());
    Ok(ConnectorSearchResult {
        connector_id: request.connector_id,
        query: request.query,
        items,
        next_cursor: response.next_cursor.or(linear_cursor).or(vercel_cursor),
        source: "live".to_string(),
        searched_at: unix_timestamp(),
    })
}

fn normalize_item(connector_id: &str, value: Value) -> Option<ConnectorSearchItem> {
    let object = value.as_object()?;
    let id = value_string(object, &["id", "node_id"])?;
    let (title, kind, summary, provenance, freshness, url) = match connector_id {
        "github" => {
            let title = value_string(object, &["full_name", "name"])?;
            let summary = value_string(object, &["description"])
                .unwrap_or_else(|| "Accessible GitHub repository".into());
            let freshness = value_string(object, &["updated_at", "pushed_at"])
                .unwrap_or_else(|| "Provider freshness unavailable".into());
            let url = value_string(object, &["html_url"]);
            (
                title.clone(),
                "repository",
                summary,
                format!("GitHub · {title}"),
                freshness,
                url,
            )
        }
        "vercel" => {
            let title = value_string(object, &["name"])?;
            let freshness = object
                .get("updatedAt")
                .and_then(Value::as_u64)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "Provider freshness unavailable".into());
            (
                title.clone(),
                "project",
                "Accessible Vercel project".into(),
                format!("Vercel · {title}"),
                freshness,
                None,
            )
        }
        "linear" => {
            let title = value_string(object, &["title"])?;
            let identifier = value_string(object, &["identifier"]).unwrap_or_else(|| id.clone());
            let summary =
                value_string(object, &["description"]).unwrap_or_else(|| "Linear issue".into());
            let freshness = value_string(object, &["updatedAt"])
                .unwrap_or_else(|| "Provider freshness unavailable".into());
            let url = value_string(object, &["url"]);
            (
                format!("{identifier} · {title}"),
                "issue",
                summary,
                format!("Linear · {identifier}"),
                freshness,
                url,
            )
        }
        _ => return None,
    };
    Some(ConnectorSearchItem {
        id,
        connector_id: connector_id.to_string(),
        connection_id: None,
        title,
        kind: kind.to_string(),
        summary: truncate_characters(&normalize_spaces(&summary), 500),
        provenance,
        freshness,
        trust: "untrusted".to_string(),
        url,
        content_preview: None,
        provider_metadata: BTreeMap::new(),
    })
}

pub(crate) async fn read_capability(
    app: &tauri::AppHandle,
    request: ConnectorCapabilityRequest,
) -> Result<ConnectorCapabilityResult, ConnectorCommandError> {
    read_capability_for_connection(app, request, None).await
}

pub(crate) async fn read_capability_for_connection(
    app: &tauri::AppHandle,
    request: ConnectorCapabilityRequest,
    expected_connection_id: Option<&str>,
) -> Result<ConnectorCapabilityResult, ConnectorCommandError> {
    let connector_id = request.connector_id.clone();
    if !matches!(connector_id.as_str(), "github" | "vercel" | "linear") {
        return Err(error(
            "invalid-request",
            &connector_id,
            "Unsupported live connector capability.",
            false,
        ));
    }
    let token = crate::connector_auth::provider_access_token_for_connection(
        app,
        &connector_id,
        expected_connection_id,
    )
    .await?;
    let (method, url, query, body) = map_read(&request)?;
    let response = request_json(&connector_id, &token, method, &url, &query, body, true).await?;
    let (items, cursor) = extract_items(&request, &response.value);
    Ok(ConnectorCapabilityResult {
        connector_id,
        capability: request.capability,
        items,
        next_cursor: cursor.or(response.next_cursor),
        rate_limit_remaining: response.remaining,
        rate_limit_reset_at: response.reset_at,
    })
}

fn map_read(
    request: &ConnectorCapabilityRequest,
) -> Result<ReadRequestSpec, ConnectorCommandError> {
    let id = request.connector_id.as_str();
    let cap = request.capability.as_str();
    let input = &request.input;
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, 100)
        .to_string();
    let mut page_query = vec![(
        if id == "vercel" { "limit" } else { "per_page" }.into(),
        limit,
    )];
    if let Some(cursor) = &request.cursor {
        page_query.push((
            if id == "vercel" { "until" } else { "page" }.into(),
            cursor.clone(),
        ));
    }
    let get = |url: String, query: Vec<(String, String)>| Ok((Method::GET, url, query, None));
    match (id, cap) {
        ("github", "identity.read") => get("https://api.github.com/user".into(), vec![]),
        ("github", "organizations.read") => {
            get("https://api.github.com/user/orgs".into(), page_query)
        }
        ("github", "repositories.list") => {
            get("https://api.github.com/user/repos".into(), page_query)
        }
        ("github", "repositories.search") => {
            page_query.push(("q".into(), required(input, "query", id)?));
            get(
                "https://api.github.com/search/repositories".into(),
                page_query,
            )
        }
        ("github", capability) => {
            let repo = github_repository_path(input)?;
            let path = match capability {
                "branches.read" => "branches".into(),
                "commits.read" => "commits".into(),
                "files.read" => format!("contents/{}", required(input, "path", id)?),
                "issues.read" => match input.get("number") {
                    Some(number) => format!("issues/{}", value_text(number)),
                    None => {
                        page_query.push((
                            "state".into(),
                            input
                                .get("state")
                                .map(value_text)
                                .filter(|state| !state.trim().is_empty())
                                .unwrap_or_else(|| "all".into()),
                        ));
                        "issues".into()
                    }
                },
                "pull-requests.read" => match input.get("number") {
                    Some(number) => format!("pulls/{}", value_text(number)),
                    None => {
                        page_query.push((
                            "state".into(),
                            input
                                .get("state")
                                .map(value_text)
                                .filter(|state| !state.trim().is_empty())
                                .unwrap_or_else(|| "all".into()),
                        ));
                        "pulls".into()
                    }
                },
                "comments.read" => format!("issues/{}/comments", required(input, "number", id)?),
                "reviews.read" => format!("pulls/{}/reviews", required(input, "number", id)?),
                "checks.read" => format!("commits/{}/check-runs", required(input, "ref", id)?),
                "actions.read" => format!(
                    "actions/{}",
                    input
                        .get("resource")
                        .and_then(Value::as_str)
                        .unwrap_or("runs")
                ),
                _ => {
                    return Err(error(
                        "invalid-request",
                        id,
                        "Unsupported GitHub read capability.",
                        false,
                    ))
                }
            };
            get(
                format!("https://api.github.com/repos/{repo}/{path}"),
                page_query,
            )
        }
        ("vercel", "identity.read") => get("https://api.vercel.com/v2/user".into(), vec![]),
        ("vercel", "teams.read") => get("https://api.vercel.com/v2/teams".into(), page_query),
        ("vercel", "projects.read") => get(
            input
                .get("project")
                .map(|v| format!("https://api.vercel.com/v9/projects/{}", value_text(v)))
                .unwrap_or_else(|| "https://api.vercel.com/v9/projects".into()),
            with_team(page_query, input),
        ),
        ("vercel", "deployments.read") => get(
            input
                .get("deploymentId")
                .map(|v| format!("https://api.vercel.com/v13/deployments/{}", value_text(v)))
                .unwrap_or_else(|| "https://api.vercel.com/v6/deployments".into()),
            with_team(page_query, input),
        ),
        ("vercel", "domains.read") => get(
            input
                .get("project")
                .map(|v| {
                    format!(
                        "https://api.vercel.com/v9/projects/{}/domains",
                        value_text(v)
                    )
                })
                .unwrap_or_else(|| "https://api.vercel.com/v5/domains".into()),
            with_team(page_query, input),
        ),
        ("vercel", "logs.read") => get(
            format!(
                "https://api.vercel.com/v3/deployments/{}/events",
                required(input, "deploymentId", id)?
            ),
            with_team(page_query, input),
        ),
        ("vercel", "environment-metadata.read") => get(
            format!(
                "https://api.vercel.com/v9/projects/{}/env",
                required(input, "project", id)?
            ),
            with_team(page_query, input),
        ),
        ("linear", capability) => linear_read(capability, input, request.cursor.as_deref()),
        _ => Err(error(
            "invalid-request",
            id,
            "Unsupported connector read capability.",
            false,
        )),
    }
}

fn linear_read(
    capability: &str,
    input: &BTreeMap<String, Value>,
    cursor: Option<&str>,
) -> Result<ReadRequestSpec, ConnectorCommandError> {
    let first = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, 50);
    let (root, query, mut variables) = match capability {
        "identity.read" => ("viewer", "query { viewer { id name email avatarUrl organization { id name urlKey } } }", json!({})),
        "teams.read" => ("teams", "query($first:Int!,$after:String){ teams(first:$first,after:$after){ nodes { id key name description } pageInfo { hasNextPage endCursor } } }", json!({})),
        "projects.read" => ("projects", "query($first:Int!,$after:String){ projects(first:$first,after:$after){ nodes { id name description state progress url updatedAt } pageInfo { hasNextPage endCursor } } }", json!({})),
        "cycles.read" => ("cycles", "query($first:Int!,$after:String,$teamId:ID!){ cycles(first:$first,after:$after,filter:{team:{id:{eq:$teamId}}}){ nodes { id number name startsAt endsAt progress } pageInfo { hasNextPage endCursor } } }", json!({"teamId": required(input,"teamId","linear")?})),
        "issues.read" => ("issues", "query($first:Int!,$after:String){ issues(first:$first,after:$after,orderBy:updatedAt){ nodes { id identifier title description priority url updatedAt state { id name type } assignee { id name } team { id key name } } pageInfo { hasNextPage endCursor } } }", json!({})),
        "issues.search" => ("searchIssues", "query($term:String!,$first:Int!,$after:String){ searchIssues(term:$term,first:$first,after:$after){ nodes { id identifier title description url updatedAt state { id name type } team { id key name } } pageInfo { hasNextPage endCursor } } }", json!({"term": required(input,"query","linear")?})),
        "labels.read" => ("issueLabels", "query($first:Int!,$after:String){ issueLabels(first:$first,after:$after){ nodes { id name description color } pageInfo { hasNextPage endCursor } } }", json!({})),
        "users.read" => ("users", "query($first:Int!,$after:String){ users(first:$first,after:$after){ nodes { id name displayName email active } pageInfo { hasNextPage endCursor } } }", json!({})),
        "comments.read" => ("issue", "query($id:String!,$first:Int!,$after:String){ issue(id:$id){ id comments(first:$first,after:$after){ nodes { id body createdAt updatedAt user { id name } } pageInfo { hasNextPage endCursor } } } }", json!({"id": required(input,"issueId","linear")?})),
        _ => return Err(error("invalid-request","linear","Unsupported Linear read capability.",false)),
    };
    if let Some(map) = variables.as_object_mut() {
        map.insert("first".into(), json!(first));
        map.insert(
            "after".into(),
            cursor.map(Value::from).unwrap_or(Value::Null),
        );
        map.insert("__root".into(), json!(root));
    }
    Ok((
        Method::POST,
        "https://api.linear.app/graphql".into(),
        vec![],
        Some(json!({"query":query,"variables":variables})),
    ))
}

fn extract_items(
    request: &ConnectorCapabilityRequest,
    value: &Value,
) -> (Vec<Value>, Option<String>) {
    let target = if request.connector_id == "linear" {
        let root = match request.capability.as_str() {
            "identity.read" => "viewer",
            "teams.read" => "teams",
            "projects.read" => "projects",
            "cycles.read" => "cycles",
            "issues.read" => "issues",
            "issues.search" => "searchIssues",
            "comments.read" => "issue",
            "labels.read" => "issueLabels",
            "users.read" => "users",
            _ => "",
        };
        let mut target = value.pointer(&format!("/data/{root}"));
        if request.capability == "comments.read" {
            target = target.and_then(|v| v.get("comments"));
        }
        target
    } else {
        Some(value)
    };
    let items = target
        .and_then(|v| {
            v.get("items")
                .or_else(|| v.get("nodes"))
                .or_else(|| v.get("projects"))
                .or_else(|| v.get("deployments"))
                .or_else(|| v.get("teams"))
                .or_else(|| v.get("domains"))
                .or_else(|| v.get("events"))
                .or_else(|| v.get("envs"))
        })
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| target.and_then(Value::as_array).cloned())
        .unwrap_or_else(|| target.cloned().into_iter().collect());
    let items =
        if request.connector_id == "vercel" && request.capability == "environment-metadata.read" {
            items.into_iter().map(redact_environment).collect()
        } else {
            items
        };
    let cursor = target
        .and_then(|v| v.pointer("/pageInfo/endCursor"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .pointer("/pagination/next")
                .and_then(Value::as_u64)
                .map(|v| v.to_string())
        });
    (items, cursor)
}

fn redact_environment(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        for key in ["value", "decryptedValue", "secret"] {
            object.remove(key);
        }
    }
    value
}

pub(crate) async fn execute_action(
    app: &tauri::AppHandle,
    action: &ConnectorActionRequest,
    expected_connection_id: &str,
) -> Result<Option<String>, ConnectorCommandError> {
    let id = action.connector_id.as_str();
    let token = provider_access_token_for_connection(app, id, Some(expected_connection_id)).await?;
    let (method, url, query, body) = map_write(action)?;
    let response = request_json(id, &token, method, &url, &query, Some(body), false).await?;
    Ok(response
        .value
        .get("id")
        .or_else(|| response.value.pointer("/data/issueCreate/issue/id"))
        .or_else(|| response.value.pointer("/data/issueUpdate/issue/id"))
        .or_else(|| response.value.pointer("/data/commentCreate/comment/id"))
        .and_then(|v| v.as_str().map(str::to_string))
        .or_else(|| {
            response
                .value
                .get("id")
                .and_then(Value::as_u64)
                .map(|v| v.to_string())
        }))
}

fn map_write(action: &ConnectorActionRequest) -> Result<WriteRequestSpec, ConnectorCommandError> {
    let p = &action.payload;
    let id = action.connector_id.as_str();
    let json_payload = || {
        Value::Object(
            p.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    };
    match action.action.as_str(){
        "github.draft-pull-request" | "github.comment" | "github.create-issue" |
        "github.update-issue" | "github.create-review" | "github.update-file" |
        "github.create-branch" | "github.dispatch-workflow" => {
            Err(error("invalid-request", id, "GitHub live writes are not enabled.", false))
        }
        "vercel.promote"=>Ok((Method::POST,format!("https://api.vercel.com/v10/projects/{}/promote/{}",reqs(p,"project",id)?,reqs(p,"targetId",id)?),team_query(p),json!({}))),
        "vercel.rollback"=>Ok((Method::POST,format!("https://api.vercel.com/v10/projects/{}/rollback/{}",reqs(p,"project",id)?,reqs(p,"targetId",id)?),team_query(p),json!({}))),
        "vercel.create-deployment"=>Ok((Method::POST,"https://api.vercel.com/v13/deployments".into(),team_query(p),without_strings(p,&["teamId","targetId"]))),
        "vercel.cancel-deployment"=>Ok((Method::PATCH,format!("https://api.vercel.com/v12/deployments/{}/cancel",reqs(p,"targetId",id)?),team_query(p),json!({}))),
        "vercel.update-project"=>Ok((Method::PATCH,format!("https://api.vercel.com/v9/projects/{}",reqs(p,"project",id)?),team_query(p),without_strings(p,&["teamId","project","targetId"]))),
        "vercel.create-domain"=>Ok((Method::POST,format!("https://api.vercel.com/v10/projects/{}/domains",reqs(p,"project",id)?),team_query(p),json!({"name":reqs(p,"domain",id)?}))),
        "vercel.update-domain"=>Ok((Method::PATCH,format!("https://api.vercel.com/v9/projects/{}/domains/{}",reqs(p,"project",id)?,reqs(p,"domain",id)?),team_query(p),without_strings(p,&["teamId","project","domain","targetId"]))),
        "vercel.delete-domain"=>Ok((Method::DELETE,format!("https://api.vercel.com/v9/projects/{}/domains/{}",reqs(p,"project",id)?,reqs(p,"domain",id)?),team_query(p),json!({}))),
        "linear.create-issue"=>linear_mutation("issueCreate","mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id identifier title url } } }",json!({"input":json_payload()})),
        "linear.update-issue"=>linear_mutation("issueUpdate","mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success issue { id identifier title url } } }",json!({"id":reqs(p,"targetId",id)?,"input":without_strings(p,&["targetId","workspace","team"])})),
        "linear.comment"=>linear_mutation("commentCreate","mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment { id body createdAt } } }",json!({"input":{"issueId":reqs(p,"targetId",id)?,"body":reqs(p,"body",id)?}})),
        _=>Err(error("invalid-request",id,"Unsupported connector write action.",false)),
    }
}

fn linear_mutation(
    _root: &str,
    query: &str,
    variables: Value,
) -> Result<WriteRequestSpec, ConnectorCommandError> {
    Ok((
        Method::POST,
        "https://api.linear.app/graphql".into(),
        vec![],
        json!({"query":query,"variables":variables}),
    ))
}
fn required(
    input: &BTreeMap<String, Value>,
    key: &str,
    id: &str,
) -> Result<String, ConnectorCommandError> {
    input
        .get(key)
        .map(value_text)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            error(
                "invalid-request",
                id,
                &format!("Connector capability requires {key}."),
                false,
            )
        })
}
fn github_repository_path(
    input: &BTreeMap<String, Value>,
) -> Result<String, ConnectorCommandError> {
    let repository = required(input, "repository", "github")?;
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || !owner.chars().all(is_github_path_component)
        || !name.chars().all(is_github_path_component)
    {
        return Err(error(
            "invalid-request",
            "github",
            "GitHub repository must be in owner/name form.",
            false,
        ));
    }
    Ok(format!("{owner}/{name}"))
}
fn is_github_path_component(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.')
}
fn reqs(
    input: &BTreeMap<String, String>,
    key: &str,
    id: &str,
) -> Result<String, ConnectorCommandError> {
    input
        .get(key)
        .cloned()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            error(
                "invalid-request",
                id,
                &format!("Connector action requires {key}."),
                false,
            )
        })
}
fn value_text(v: &Value) -> String {
    v.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| v.to_string())
}
fn value_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key))
        .map(value_text)
        .filter(|v| v != "null")
}
fn with_team(
    mut query: Vec<(String, String)>,
    input: &BTreeMap<String, Value>,
) -> Vec<(String, String)> {
    if let Some(v) = input.get("teamId") {
        query.push(("teamId".into(), value_text(v)));
    }
    query
}
fn team_query(input: &BTreeMap<String, String>) -> Vec<(String, String)> {
    input
        .get("teamId")
        .map(|v| vec![("teamId".into(), v.clone())])
        .unwrap_or_default()
}
fn without_strings(input: &BTreeMap<String, String>, keys: &[&str]) -> Value {
    Value::Object(
        input
            .iter()
            .filter(|(k, _)| !keys.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    )
}
fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

/// Live health probe for the developer connectors (GitHub, Vercel, Linear).
/// Reuses the authenticated token path: a successful identity read is a healthy
/// connection; a normalized provider error maps to a degraded/error health
/// state. Tokens never leave the Rust boundary.
pub(crate) async fn probe_health(app: &tauri::AppHandle, connector_id: &str) -> ConnectorHealth {
    let checked_at = unix_timestamp();
    let capability = ConnectorCapabilityRequest {
        connector_id: connector_id.to_string(),
        capability: "identity.read".to_string(),
        input: BTreeMap::new(),
        cursor: None,
    };
    match read_capability(app, capability).await {
        Ok(result) => {
            let label = result
                .items
                .first()
                .and_then(|item| item.get("name").or_else(|| item.get("login")))
                .and_then(Value::as_str)
                .map(str::to_string);
            ConnectorHealth {
                state: "healthy".to_string(),
                summary: match label.as_deref() {
                    Some(name) => format!("Connected as {name}."),
                    None => "Connected; provider identity verified.".to_string(),
                },
                checked_at,
                retry_after: result
                    .rate_limit_remaining
                    .map(|remaining| format!("{remaining} provider requests remaining")),
            }
        }
        Err(failure) => ConnectorHealth {
            state: if failure.retryable {
                "degraded".to_string()
            } else {
                "error".to_string()
            },
            summary: failure.message,
            checked_at,
            retry_after: failure.retry_after,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn writes_are_not_replayed_but_reads_can_retry() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for read_only in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut count = 0;
                while let Ok(Ok((mut stream, _))) =
                    tokio::time::timeout(Duration::from_millis(700), listener.accept()).await
                {
                    count += 1;
                    let mut buffer = [0u8; 4096];
                    let _ = stream.read(&mut buffer).await;
                    let response = if count == 1 {
                        "HTTP/1.1 503 Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                    };
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
                count
            });
            let result = request_json(
                "github",
                "fixture",
                Method::POST,
                &url,
                &[],
                Some(json!({})),
                read_only,
            )
            .await;
            if read_only {
                assert!(result.is_ok());
            } else {
                let failure = result.err().unwrap();
                assert_eq!(failure.code, "outcome-unknown");
                assert!(!failure.retryable);
            }
            assert_eq!(server.await.unwrap(), if read_only { 2 } else { 1 });
        }
    }

    fn github_request(
        capability: &str,
        input: impl IntoIterator<Item = (&'static str, Value)>,
    ) -> ConnectorCapabilityRequest {
        ConnectorCapabilityRequest {
            connector_id: "github".to_string(),
            capability: capability.to_string(),
            input: input
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
            cursor: None,
        }
    }

    #[test]
    fn github_repositories_list_maps_to_authenticated_repos() {
        let request = github_request(
            "repositories.list",
            std::iter::empty::<(&'static str, Value)>(),
        );
        let (method, url, query, body) = map_read(&request).expect("mapped");
        assert_eq!(method, Method::GET);
        assert_eq!(url, "https://api.github.com/user/repos");
        assert!(query.contains(&("per_page".to_string(), "30".to_string())));
        assert!(body.is_none());
    }

    #[test]
    fn github_issue_and_pull_request_reads_use_repo_paths_and_state() {
        let issues = github_request(
            "issues.read",
            [
                ("repository", json!("acme/mivlet")),
                ("state", json!("open")),
                ("limit", json!(10)),
            ],
        );
        let (_, issue_url, issue_query, _) = map_read(&issues).expect("issues mapped");
        assert_eq!(issue_url, "https://api.github.com/repos/acme/mivlet/issues");
        assert!(issue_query.contains(&("per_page".to_string(), "10".to_string())));
        assert!(issue_query.contains(&("state".to_string(), "open".to_string())));

        let pulls = github_request("pull-requests.read", [("repository", json!("acme/mivlet"))]);
        let (_, pulls_url, pulls_query, _) = map_read(&pulls).expect("pulls mapped");
        assert_eq!(pulls_url, "https://api.github.com/repos/acme/mivlet/pulls");
        assert!(pulls_query.contains(&("state".to_string(), "all".to_string())));
    }

    #[test]
    fn github_repository_input_must_be_owner_slash_name() {
        let request = github_request(
            "issues.read",
            [("repository", json!("https://github.com/acme/mivlet"))],
        );
        let error = map_read(&request).expect_err("invalid repo rejected");
        assert_eq!(error.code, "invalid-request");
        assert_eq!(error.connector_id, "github");
    }
}
