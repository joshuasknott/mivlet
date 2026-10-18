//! Production Google Workspace provider adapters.
//!
//! This module is the only Google API egress path. OAuth credentials are read
//! through `connector_auth`, remain native, and are never serialized to the UI.

use std::{collections::BTreeMap, time::Duration};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use reqwest::{Method, StatusCode, Url};
use serde_json::{json, Value};

use crate::{
    connector_auth::{authorized_tokens, authorized_tokens_for_connection, StoredTokenSet},
    models::{
        ConnectorActionRequest, ConnectorActionResult, ConnectorCommandError, ConnectorHealth,
        ConnectorImportRequest, ConnectorImportResult, ConnectorKnowledgeSource,
        ConnectorSearchItem, ConnectorSearchRequest, ConnectorSearchResult,
    },
    paths::{normalize_spaces, truncate_characters},
};

const DRIVE_API: &str = "https://www.googleapis.com/drive/v3/";
const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3/";
const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1/";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3/";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARACTERS: usize = 20_000;
const MAX_TOOL_RESULT_CHARACTERS: usize = 64_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RETRIES: usize = 2;

const DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READONLY: &str = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_METADATA: &str = "https://www.googleapis.com/auth/drive.metadata.readonly";
const GMAIL_READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE: &str = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_LIST: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";

mod transport;
use transport::{
    api_url, cancel_google_call as cancel_google_call_impl, cancel_google_request, error,
    has_any_scope, new_call_id, provider_error, require_scope, send_json, send_raw_json,
};

mod data;
use data::{
    calendar_item, drive_item, epoch_string, escape_drive_query, gmail_header, gmail_item, string,
    strings,
};

/// Cancel one in-flight Google request through the stable Tauri command facade.
/// The command stays declared in this parent module so `generate_handler!`
/// keeps resolving the existing `google::cancel_google_call` wrapper path.
#[tauri::command]
pub fn cancel_google_call(call_id: String) -> bool {
    cancel_google_call_impl(call_id)
}

pub(crate) async fn search(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    search_for_connection(app, request, None).await
}

pub(crate) async fn search_for_connection(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
    expected_connection_id: Option<&str>,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let connector_id = request.connector_id.clone();
    let call_id = new_call_id(&connector_id);
    let (_, tokens) =
        authorized_tokens_for_connection(app, &connector_id, expected_connection_id).await?;
    let limit = request.limit.unwrap_or(20).clamp(1, 50);
    let query = normalize_spaces(&request.query);
    let (items, next_cursor) = match connector_id.as_str() {
        "google-drive" => {
            drive_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        "gmail" => {
            gmail_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        "google-calendar" => {
            calendar_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        _ => {
            return Err(error(
                &connector_id,
                "configuration-required",
                "Live search is not implemented for this connector.",
                false,
            ))
        }
    };
    Ok(ConnectorSearchResult {
        connector_id,
        query,
        items,
        next_cursor,
        source: "live".to_string(),
        searched_at: epoch_string(),
    })
}

async fn drive_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    require_scope(
        "google-drive",
        tokens,
        &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
    )?;
    let mut url = api_url(DRIVE_API, "files")?;
    let q = if query.is_empty() {
        "trashed = false".to_string()
    } else {
        format!(
            "trashed = false and fullText contains '{}'",
            escape_drive_query(query)
        )
    };
    url.query_pairs_mut()
        .append_pair("q", &q)
        .append_pair("pageSize", &limit.to_string())
        .append_pair("orderBy", "modifiedTime desc")
        .append_pair(
            "fields",
            "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,size)",
        );
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "google-drive", tokens, Method::GET, url, None).await?;
    let items = response
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "google-drive",
                "provider-unavailable",
                "Drive response is missing files.",
                false,
            )
        })?
        .iter()
        .map(drive_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, string(&response, "nextPageToken")))
}

async fn gmail_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    require_scope("gmail", tokens, &[GMAIL_READONLY])?;
    let mut url = api_url(GMAIL_API, "users/me/messages")?;
    url.query_pairs_mut()
        .append_pair("maxResults", &limit.to_string());
    if !query.is_empty() {
        url.query_pairs_mut().append_pair("q", query);
    }
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "gmail", tokens, Method::GET, url, None).await?;
    let ids = response
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::with_capacity(ids.len());
    for message in ids {
        let id = match string(&message, "id") {
            Some(id) => id,
            None => {
                // A malformed list entry must not abort the whole result; skip it
                // with a bounded placeholder so the user still gets the page.
                continue;
            }
        };
        let mut detail = api_url(GMAIL_API, &format!("users/me/messages/{id}"))?;
        detail
            .query_pairs_mut()
            .append_pair("format", "metadata")
            .append_pair("metadataHeaders", "Subject")
            .append_pair("metadataHeaders", "From")
            .append_pair("metadataHeaders", "Date");
        // Per-message detail failures degrade to a placeholder rather than
        // discarding the entire search page (partial-failure handling).
        match send_json(call_id, "gmail", tokens, Method::GET, detail, None).await {
            Ok(value) => match gmail_item(&value) {
                Ok(item) => items.push(item),
                Err(_) => items.push(unreadable_message_item(&id)),
            },
            Err(failure) if failure.code == "cancelled" => return Err(failure),
            Err(_) => items.push(unreadable_message_item(&id)),
        }
    }
    Ok((items, string(&response, "nextPageToken")))
}

