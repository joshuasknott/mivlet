//! First-wave connector runtime boundary.
//!
//! Provider adapters plug into this shared command surface. OAuth/token work is
//! delegated to `connector_auth`; secrets never enter this module or JavaScript.

use std::collections::{BTreeMap, BTreeSet};

use crate::approvals::resolve_approval;
use crate::collaboration_connectors;
use crate::connector_approvals::{
    record_pending_connector_action, update_connector_action_result,
    verify_prepared_connector_action,
};
use crate::connector_auth::{
    complete_auth, connection_for, disconnect, refresh_connection, start_auth, usable_connection,
    ConnectorConnection,
};
use crate::execution_approvals::verify_and_consume_execution_approval;
use crate::models::{
    ConnectorActionExecutionRequest, ConnectorActionRequest, ConnectorActionResult,
    ConnectorAuthRequest, ConnectorAuthResult, ConnectorCommandError, ConnectorHealth,
    ConnectorImportRequest, ConnectorImportResult, ConnectorManifest, ConnectorPermission,
    ConnectorSearchRequest, ConnectorSearchResult, APPROVAL_DECISIONS, CONNECTOR_ACTIONS,
    CONNECTOR_AUTH_STATES, FIRST_WAVE_CONNECTOR_IDS, MAX_CONNECTOR_PAYLOAD_FIELDS,
    MAX_CONNECTOR_QUERY_CHARACTERS, MAX_CONNECTOR_RESULT_LIMIT,
};
use crate::paths::{
    connector_approval_records_path, connector_connections_path, execution_approvals_path,
    normalize_spaces, truncate_characters,
};

pub(crate) trait ConnectorCredentialBoundary {
    fn connection(&self, connector_id: &str) -> Option<ConnectorConnection>;
}

struct UnavailableCredentialBoundary;

impl ConnectorCredentialBoundary for UnavailableCredentialBoundary {
    fn connection(&self, _connector_id: &str) -> Option<ConnectorConnection> {
        None
    }
}

struct NativeCredentialBoundary {
    connections_path: std::path::PathBuf,
}

impl ConnectorCredentialBoundary for NativeCredentialBoundary {
    fn connection(&self, connector_id: &str) -> Option<ConnectorConnection> {
        usable_connection(&self.connections_path, connector_id)
    }
}

struct ConnectorCatalogEntry {
    id: &'static str,
    name: &'static str,
    auth_mode: &'static str,
    permissions: &'static [&'static str],
    scopes: &'static [(&'static str, &'static str, &'static str, bool)],
    setup_message: &'static str,
    actions: &'static [&'static str],
}

struct ConnectorActionPolicy {
    label: &'static str,
    mode: &'static str,
    risk_level: &'static str,
    consequence: &'static str,
    confirmation_phrase: Option<&'static str>,
}

const GITHUB_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("contents:read", "Repository contents", "read", true),
    ("issues:read", "Issues", "read", true),
    ("pull_requests:write", "Draft pull requests", "write", false),
];
const VERCEL_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("project:read", "Projects", "read", true),
    ("deployment:read", "Deployments", "read", true),
    ("deployment:write", "Promote or rollback", "write", false),
];
const DRIVE_SCOPES: &[(&str, &str, &str, bool)] =
    &[("drive.file", "Selected Drive files", "read", true)];
const NOTION_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("read_content", "Read selected content", "read", true),
    ("insert_content", "Create content", "write", false),
    ("update_content", "Update content", "write", false),
];
const GMAIL_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("gmail.readonly", "Read mail", "read", true),
    ("gmail.compose", "Create drafts", "write", false),
];
const SLACK_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("channels:read", "Channel list", "read", true),
    ("channels:history", "Selected channel history", "read", true),
    ("groups:read", "Private channel list", "read", false),
    (
        "groups:history",
        "Selected private channel history",
        "read",
        false,
    ),
    ("users:read", "Workspace users", "read", true),
    ("search:read", "Supported message search", "read", false),
    ("chat:write", "Post approved messages", "write", false),
    (
        "reactions:write",
        "Change approved reactions",
        "write",
        false,
    ),
];
const CALENDAR_SCOPES: &[(&str, &str, &str, bool)] = &[
    (
        "calendar.calendarlist.readonly",
        "Calendar list",
        "read",
        true,
    ),
    ("calendar.events.readonly", "Calendar events", "read", true),
    ("calendar.events", "Create or update events", "write", false),
];

