//! Google response normalization and provider-independent item mapping.
//!
//! These helpers contain no network or credential access; keeping them separate
//! makes the egress module easier to audit without changing its facade.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    models::{ConnectorCommandError, ConnectorSearchItem},
    paths::truncate_characters,
};

use super::{error, MAX_PREVIEW_CHARACTERS};

pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(super) fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub(super) fn epoch_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

pub(super) fn escape_drive_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

pub(super) fn drive_item(value: &Value) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "google-drive",
            "provider-unavailable",
            "Drive file has no id.",
            false,
        )
    })?;
    let name = string(value, "name").unwrap_or_else(|| "Untitled Drive item".to_string());
    let mime = string(value, "mimeType").unwrap_or_default();
    let kind = if mime == "application/vnd.google-apps.folder" {
        "folder"
    } else {
        "file"
    };
    let mut metadata = BTreeMap::from([
        ("mimeType".to_string(), mime.clone()),
        ("selected".to_string(), "true".to_string()),
    ]);
    if let Some(parents) = value.get("parents").and_then(Value::as_array) {
        metadata.insert(
            "parents".to_string(),
            parents
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    Ok(ConnectorSearchItem {
        id,
        connector_id: "google-drive".to_string(),
        connection_id: None,
        title: name,
        kind: kind.to_string(),
        summary: if mime == "application/vnd.google-apps.folder" {
            "Google Drive folder".to_string()
        } else {
            format!("Google Drive file ({mime})")
        },
        provenance: "Google Drive · authenticated account".to_string(),
        freshness: string(value, "modifiedTime").unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: string(value, "webViewLink"),
        content_preview: None,
        provider_metadata: metadata,
    })
}

pub(super) fn gmail_header(value: &Value, name: &str) -> Option<String> {
    value
        .pointer("/payload/headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|header| {
            header
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
        })
        .and_then(|header| header.get("value"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(super) fn gmail_item(value: &Value) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "gmail",
            "provider-unavailable",
            "Gmail message has no id.",
            false,
        )
    })?;
    let thread_id = string(value, "threadId").unwrap_or_else(|| id.clone());
    let from = gmail_header(value, "From").unwrap_or_else(|| "Unknown sender".to_string());
    let subject = gmail_header(value, "Subject").unwrap_or_else(|| "(No subject)".to_string());
    Ok(ConnectorSearchItem {
        id,
        connector_id: "gmail".to_string(),
        connection_id: None,
        title: subject,
        kind: "message".to_string(),
        summary: format!("Message from {from}"),
        provenance: "Gmail · authenticated mailbox".to_string(),
        freshness: gmail_header(value, "Date")
            .or_else(|| string(value, "internalDate"))
            .unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: None,
        content_preview: string(value, "snippet")
            .map(|value| truncate_characters(&value, MAX_PREVIEW_CHARACTERS)),
        provider_metadata: BTreeMap::from([
            ("threadId".to_string(), thread_id),
            ("from".to_string(), from),
            ("labels".to_string(), strings(value, "labelIds").join(",")),
        ]),
    })
}

pub(super) fn calendar_item(
    value: &Value,
    calendar_id: &str,
) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "google-calendar",
            "provider-unavailable",
            "Calendar resource has no id.",
            false,
        )
    })?;
    let is_calendar = value.get("summaryOverride").is_some() || value.get("accessRole").is_some();
    let title = string(value, "summaryOverride")
        .or_else(|| string(value, "summary"))
        .unwrap_or_else(|| "Untitled calendar item".to_string());
    let start = value
        .pointer("/start/dateTime")
        .or_else(|| value.pointer("/start/date"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let end = value
        .pointer("/end/dateTime")
        .or_else(|| value.pointer("/end/date"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut metadata = BTreeMap::from([("calendarId".to_string(), calendar_id.to_string())]);
    if let Some(start) = start.as_ref() {
        metadata.insert("start".to_string(), start.clone());
    }
    if let Some(end) = end.as_ref() {
        metadata.insert("end".to_string(), end.clone());
    }
    if let Some(status) = string(value, "status") {
        metadata.insert("status".to_string(), status);
    }
    Ok(ConnectorSearchItem {
        id,
        connector_id: "google-calendar".to_string(),
        connection_id: None,
        title,
        kind: if is_calendar { "calendar" } else { "event" }.to_string(),
        summary: string(value, "description").unwrap_or_else(|| {
            if is_calendar {
                "Accessible Google calendar"
            } else {
                "Google calendar event"
            }
            .to_string()
        }),
        provenance: format!("Google Calendar · {calendar_id}"),
        freshness: start.unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: string(value, "htmlLink"),
        content_preview: string(value, "description")
            .map(|value| truncate_characters(&value, MAX_PREVIEW_CHARACTERS)),
        provider_metadata: metadata,
    })
}