/// A bounded placeholder for a Gmail message whose details could not be read,
/// so a single sub-fetch failure never blanks the whole search page.
fn unreadable_message_item(id: &str) -> ConnectorSearchItem {
    ConnectorSearchItem {
        id: id.to_string(),
        connector_id: "gmail".to_string(),
        connection_id: None,
        title: "(message unavailable)".to_string(),
        kind: "message".to_string(),
        summary: "This message could not be read from Gmail.".to_string(),
        provenance: "Gmail · authenticated mailbox".to_string(),
        freshness: "Unknown".to_string(),
        trust: "untrusted".to_string(),
        url: None,
        content_preview: None,
        provider_metadata: BTreeMap::new(),
    }
}

async fn calendar_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    if query.is_empty() {
        require_scope("google-calendar", tokens, &[CALENDAR_LIST])?;
        let mut url = api_url(CALENDAR_API, "users/me/calendarList")?;
        url.query_pairs_mut()
            .append_pair("maxResults", &limit.to_string());
        if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
            url.query_pairs_mut().append_pair("pageToken", cursor);
        }
        let response =
            send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
        let items = response
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|value| calendar_item(value, string(value, "id").as_deref().unwrap_or("unknown")))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok((items, string(&response, "nextPageToken")));
    }
    require_scope(
        "google-calendar",
        tokens,
        &[CALENDAR_READONLY, CALENDAR_EVENTS],
    )?;
    let mut url = api_url(CALENDAR_API, "calendars/primary/events")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", &limit.to_string());
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
    let items = response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|value| calendar_item(value, "primary"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, string(&response, "nextPageToken")))
}

pub(crate) async fn import(
    app: &tauri::AppHandle,
    request: ConnectorImportRequest,
) -> Result<ConnectorImportResult, ConnectorCommandError> {
    let connector_id = request.connector_id.clone();
    let call_id = new_call_id(&connector_id);
    let (_, tokens) = authorized_tokens(app, &connector_id).await?;
    let preview = match connector_id.as_str() {
        "google-drive" => drive_content(&call_id, &tokens, &request.item).await?,
        "gmail" => gmail_thread_content(&call_id, &tokens, &request.item).await?,
        "google-calendar" => calendar_content(&call_id, &tokens, &request.item).await?,
        _ => {
            return Err(error(
                &connector_id,
                "configuration-required",
                "Live import is not implemented for this connector.",
                false,
            ))
        }
    };
    let source = ConnectorKnowledgeSource {
        workspace_id: None,
        authority_scope: None,
        scope: None,
        id: format!("connector-{}-{}", connector_id, request.item.id),
        title: request.item.title,
        kind: if request.item.kind == "event" || request.item.kind == "calendar" {
            "folder".to_string()
        } else {
            "document".to_string()
        },
        connector_id,
        connection_id: None,
        provenance: request.item.provenance,
        freshness: request.item.freshness,
        pinned: false,
        trust: "untrusted".to_string(),
        content_preview: Some(truncate_characters(&preview, MAX_PREVIEW_CHARACTERS)),
        imported_at: request.imported_at,
        origin: "connector-import".to_string(),
        provider_metadata: request.item.provider_metadata,
        disabled: false,
        deleted_at: None,
        status: Some("ok".to_string()),
        status_message: None,
    };
    Ok(ConnectorImportResult {
        source,
        imported: true,
    })
}

async fn drive_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope("google-drive", tokens, &[DRIVE_READONLY, DRIVE_FILE])?;
    let mime = item
        .provider_metadata
        .get("mimeType")
        .map(String::as_str)
        .unwrap_or("");
    let export = match mime {
        "application/vnd.google-apps.document" => Some("text/plain"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        "application/vnd.google-apps.folder" => return Ok(format!("Folder: {}", item.title)),
        _ => None,
    };
    let url = if let Some(export_mime) = export {
        let mut url = api_url(DRIVE_API, &format!("files/{}/export", item.id))?;
        url.query_pairs_mut().append_pair("mimeType", export_mime);
        url
    } else {
        let mut url = api_url(DRIVE_API, &format!("files/{}", item.id))?;
        url.query_pairs_mut().append_pair("alt", "media");
        url
    };
    // Keep the mutable binding explicit so future export parameters remain local.
    let (_, bytes) = send(
        call_id,
        "google-drive",
        tokens,
        Method::GET,
        url.clone(),
        None,
    )
    .await?;
    String::from_utf8(bytes).map_err(|_| {
        error(
            "google-drive",
            "invalid-request",
            "This Drive file is binary and cannot be imported as text.",
            false,
        )
    })
}