const CATALOG: &[ConnectorCatalogEntry] = &[
    ConnectorCatalogEntry {
        id: "github",
        name: "GitHub",
        auth_mode: "oauth-broker",
        permissions: &[
            "read repositories and selected files",
            "prepare draft pull requests and comments",
        ],
        scopes: GITHUB_SCOPES,
        setup_message: "Register a GitHub App and configure the Fable auth broker.",
        actions: &["github.draft-pull-request", "github.comment"],
    },
    ConnectorCatalogEntry {
        id: "vercel",
        name: "Vercel",
        auth_mode: "provider-installation",
        permissions: &[
            "read projects and deployments",
            "prepare promote or rollback requests",
        ],
        scopes: VERCEL_SCOPES,
        setup_message: "Create a Vercel integration and configure its External Flow redirect.",
        actions: &["vercel.promote", "vercel.rollback"],
    },
    ConnectorCatalogEntry {
        id: "google-drive",
        name: "Google Drive",
        auth_mode: "oauth-pkce",
        permissions: &["read files explicitly selected with Google Picker"],
        scopes: DRIVE_SCOPES,
        setup_message: "Enable Drive API and create a desktop OAuth client.",
        actions: &[
            "notion.create-page",
            "notion.update-page",
            "notion.append-blocks",
            "notion.update-block",
            "notion.delete-block",
            "notion.create-comment",
            "notion.create-entry",
        ],
    },
    ConnectorCatalogEntry {
        id: "notion",
        name: "Notion",
        auth_mode: "oauth-broker",
        permissions: &["read user-selected pages and databases"],
        scopes: NOTION_SCOPES,
        setup_message: "Create a Notion public connection and broker callback.",
        actions: &[],
    },
    ConnectorCatalogEntry {
        id: "gmail",
        name: "Gmail",
        auth_mode: "oauth-pkce",
        permissions: &[
            "read selected search results",
            "prepare email drafts; never send by default",
        ],
        scopes: GMAIL_SCOPES,
        setup_message:
            "Enable Gmail API, create a desktop OAuth client, and complete Google verification.",
        actions: &["gmail.create-draft", "gmail.send"],
    },
    ConnectorCatalogEntry {
        id: "slack",
        name: "Slack",
        auth_mode: "oauth-broker",
        permissions: &[
            "read selected conversations",
            "prepare messages; never post by default",
        ],
        scopes: SLACK_SCOPES,
        setup_message: "Create a Slack app and configure its HTTPS broker callback.",
        actions: &[
            "slack.create-draft",
            "slack.post",
            "slack.reply",
            "slack.edit",
            "slack.delete",
            "slack.react-add",
            "slack.react-remove",
        ],
    },
    ConnectorCatalogEntry {
        id: "google-calendar",
        name: "Google Calendar",
        auth_mode: "oauth-pkce",
        permissions: &[
            "read calendars and events",
            "prepare event create or update requests",
        ],
        scopes: CALENDAR_SCOPES,
        setup_message: "Enable Calendar API and create a desktop OAuth client.",
        actions: &[
            "google-calendar.create-draft",
            "google-calendar.update-draft",
        ],
    },
];

fn require_connector(
    connector_id: &str,
) -> Result<&'static ConnectorCatalogEntry, ConnectorCommandError> {
    let normalized = normalize_spaces(connector_id).to_ascii_lowercase();
    CATALOG
        .iter()
        .find(|entry| entry.id == normalized)
        .ok_or_else(|| command_error("invalid-request", &normalized, "Unknown connector.", false))
}

