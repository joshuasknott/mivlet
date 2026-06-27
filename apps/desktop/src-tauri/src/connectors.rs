//! First-wave connector runtime boundary.
//!
//! This module deliberately contains no provider HTTP calls and no credential
//! storage. The `ConnectorCredentialBoundary` trait is the seam for a future OS
//! keychain implementation. The current implementation fails closed with
//! `configuration-required`, while still exposing honest status metadata and
//! validating approval-gated action requests.

use std::collections::{BTreeMap, BTreeSet};

use crate::approvals::resolve_approval;
use crate::models::{
    ConnectorActionExecutionRequest, ConnectorActionRequest, ConnectorActionResult,
    ConnectorAuthRequest, ConnectorAuthResult, ConnectorCommandError, ConnectorHealth,
    ConnectorImportRequest, ConnectorImportResult, ConnectorManifest, ConnectorPermission,
    ConnectorSearchRequest, ConnectorSearchResult, APPROVAL_DECISIONS, CONNECTOR_ACTIONS,
    CONNECTOR_AUTH_STATES, FIRST_WAVE_CONNECTOR_IDS, MAX_CONNECTOR_PAYLOAD_FIELDS,
    MAX_CONNECTOR_QUERY_CHARACTERS, MAX_CONNECTOR_RESULT_LIMIT,
};
use crate::paths::{normalize_spaces, truncate_characters};

pub(crate) trait ConnectorCredentialBoundary {
    fn has_credentials(&self, connector_id: &str) -> bool;
    fn clear(&self, connector_id: &str) -> Result<(), ConnectorCommandError>;
}

struct UnavailableCredentialBoundary;

impl ConnectorCredentialBoundary for UnavailableCredentialBoundary {
    fn has_credentials(&self, _connector_id: &str) -> bool {
        false
    }

    fn clear(&self, connector_id: &str) -> Result<(), ConnectorCommandError> {
        require_connector(connector_id)?;
        Ok(())
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
const NOTION_SCOPES: &[(&str, &str, &str, bool)] =
    &[("read_content", "Read selected content", "read", true)];
const GMAIL_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("gmail.readonly", "Read mail", "read", true),
    ("gmail.compose", "Create drafts", "write", false),
];
const SLACK_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("channels:read", "Channel list", "read", true),
    ("channels:history", "Selected channel history", "read", true),
    ("chat:write", "Post approved messages", "write", false),
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
        actions: &[],
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
        actions: &["slack.create-draft", "slack.post"],
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
    let connected = boundary.has_credentials(entry.id);
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
                granted: connected,
            })
            .collect(),
        health: ConnectorHealth {
            state: "unknown".to_string(),
            summary: "Live provider health has not been checked.".to_string(),
            checked_at: "Not checked".to_string(),
            retry_after: None,
        },
        account: None,
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
pub fn list_connector_statuses() -> Vec<ConnectorManifest> {
    list_connector_statuses_with(&UnavailableCredentialBoundary)
}

#[tauri::command]
pub fn start_connector_auth(
    request: ConnectorAuthRequest,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    if let Some(redirect_uri) = request.redirect_uri {
        let normalized = redirect_uri.to_ascii_lowercase();
        let safe_loopback = normalized.starts_with("http://127.0.0.1:")
            || normalized.starts_with("http://[::1]:")
            || normalized.starts_with("https://");
        if !safe_loopback {
            return Err(command_error(
                "invalid-request",
                entry.id,
                "OAuth redirect must use HTTPS or a loopback IP address.",
                false,
            ));
        }
    }
    Err(configuration_required(entry.id))
}

#[tauri::command]
pub fn complete_connector_auth(
    request: ConnectorAuthRequest,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let entry = require_connector(&request.connector_id)?;
    Err(configuration_required(entry.id))
}

#[tauri::command]
pub fn clear_connector_auth(
    connector_id: String,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    let boundary = UnavailableCredentialBoundary;
    boundary.clear(entry.id)?;
    Ok(build_manifest(entry, &boundary))
}

#[tauri::command]
pub fn refresh_connector_health(
    connector_id: String,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    let entry = require_connector(&connector_id)?;
    Ok(build_manifest(entry, &UnavailableCredentialBoundary))
}

#[tauri::command]
pub fn search_connector(
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
    let _cursor = request.cursor.as_deref().map(normalize_spaces);
    Err(configuration_required(entry.id))
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
    Err(configuration_required(entry.id))
}

#[tauri::command]
pub fn prepare_connector_action(
    request: ConnectorActionRequest,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    validate_connector_action(request)
}

#[tauri::command]
pub fn execute_approved_connector_action(
    request: ConnectorActionExecutionRequest,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    let action = validate_connector_action(request.action)?;
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

    if resolution.audit_entry.decision == "deny" {
        return Ok(ConnectorActionResult {
            request_id: action.id,
            connector_id: action.connector_id,
            action: action.action,
            status: "denied".to_string(),
            message: "The connector action was denied.".to_string(),
            provider_resource_id: None,
        });
    }

    Err(configuration_required(&action.connector_id))
}

#[allow(dead_code)]
fn _empty_provider_metadata() -> BTreeMap<String, String> {
    BTreeMap::new()
}