/// Decode a Gmail MIME part. `unreadable` accumulates a marker for any part
/// whose body fails base64 or UTF-8 decoding, so a corrupt part is surfaced to
/// the model/user rather than silently dropped (no silent data loss).
fn decode_gmail_part(
    value: &Value,
    output: &mut Vec<String>,
    attachments: &mut Vec<String>,
    unreadable: &mut Vec<String>,
) {
    if let Some(filename) = string(value, "filename").filter(|name| !name.is_empty()) {
        let mime =
            string(value, "mimeType").unwrap_or_else(|| "application/octet-stream".to_string());
        let size = value
            .pointer("/body/size")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        attachments.push(format!("{filename} ({mime}, {size} bytes)"));
    }
    if string(value, "mimeType").as_deref() == Some("text/plain") {
        if let Some(data) = value.pointer("/body/data").and_then(Value::as_str) {
            match URL_SAFE_NO_PAD.decode(data) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => output.push(text),
                    Err(_) => unreadable.push("[unreadable message part omitted]".to_string()),
                },
                Err(_) => unreadable.push("[unreadable message part omitted]".to_string()),
            }
        }
    }
    if let Some(parts) = value.get("parts").and_then(Value::as_array) {
        for part in parts {
            decode_gmail_part(part, output, attachments, unreadable);
        }
    }
}

async fn gmail_thread_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope("gmail", tokens, &[GMAIL_READONLY])?;
    let thread_id = item
        .provider_metadata
        .get("threadId")
        .map(String::as_str)
        .unwrap_or(&item.id);
    let mut url = api_url(GMAIL_API, &format!("users/me/threads/{thread_id}"))?;
    url.query_pairs_mut().append_pair("format", "full");
    let response = send_json(call_id, "gmail", tokens, Method::GET, url, None).await?;
    let messages = response
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "gmail",
                "provider-unavailable",
                "Gmail thread is malformed.",
                false,
            )
        })?;
    let mut rendered = Vec::new();
    for message in messages {
        let mut bodies = Vec::new();
        let mut attachments = Vec::new();
        let mut unreadable = Vec::new();
        if let Some(payload) = message.get("payload") {
            decode_gmail_part(payload, &mut bodies, &mut attachments, &mut unreadable);
        }
        if !unreadable.is_empty() {
            bodies.push(unreadable.join("\n"));
        }
        rendered.push(format!(
            "From: {}\nTo: {}\nSubject: {}\nDate: {}\n\n{}{}",
            gmail_header(message, "From").unwrap_or_default(),
            gmail_header(message, "To").unwrap_or_default(),
            gmail_header(message, "Subject").unwrap_or_default(),
            gmail_header(message, "Date").unwrap_or_default(),
            bodies.join("\n"),
            if attachments.is_empty() {
                String::new()
            } else {
                format!("\n\nAttachments: {}", attachments.join(", "))
            }
        ));
    }
    Ok(rendered.join("\n\n---\n\n"))
}

async fn calendar_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope(
        "google-calendar",
        tokens,
        &[CALENDAR_READONLY, CALENDAR_EVENTS],
    )?;
    if item.kind == "calendar" {
        return serde_json::to_string_pretty(&json!({
            "id": item.id,
            "title": item.title,
            "metadata": item.provider_metadata,
        }))
        .map_err(|_| {
            error(
                "google-calendar",
                "unknown",
                "Calendar metadata could not be encoded.",
                false,
            )
        });
    }
    let calendar_id = item
        .provider_metadata
        .get("calendarId")
        .map(String::as_str)
        .unwrap_or("primary");
    let url = api_url(
        CALENDAR_API,
        &format!(
            "calendars/{}/events/{}",
            encode_segment(calendar_id),
            encode_segment(&item.id)
        ),
    )?;
    let value = send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
    serde_json::to_string_pretty(&value).map_err(|_| {
        error(
            "google-calendar",
            "unknown",
            "Calendar event could not be encoded.",
            false,
        )
    })
}

fn required<'a>(
    connector_id: &str,
    payload: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, ConnectorCommandError> {
    payload
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            error(
                connector_id,
                "invalid-request",
                &format!("Action payload requires {key}."),
                false,
            )
        })
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn parse_json_field(
    connector_id: &str,
    payload: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<Value>, ConnectorCommandError> {
    payload
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            serde_json::from_str(value).map_err(|_| {
                error(
                    connector_id,
                    "invalid-request",
                    &format!("Action payload field {key} must be valid JSON."),
                    false,
                )
            })
        })
        .transpose()
}

pub(crate) async fn execute_action(
    app: &tauri::AppHandle,
    action: &ConnectorActionRequest,
    expected_connection_id: &str,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    let call_id = new_call_id(&action.connector_id);
    let (_, tokens) =
        authorized_tokens_for_connection(app, &action.connector_id, Some(expected_connection_id))
            .await?;
    let resource_id = match action.connector_id.as_str() {
        "google-drive" => execute_drive_action(&call_id, &tokens, action).await?,
        "gmail" => execute_gmail_action(&call_id, &tokens, action).await?,
        "google-calendar" => execute_calendar_action(&call_id, &tokens, action).await?,
        _ => {
            return Err(error(
                &action.connector_id,
                "configuration-required",
                "Live actions are not implemented for this connector.",
                false,
            ))
        }
    };
    Ok(ConnectorActionResult {
        request_id: action.id.clone(),
        connector_id: action.connector_id.clone(),
        action: action.action.clone(),
        status: "completed".to_string(),
        message: "Google action completed after explicit approval.".to_string(),
        provider_resource_id: resource_id,
    })
}