fn action_policy(action: &str) -> Option<ConnectorActionPolicy> {
    let policy = match action {
        "github.draft-pull-request" => ConnectorActionPolicy {
            label: "Draft Pull Request",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates a draft pull request after Fable approval.",
            confirmation_phrase: None,
        },
        "github.comment" => ConnectorActionPolicy {
            label: "Comment",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Publishes a comment to the selected GitHub item after Fable approval.",
            confirmation_phrase: None,
        },
        "vercel.promote" => ConnectorActionPolicy {
            label: "Promote",
            mode: "full-access",
            risk_level: "high",
            consequence: "Promotes the selected deployment to production.",
            confirmation_phrase: Some("promote deployment"),
        },
        "vercel.rollback" => ConnectorActionPolicy {
            label: "Rollback",
            mode: "full-access",
            risk_level: "high",
            consequence: "Rolls production back to the selected deployment.",
            confirmation_phrase: Some("rollback deployment"),
        },
        "gmail.create-draft" => ConnectorActionPolicy {
            label: "Create Draft",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates an email draft. It does not send the email.",
            confirmation_phrase: None,
        },
        "gmail.send" => ConnectorActionPolicy {
            label: "Send",
            mode: "full-access",
            risk_level: "high",
            consequence: "Sends the selected email to external recipients.",
            confirmation_phrase: Some("send email"),
        },
        "slack.create-draft" => ConnectorActionPolicy {
            label: "Create Draft",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates a local Slack message draft. It does not post the message.",
            confirmation_phrase: None,
        },
        "slack.post" => ConnectorActionPolicy {
            label: "Post",
            mode: "full-access",
            risk_level: "high",
            consequence: "Posts a message to the selected Slack conversation.",
            confirmation_phrase: Some("post message"),
        },
        "slack.reply" => ConnectorActionPolicy {
            label: "Reply",
            mode: "full-access",
            risk_level: "high",
            consequence: "Posts a reply to the selected Slack thread.",
            confirmation_phrase: Some("post message"),
        },
        "slack.edit" => ConnectorActionPolicy {
            label: "Edit",
            mode: "full-access",
            risk_level: "high",
            consequence: "Edits the selected Slack message.",
            confirmation_phrase: Some("change slack content"),
        },
        "slack.delete" => ConnectorActionPolicy {
            label: "Delete",
            mode: "full-access",
            risk_level: "critical",
            consequence: "Deletes the selected Slack message.",
            confirmation_phrase: Some("delete slack message"),
        },
        "slack.react-add" => ConnectorActionPolicy {
            label: "React Add",
            mode: "full-access",
            risk_level: "high",
            consequence: "Adds the selected reaction to a Slack message.",
            confirmation_phrase: Some("change slack content"),
        },
        "slack.react-remove" => ConnectorActionPolicy {
            label: "React Remove",
            mode: "full-access",
            risk_level: "high",
            consequence: "Removes the selected reaction from a Slack message.",
            confirmation_phrase: Some("change slack content"),
        },
        "notion.create-page" => ConnectorActionPolicy {
            label: "Create Page",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates a page in the selected Notion destination.",
            confirmation_phrase: None,
        },
        "notion.update-page" => ConnectorActionPolicy {
            label: "Update Page",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Updates the selected Notion page and properties.",
            confirmation_phrase: None,
        },
        "notion.append-blocks" => ConnectorActionPolicy {
            label: "Append Blocks",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Appends the proposed blocks to the selected Notion page.",
            confirmation_phrase: None,
        },
        "notion.update-block" => ConnectorActionPolicy {
            label: "Update Block",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Updates the selected Notion block.",
            confirmation_phrase: None,
        },
        "notion.delete-block" => ConnectorActionPolicy {
            label: "Delete Block",
            mode: "full-access",
            risk_level: "critical",
            consequence: "Archives the selected Notion block.",
            confirmation_phrase: Some("delete notion block"),
        },
        "notion.create-comment" => ConnectorActionPolicy {
            label: "Create Comment",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates the proposed comment on the selected Notion page.",
            confirmation_phrase: None,
        },
        "notion.create-entry" => ConnectorActionPolicy {
            label: "Create Entry",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates an entry in the selected Notion database.",
            confirmation_phrase: None,
        },
        "google-calendar.create-draft" => ConnectorActionPolicy {
            label: "Create Draft",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Creates a calendar event after Fable approval.",
            confirmation_phrase: None,
        },
        "google-calendar.update-draft" => ConnectorActionPolicy {
            label: "Update Draft",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Updates the selected calendar event after Fable approval.",
            confirmation_phrase: None,
        },
        _ => return None,
    };
    Some(policy)
}