async fn execute_drive_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    require_scope("google-drive", tokens, &[DRIVE_FILE])?;
    let payload = &action.payload;
    let (method, url, body) = match action.action.as_str() {
        "google-drive.create-file" => {
            let mut metadata = json!({
                "name": required("google-drive", payload, "name")?,
                "mimeType": payload.get("mimeType").map(String::as_str).unwrap_or("text/plain")
            });
            if let Some(parents) = parse_json_field("google-drive", payload, "parents")? {
                metadata["parents"] = parents;
            }
            if let Some(content) = payload.get("content") {
                let mime_type = payload
                    .get("mimeType")
                    .map(String::as_str)
                    .unwrap_or("text/plain");
                let (content_type, body) =
                    drive_multipart_body(&metadata, mime_type, content.as_bytes())?;
                let mut url = api_url(DRIVE_UPLOAD_API, "files")?;
                url.query_pairs_mut().append_pair("uploadType", "multipart");
                let value = send_raw_json(
                    call_id,
                    "google-drive",
                    tokens,
                    Method::POST,
                    url,
                    &content_type,
                    body,
                )
                .await?;
                return Ok(string(&value, "id"));
            }
            (Method::POST, api_url(DRIVE_API, "files")?, Some(metadata))
        }
        "google-drive.update-file" => {
            let id = required("google-drive", payload, "fileId")?;
            let content = required("google-drive", payload, "content")?;
            let mut url = api_url(DRIVE_UPLOAD_API, &format!("files/{}", encode_segment(id)))?;
            url.query_pairs_mut().append_pair("uploadType", "media");
            (Method::PATCH, url, Some(Value::String(content.to_string())))
        }
        "google-drive.move-file" => {
            let id = required("google-drive", payload, "fileId")?;
            let mut url = api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?;
            url.query_pairs_mut().append_pair(
                "addParents",
                required("google-drive", payload, "destinationFolderId")?,
            );
            if let Some(remove) = payload.get("removeParents") {
                url.query_pairs_mut().append_pair("removeParents", remove);
            }
            (Method::PATCH, url, Some(json!({})))
        }
        "google-drive.rename-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::PATCH,
                api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?,
                Some(json!({ "name": required("google-drive", payload, "name")? })),
            )
        }
        "google-drive.share-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::POST,
                api_url(
                    DRIVE_API,
                    &format!("files/{}/permissions", encode_segment(id)),
                )?,
                Some(json!({
                    "type": "user",
                    "role": payload.get("role").map(String::as_str).unwrap_or("reader"),
                    "emailAddress": required("google-drive", payload, "recipient")?
                })),
            )
        }
        "google-drive.delete-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::DELETE,
                api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?,
                None,
            )
        }
        _ => {
            return Err(error(
                "google-drive",
                "invalid-request",
                "Unsupported Drive action.",
                false,
            ))
        }
    };
    if action.action == "google-drive.update-file" {
        let content = required("google-drive", payload, "content")?;
        let value = send_raw_json(
            call_id,
            "google-drive",
            tokens,
            method,
            url,
            payload
                .get("mimeType")
                .map(String::as_str)
                .unwrap_or("text/plain"),
            content.as_bytes().to_vec(),
        )
        .await?;
        return Ok(string(&value, "id").or_else(|| payload.get("fileId").cloned()));
    }
    let value = send_json(call_id, "google-drive", tokens, method, url, body).await?;
    Ok(string(&value, "id").or_else(|| payload.get("fileId").cloned()))
}

fn drive_multipart_body(
    metadata: &Value,
    mime_type: &str,
    content: &[u8],
) -> Result<(String, Vec<u8>), ConnectorCommandError> {
    if mime_type.contains(['\r', '\n']) {
        return Err(error(
            "google-drive",
            "invalid-request",
            "Drive MIME type is invalid.",
            false,
        ));
    }
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| {
        error(
            "google-drive",
            "provider-unavailable",
            "Drive upload boundary is unavailable.",
            false,
        )
    })?;
    let boundary = format!(
        "mivlet-{}",
        nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let metadata = serde_json::to_string(metadata).map_err(|_| {
        error(
            "google-drive",
            "invalid-request",
            "Drive metadata could not be encoded.",
            false,
        )
    })?;
    if content
        .windows(boundary.len())
        .any(|slice| slice == boundary.as_bytes())
        || metadata.contains(&boundary)
    {
        return Err(error(
            "google-drive",
            "invalid-request",
            "Drive multipart data conflicts with its boundary. Prepare again.",
            false,
        ));
    }
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n").into_bytes();
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/related; boundary={boundary}"), body))
}

pub(crate) async fn upload_artifact(
    app: &tauri::AppHandle,
    action: &ConnectorActionRequest,
    expected_connection: &str,
    artifact: &crate::local_computer::artifacts::VerifiedUploadArtifact,
    require_current: impl Fn() -> Result<(), ConnectorCommandError>,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    require_current()?;
    let (_, tokens) =
        authorized_tokens_for_connection(app, "google-drive", Some(expected_connection)).await?;
    require_scope("google-drive", &tokens, &[DRIVE_FILE])?;
    let metadata = json!({"name": artifact.file_name, "mimeType": artifact.mime_type,
        "parents": [required("google-drive", &action.payload, "destinationFolderId")?]});
    let (content_type, body) =
        drive_multipart_body(&metadata, &artifact.mime_type, &artifact.bytes)?;
    // This new native artifact path has a fixed official egress origin. Existing
    // text connector development overrides cannot redirect deliverable bytes.
    let mut url = Url::parse("https://www.googleapis.com/upload/drive/v3/files")
        .expect("fixed Google Drive upload URL");
    url.query_pairs_mut()
        .append_pair("uploadType", "multipart")
        .append_pair("fields", "id");
    require_current()?;
    let value = send_raw_json(
        &new_call_id("google-drive"),
        "google-drive",
        &tokens,
        Method::POST,
        url,
        &content_type,
        body,
    )
    .await
    .map_err(upload_failure)?;
    let resource_id = string(&value, "id")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| maybe_applied_error("google-drive", &Method::POST))?;
    Ok(ConnectorActionResult {
        request_id: action.id.clone(),
        connector_id: "google-drive".into(),
        action: action.action.clone(),
        status: "completed".into(),
        message: "The exact approved deliverable was uploaded to Google Drive.".into(),
        provider_resource_id: Some(resource_id),
    })
}

fn upload_failure(failure: ConnectorCommandError) -> ConnectorCommandError {
    if matches!(failure.code.as_str(), "provider-unavailable" | "cancelled") {
        // A lost/malformed response does not prove that a POST was unapplied.
        maybe_applied_error("google-drive", &Method::POST)
    } else {
        failure
    }
}