fn command_error(
    code: &str,
    connector_id: &str,
    message: &str,
    retryable: bool,
) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable,
        retry_after: None,
    }
}

fn configuration_required(connector_id: &str) -> ConnectorCommandError {
    command_error(
        "configuration-required",
        connector_id,
        &redact_connector_text(
            "Provider configuration and OS secure storage are required before live connector access.",
        ),
        false,
    )
}

fn build_manifest(
    entry: &'static ConnectorCatalogEntry,
    boundary: &dyn ConnectorCredentialBoundary,
) -> ConnectorManifest {
    let connection = boundary.connection(entry.id);
    let connected = connection.is_some();
    let status = if connected { "connected" } else { "needs-auth" };
    debug_assert!(CONNECTOR_AUTH_STATES.contains(&status));

    ConnectorManifest {
        id: entry.id.to_string(),
        name: entry.name.to_string(),
        status: status.to_string(),
        permissions: entry
            .permissions
            .iter()
            .map(|permission| (*permission).to_string())
            .collect(),
        health_summary: if connected {
            "Credentials available; live provider health has not been checked."
        } else {
            "Provider configuration required"
        }
        .to_string(),
        last_checked_at: "Not checked".to_string(),
        auth_mode: entry.auth_mode.to_string(),
        scopes: entry
            .scopes
            .iter()
            .map(|(id, label, access, required)| ConnectorPermission {
                id: (*id).to_string(),
                label: (*label).to_string(),
                access: (*access).to_string(),
                required: *required,
                granted: connection.as_ref().is_some_and(|connection| {
                    connection
                        .scopes
                        .iter()
                        .any(|scope| scope == id || scope.ends_with(&format!("/{id}")))
                }),
            })
            .collect(),
        health: ConnectorHealth {
            state: "unknown".to_string(),
            summary: "Live provider health has not been checked.".to_string(),
            checked_at: "Not checked".to_string(),
            retry_after: None,
        },
        account: connection.map(|connection| connection.account),
        setup_message: (!connected).then(|| entry.setup_message.to_string()),
        supports_search: true,
        supports_import: true,
        supported_actions: entry
            .actions
            .iter()
            .map(|action| (*action).to_string())
            .collect(),
    }
}

pub(crate) fn list_connector_statuses_with(
    boundary: &dyn ConnectorCredentialBoundary,
) -> Vec<ConnectorManifest> {
    debug_assert_eq!(
        CATALOG.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        FIRST_WAVE_CONNECTOR_IDS
    );
    CATALOG
        .iter()
        .map(|entry| build_manifest(entry, boundary))
        .collect()
}

#[cfg(test)]
pub(crate) fn list_unconfigured_connector_statuses() -> Vec<ConnectorManifest> {
    list_connector_statuses_with(&UnavailableCredentialBoundary)
}

pub(crate) fn validate_connector_execution_request(
    request: ConnectorActionExecutionRequest,
) -> Result<
    (
        ConnectorActionRequest,
        crate::models::ApprovalResolutionResponse,
    ),
    ConnectorCommandError,