fn safe_header(value: &str) -> Result<&str, ConnectorCommandError> {
    if value.contains('\r') || value.contains('\n') {
        Err(error(
            "gmail",
            "invalid-request",
            "Email headers cannot contain line breaks.",
            false,
        ))
    } else {
        Ok(value)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailAttachmentInput {
    filename: String,
    #[serde(default = "default_attachment_mime")]
    mime_type: String,
    data_base64: String,
}

fn default_attachment_mime() -> String {
    "application/octet-stream".to_string()
}

fn build_mime(payload: &BTreeMap<String, String>) -> Result<String, ConnectorCommandError> {
    let to = safe_header(required("gmail", payload, "to")?)?;
    let subject = safe_header(required("gmail", payload, "subject")?)?;
    let mut headers = vec![format!("To: {to}"), format!("Subject: {subject}")];
    for (key, label) in [("cc", "Cc"), ("bcc", "Bcc"), ("inReplyTo", "In-Reply-To")] {
        if let Some(value) = payload.get(key).filter(|value| !value.trim().is_empty()) {
            headers.push(format!("{label}: {}", safe_header(value)?));
        }
    }
    headers.push("MIME-Version: 1.0".to_string());
    let body = payload.get("body").cloned().unwrap_or_default();
    let attachments = match payload.get("attachments") {
        Some(value) if !value.trim().is_empty() => serde_json::from_str::<Vec<GmailAttachmentInput>>(value)
            .map_err(|_| error("gmail", "invalid-request", "Email attachments must be a JSON array of filename, mimeType, and dataBase64 values.", false))?,
        _ => Vec::new(),
    };
    if attachments.is_empty() {
        headers.push("Content-Type: text/plain; charset=UTF-8".to_string());
        return Ok(format!("{}\r\n\r\n{body}", headers.join("\r\n")));
    }

    let boundary = "mivlet-gmail-attachment";
    headers.push(format!(
        "Content-Type: multipart/mixed; boundary={boundary}"
    ));
    let mut parts = vec![format!(
        "--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}\r\n"
    )];
    for attachment in attachments {
        let filename = safe_header(attachment.filename.trim())?;
        let mime_type = safe_header(attachment.mime_type.trim())?;
        let decoded = STANDARD
            .decode(attachment.data_base64.trim())
            .map_err(|_| {
                error(
                    "gmail",
                    "invalid-request",
                    "Email attachment dataBase64 is invalid.",
                    false,
                )
            })?;
        let encoded = STANDARD.encode(decoded);
        parts.push(format!(
            "--{boundary}\r\nContent-Type: {mime_type}\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n"
        ));
    }
    parts.push(format!("--{boundary}--\r\n"));
    Ok(format!(
        "{}\r\n\r\n{}",
        headers.join("\r\n"),
        parts.join("")
    ))
}

async fn execute_gmail_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    let payload = &action.payload;
    let (url, body) = match action.action.as_str() {
        "gmail.create-draft" => {
            require_scope("gmail", tokens, &[GMAIL_COMPOSE])?;
            let raw = URL_SAFE_NO_PAD.encode(build_mime(payload)?);
            let mut message = json!({ "raw": raw });
            if let Some(thread_id) = payload.get("threadId").filter(|value| !value.is_empty()) {
                message["threadId"] = Value::String(thread_id.clone());
            }
            (
                api_url(GMAIL_API, "users/me/drafts")?,
                json!({ "message": message }),
            )
        }
        "gmail.send" => {
            require_scope("gmail", tokens, &[GMAIL_SEND, GMAIL_COMPOSE])?;
            if let Some(draft_id) = payload.get("draftId").filter(|value| !value.is_empty()) {
                (
                    api_url(GMAIL_API, "users/me/drafts/send")?,
                    json!({ "id": draft_id }),
                )
            } else {
                let raw = URL_SAFE_NO_PAD.encode(build_mime(payload)?);
                let mut message = json!({ "raw": raw });
                if let Some(thread_id) = payload.get("threadId").filter(|value| !value.is_empty()) {
                    message["threadId"] = Value::String(thread_id.clone());
                }
                (api_url(GMAIL_API, "users/me/messages/send")?, message)
            }
        }
        _ => {
            return Err(error(
                "gmail",
                "invalid-request",
                "Unsupported Gmail action.",
                false,
            ))
        }
    };
    let value = send_json(call_id, "gmail", tokens, Method::POST, url, Some(body)).await?;
    Ok(string(&value, "id").or_else(|| {
        value
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
    }))
}

fn calendar_event_body(payload: &BTreeMap<String, String>) -> Result<Value, ConnectorCommandError> {
    let mut event = json!({
        "summary": required("google-calendar", payload, "title")?,
        "start": {
            "dateTime": required("google-calendar", payload, "start")?,
            "timeZone": required("google-calendar", payload, "timezone")?
        },
        "end": {
            "dateTime": required("google-calendar", payload, "end")?,
            "timeZone": required("google-calendar", payload, "timezone")?
        }
    });
    for key in ["description", "location"] {
        if let Some(value) = payload.get(key).filter(|value| !value.trim().is_empty()) {
            event[key] = Value::String(value.clone());
        }
    }
    if let Some(attendees) = parse_json_field("google-calendar", payload, "attendees")? {
        event["attendees"] = attendees;
    }
    if let Some(recurrence) = parse_json_field("google-calendar", payload, "recurrence")? {
        event["recurrence"] = recurrence;
    }
    Ok(event)
}

async fn execute_calendar_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    require_scope("google-calendar", tokens, &[CALENDAR_EVENTS])?;
    let payload = &action.payload;
    let calendar_id = required("google-calendar", payload, "calendarId")?;
    let (method, mut url, body) = match action.action.as_str() {
        "google-calendar.create-draft" => (
            Method::POST,
            api_url(
                CALENDAR_API,
                &format!("calendars/{}/events", encode_segment(calendar_id)),
            )?,
            Some(calendar_event_body(payload)?),
        ),
        "google-calendar.update-draft" => (
            Method::PATCH,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            Some(calendar_event_body(payload)?),
        ),
        "google-calendar.delete-event" => (
            Method::DELETE,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            None,
        ),
        "google-calendar.cancel-event" => (
            Method::PATCH,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            Some(json!({ "status": "cancelled" })),
        ),
        _ => {
            return Err(error(
                "google-calendar",
                "invalid-request",
                "Unsupported Calendar action.",
                false,
            ))
        }
    };
    if payload
        .get("notifyAttendees")
        .is_some_and(|value| value == "true")
    {
        url.query_pairs_mut().append_pair("sendUpdates", "all");
    } else {
        url.query_pairs_mut().append_pair("sendUpdates", "none");
    }
    let value = send_json(call_id, "google-calendar", tokens, method, url, body).await?;
    Ok(string(&value, "id").or_else(|| payload.get("eventId").cloned()))
}

/// Live health probe for Google connectors. A successful userinfo read is a
/// healthy connection; a normalized provider error maps to degraded/error.
pub(crate) async fn probe_health(app: &tauri::AppHandle, connector_id: &str) -> ConnectorHealth {
    let call_id = new_call_id(connector_id);
    let checked_at = epoch_string();
    let tokens = match authorized_tokens(app, connector_id).await {
        Ok(pair) => pair.1,
        Err(failure) => {
            return ConnectorHealth {
                state: if failure.retryable {
                    "degraded".to_string()
                } else {
                    "error".to_string()
                },
                summary: failure.message,
                checked_at,
                retry_after: failure.retry_after,
            }
        }
    };
    let url = match api_url("https://openidconnect.googleapis.com/v1/", "userinfo") {
        Ok(url) => url,
        Err(failure) => {
            return ConnectorHealth {
                state: "error".to_string(),
                summary: failure.message,
                checked_at,
                retry_after: None,
            }
        }
    };
    match send_json(&call_id, connector_id, &tokens, Method::GET, url, None).await {
        Ok(value) => {
            let email = string(&value, "email");
            let name = string(&value, "name").or_else(|| email.clone());
            ConnectorHealth {
                state: "healthy".to_string(),
                summary: match name.as_deref() {
                    Some(label) => format!("Connected as {label}."),
                    None => "Connected; Google identity verified.".to_string(),
                },
                checked_at,
                retry_after: None,
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

/// Read-only Google capabilities exposed to the native model tool runtime.
pub(crate) async fn execute_read_tool(
    app: &tauri::AppHandle,
    tool: &str,
    arguments: &Value,
) -> Result<String, ConnectorCommandError> {
    let object = arguments.as_object().ok_or_else(|| {
        error(
            "google",
            "invalid-request",
            "Google tool arguments must be an object.",
            false,
        )
    })?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                "google",
                "invalid-request",
                "Google tool operation is required.",
                false,
            )
        })?;
    let connector_id = match tool {
        "google-drive-read" => "google-drive",
        "gmail-read" => "gmail",
        "google-calendar-read" => "google-calendar",
        _ => {
            return Err(error(
                "google",
                "invalid-request",
                "Unknown Google read tool.",
                false,
            ))
        }
    };
    let call_id = new_call_id(connector_id);
    let value = run_read_operation(app, &call_id, connector_id, operation, object).await?;
    encode_read_result(connector_id, value)
}

/// Keep records and continuation tokens intact. A prefix of serialized JSON is
/// neither a page nor a usable document, and makes the model try to repair it.
fn encode_read_result(
    connector_id: &str,
    mut value: Value,
) -> Result<String, ConnectorCommandError> {
    let encode = |value: &Value| {
        serde_json::to_string(value).map_err(|_| {
            error(
                connector_id,
                "unknown",
                "Google result could not be encoded.",
                false,
            )
        })
    };
    let encoded = encode(&value)?;
    if encoded.chars().count() <= MAX_TOOL_RESULT_CHARACTERS {
        return Ok(encoded);
    }
    // Large message bodies/event descriptions are excerpts, but list entries,
    // identifiers and pagination remain complete. Never silently drop records.
    bound_read_text(&mut value, "");
    if let Some(object) = value.as_object_mut() {
        object.insert("truncated".into(), json!(true));
        object.insert("coverage".into(), json!("All returned records and pagination are preserved. Long text fields are excerpts; do not describe them as complete content."));
    }
    let encoded = encode(&value)?;
    if encoded.chars().count() > MAX_TOOL_RESULT_CHARACTERS {
        return Err(error(connector_id, "response-too-large", "This result is too large. Request a smaller page with limit, or read individual messages/files. No partial JSON was returned.", false));
    }
    Ok(encoded)
}

fn bound_read_text(value: &mut Value, key: &str) {
    match value {
        // Gmail body.data is base64url, not prose. Excerpt decoded UTF-8 and
        // re-encode it; never insert a text marker into an encoded payload.
        Value::String(data) if key == "data" => {
            if let Ok(decoded) = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')) {
                if let Ok(text) = String::from_utf8(decoded) {
                    if text.chars().count() > 1_000 {
                        *data = URL_SAFE_NO_PAD.encode(truncate_characters(&text, 1_000));
                    }
                }
            }
        }
        Value::String(text)
            if !matches!(
                key,
                "id" | "fileId"
                    | "threadId"
                    | "messageId"
                    | "nextCursor"
                    | "nextPageToken"
                    | "nextSyncToken"
                    | "historyId"
                    | "url"
                    | "webViewLink"
                    | "htmlLink"
                    | "mimeType"
                    | "kind"
                    | "etag"
            ) =>
        {
            if text.chars().count() > 1_000 {
                *text = format!("{}… [text shortened]", truncate_characters(text, 1_000));
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                bound_read_text(child, key);
            }
        }
        Value::Array(items) => {
            for item in items {
                bound_read_text(item, key);
            }
        }
        _ => {}
    }
}