> {
    let action = validate_connector_action(request.action)?;
    if matches!(request.approval.decision.as_str(), "session" | "rule") {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "External connector writes require a fresh per-action approval.",
            false,
        ));
    }
    if request.approval.request != action.approval {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "The approval does not match this connector action.",
            false,
        ));
    }
    let resolution = resolve_approval(request.approval).map_err(|_| {
        command_error(
            "approval-required",
            &action.connector_id,
            "The connector action approval is invalid or incomplete.",
            false,
        )
    })?;
    Ok((action, resolution))
}

pub(crate) fn validate_connector_action(
    request: ConnectorActionRequest,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let policy = action_policy(&request.action);
    if !CONNECTOR_ACTIONS.contains(&request.action.as_str())
        || !entry.actions.contains(&request.action.as_str())
        || policy.is_none()
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "This action is not supported by the selected connector.",
            false,
        ));
    }
    let policy = policy.expect("supported connector action has a policy");
    let expected_fields = request
        .payload
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let approval_fields = request
        .approval
        .data_used
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let approval_decisions = request
        .approval
        .decisions
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if request.id.trim().is_empty()
        || request.approval.id != request.id
        || request.approval.service != entry.name
        || request.approval.action != policy.label
        || request.approval.mode != policy.mode
        || request.approval.risk_level != policy.risk_level
        || request.approval.consequence != policy.consequence
        || request.approval.confirmation_phrase.as_deref() != policy.confirmation_phrase
        || request.approval.requested_at.trim().is_empty()
        || approval_decisions != APPROVAL_DECISIONS
        || request.approval.data_used.len() != expected_fields.len()
        || approval_fields != expected_fields
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector action approval metadata does not match the request.",
            false,
        ));
    }
    if request.payload.len() > MAX_CONNECTOR_PAYLOAD_FIELDS {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector action payload has too many fields.",
            false,
        ));
    }
    Ok(request)
}

pub(crate) fn redact_connector_text(value: &str) -> String {
    let normalized = normalize_spaces(value);
    let lowercase = normalized.to_ascii_lowercase();
    let sensitive_markers = [
        "authorization:",
        "bearer ",
        "cookie:",
        "access_token",
        "refresh_token",
        "client_secret",
        "xoxb-",
        "xoxp-",
        "ghp_",
        "github_pat_",
        "email body",
        "message body",
        "raw payload",
    ];

    if sensitive_markers
        .iter()
        .any(|marker| lowercase.contains(marker))
    {
        return "[redacted connector data]".to_string();
    }

    truncate_characters(&normalized, 240)
}

#[tauri::command]
pub fn list_connector_statuses(app: tauri::AppHandle) -> Vec<ConnectorManifest> {
    let boundary = connector_connections_path(&app)
        .map(|connections_path| NativeCredentialBoundary { connections_path });
    match boundary {
        Ok(boundary) => list_connector_statuses_with(&boundary),
        Err(_) => list_connector_statuses_with(&UnavailableCredentialBoundary),
    }
}

#[tauri::command]
pub fn start_connector_auth(
    request: ConnectorAuthRequest,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    let scopes = entry
        .scopes
        .iter()
        .map(|scope| scope.0.to_string())
        .collect();
    start_auth(entry.id, entry.auth_mode, scopes, request)
}

#[tauri::command]
pub async fn complete_connector_auth(
    app: tauri::AppHandle,
    request: ConnectorAuthRequest,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    complete_auth(&app, entry.id, request).await
}

#[tauri::command]
pub async fn clear_connector_auth(
    app: tauri::AppHandle,
    connector_id: String,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    disconnect(&app, entry.id).await?;
    Ok(build_manifest(entry, &UnavailableCredentialBoundary))
}

#[tauri::command]
pub async fn refresh_connector_health(
    app: tauri::AppHandle,
    connector_id: String,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let _ = refresh_connection(&app, entry.id).await?;
    if matches!(entry.id, "notion" | "slack") {
        collaboration_connectors::validate_identity(&app, entry.id).await?;
    }
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    Ok(build_manifest(
        entry,
        &NativeCredentialBoundary { connections_path },
    ))
}