/// Resolve a single read operation against Google. Kept separate so the
/// public tool entry can own the cancel scope while this owns the (connector,
/// operation) fan-out. `call_id` threads the cancel token into every egress.
async fn run_read_operation(
    app: &tauri::AppHandle,
    call_id: &str,
    connector_id: &str,
    operation: &str,
    object: &serde_json::Map<String, Value>,
) -> Result<Value, ConnectorCommandError> {
    let (_connection, tokens) = authorized_tokens(app, connector_id).await?;
    let limit = object
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 50) as usize;
    let value = match (connector_id, operation) {
        ("google-drive", "search") => {
            let query = object.get("query").and_then(Value::as_str).unwrap_or("");
            let (items, cursor) = drive_search(
                call_id,
                &tokens,
                query,
                limit,
                object.get("cursor").and_then(Value::as_str),
            )
            .await?;
            json!({ "items": items, "nextCursor": cursor })
        }
        ("google-drive", "metadata") => {
            require_scope(
                connector_id,
                &tokens,
                &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
            )?;
            let file_id = object
                .get("fileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "fileId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(DRIVE_API, &format!("files/{}", encode_segment(file_id)))?;
            url.query_pairs_mut().append_pair("fields", "id,name,mimeType,modifiedTime,webViewLink,parents,size,owners(displayName,emailAddress)");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-drive", "content") => {
            let file_id = object
                .get("fileId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "fileId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(DRIVE_API, &format!("files/{}", encode_segment(file_id)))?;
            url.query_pairs_mut()
                .append_pair("fields", "id,name,mimeType,modifiedTime,webViewLink");
            let metadata =
                send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?;
            let item = drive_item(&metadata)?;
            let content = drive_content(call_id, &tokens, &item).await?;
            json!({ "item": item, "content": truncate_characters(&content, MAX_PREVIEW_CHARACTERS), "truncated": content.chars().count() > MAX_PREVIEW_CHARACTERS, "trust": "untrusted" })
        }
        ("google-drive", "children") => {
            require_scope(
                connector_id,
                &tokens,
                &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
            )?;
            let folder_id = object
                .get("folderId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "folderId is required.",
                        false,
                    )
                })?;
            let limit = object
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 50);
            let mut url = api_url(DRIVE_API, "files")?;
            url.query_pairs_mut()
                .append_pair(
                    "q",
                    &format!(
                        "'{}' in parents and trashed = false",
                        escape_drive_query(folder_id)
                    ),
                )
                .append_pair("pageSize", &limit.to_string())
                .append_pair("orderBy", "folder,name")
                .append_pair(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,size)",
                );
            if let Some(cursor) = object.get("cursor").and_then(Value::as_str) {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            let response =
                send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?;
            let items = response
                .get("files")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "provider-unavailable",
                        "Drive response is missing files.",
                        false,
                    )
                })?
                .iter()
                .map(drive_item)
                .collect::<Result<Vec<_>, _>>()?;
            json!({ "items": items, "nextCursor": string(&response, "nextPageToken") })
        }
        ("gmail", "search") => {
            let query = object.get("query").and_then(Value::as_str).unwrap_or("");
            let (items, cursor) = gmail_search(
                call_id,
                &tokens,
                query,
                limit,
                object.get("cursor").and_then(Value::as_str),
            )
            .await?;
            json!({ "items": items, "nextCursor": cursor })
        }
        ("gmail", "message") => {
            require_scope(connector_id, &tokens, &[GMAIL_READONLY])?;
            let id = object
                .get("messageId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "messageId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(
                GMAIL_API,
                &format!("users/me/messages/{}", encode_segment(id)),
            )?;
            url.query_pairs_mut().append_pair("format", "full");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("gmail", "thread") => {
            require_scope(connector_id, &tokens, &[GMAIL_READONLY])?;
            let id = object
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "threadId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(
                GMAIL_API,
                &format!("users/me/threads/{}", encode_segment(id)),
            )?;
            url.query_pairs_mut().append_pair("format", "full");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "calendars") => {
            require_scope(connector_id, &tokens, &[CALENDAR_LIST])?;
            let mut url = api_url(CALENDAR_API, "users/me/calendarList")?;
            if let Some(cursor) = object.get("cursor").and_then(Value::as_str) {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            url.query_pairs_mut().append_pair("maxResults", "50");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "events") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let calendar = object
                .get("calendarId")
                .and_then(Value::as_str)
                .unwrap_or("primary");
            let mut url = api_url(
                CALENDAR_API,
                &format!("calendars/{}/events", encode_segment(calendar)),
            )?;
            for key in ["q", "timeMin", "timeMax", "pageToken"] {
                if let Some(value) = object.get(key).and_then(Value::as_str) {
                    url.query_pairs_mut().append_pair(key, value);
                }
            }
            url.query_pairs_mut()
                .append_pair("singleEvents", "true")
                .append_pair("orderBy", "startTime");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "event") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let calendar = object
                .get("calendarId")
                .and_then(Value::as_str)
                .unwrap_or("primary");
            let event = object
                .get("eventId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "eventId is required.",
                        false,
                    )
                })?;
            let url = api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar),
                    encode_segment(event)
                ),
            )?;
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "freebusy") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let time_min = object
                .get("timeMin")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "timeMin is required.",
                        false,
                    )
                })?;
            let time_max = object
                .get("timeMax")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "timeMax is required.",
                        false,
                    )
                })?;
            let calendars = object
                .get("calendarIds")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "calendarIds is required.",
                        false,
                    )
                })?;
            let items = calendars
                .iter()
                .filter_map(Value::as_str)
                .map(|id| json!({ "id": id }))
                .collect::<Vec<_>>();
            let url = api_url(CALENDAR_API, "freeBusy")?;
            send_json(
                call_id,
                connector_id,
                &tokens,
                Method::POST,
                url,
                Some(json!({ "timeMin": time_min, "timeMax": time_max, "items": items })),
            )
            .await?
        }
        _ => {
            return Err(error(
                connector_id,
                "invalid-request",
                "Unsupported Google read operation.",
                false,
            ))
        }
    };
    Ok(value)
}

#[cfg(test)]
mod tests;