#[tauri::command]
pub async fn search_connector(
    app: tauri::AppHandle,
    request: ConnectorSearchRequest,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    if request.query.chars().count() > MAX_CONNECTOR_QUERY_CHARACTERS
        || !(1..=MAX_CONNECTOR_RESULT_LIMIT).contains(&request.limit.unwrap_or(20))
    {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector search request exceeds the supported limits.",
            false,
        ));
    }
    collaboration_connectors::search(&app, request).await
}

#[tauri::command]
pub fn import_connector_item(
    request: ConnectorImportRequest,
) -> Result<ConnectorImportResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    if request.item.connector_id != entry.id || request.imported_at.trim().is_empty() {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector import metadata does not match the selected provider.",
            false,
        ));
    }
    if !matches!(entry.id, "notion" | "slack") {
        return Err(configuration_required(entry.id));
    }
    let kind = if matches!(request.item.kind.as_str(), "database" | "conversation") {
        "folder"
    } else {
        "document"
    };
    Ok(ConnectorImportResult {
        source: crate::models::ConnectorKnowledgeSource {
            id: format!("connector-{}-{}", entry.id, request.item.id),
            title: request.item.title,
            kind: kind.to_string(),
            connector_id: entry.id.to_string(),
            provenance: request.item.provenance,
            freshness: request.item.freshness,
            pinned: false,
            trust: "untrusted".to_string(),
            content_preview: request.item.content_preview.or(Some(request.item.summary)),
            imported_at: request.imported_at,
            origin: "connector-import".to_string(),
            provider_metadata: request.item.provider_metadata,
        },
        imported: true,
    })
}

#[tauri::command]
pub fn prepare_connector_action(
    app: tauri::AppHandle,
    request: ConnectorActionRequest,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    let action = validate_connector_action(request)?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    let account_id = connection_for(&connections_path, &action.connector_id)
        .map(|connection| connection.account.id)
        .unwrap_or_else(|| "unconnected".to_string());
    record_pending_connector_action(
        &connector_approval_records_path(&app)
            .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?,
        &action,
        &account_id,
    )
    .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    Ok(action)
}

#[tauri::command]
pub async fn execute_approved_connector_action(
    app: tauri::AppHandle,
    request: ConnectorActionExecutionRequest,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    let (action, resolution) = validate_connector_execution_request(request)?;
    let records_path = connector_approval_records_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    verify_prepared_connector_action(&records_path, &action).map_err(|message| {
        command_error("approval-required", &action.connector_id, &message, false)
    })?;

    if resolution.audit_entry.decision == "deny" {
        let _ = update_connector_action_result(
            &records_path,
            &action.approval.id,
            "denied",
            &resolution.audit_entry.decided_at,
            None,
        );
        return Ok(ConnectorActionResult {
            request_id: action.id,
            connector_id: action.connector_id,
            action: action.action,
            status: "denied".to_string(),
            message: "The connector action was denied.".to_string(),
            provider_resource_id: None,
        });
    }

    verify_and_consume_execution_approval(
        &execution_approvals_path(&app).map_err(|message| {
            command_error("approval-required", &action.connector_id, &message, false)
        })?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )
    .map_err(|message| command_error("approval-required", &action.connector_id, &message, false))?;
    update_connector_action_result(
        &records_path,
        &action.approval.id,
        "approved",
        &resolution.audit_entry.decided_at,
        None,
    )
    .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;

    match collaboration_connectors::execute(&app, &action).await {
        Ok(result) => {
            update_connector_action_result(
                &records_path,
                &action.approval.id,
                "executed",
                &resolution.audit_entry.decided_at,
                None,
            )
            .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
            Ok(result)
        }
        Err(error) => {
            let _ = update_connector_action_result(
                &records_path,
                &action.approval.id,
                "failed",
                &resolution.audit_entry.decided_at,
                Some(&error.code),
            );
            Err(error)
        }
    }
}

#[allow(dead_code)]
fn _empty_provider_metadata() -> BTreeMap<String, String> {
    BTreeMap::new()
}
