//! First-wave connector runtime boundary.
//!
//! Provider adapters plug into this shared command surface. OAuth/token work is
//! delegated to `connector_auth`; secrets never enter this module or JavaScript.

use std::collections::{BTreeMap, BTreeSet};

use crate::approvals::resolve_approval;
use crate::collaboration_connectors;
use crate::connector_api;
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
    ConnectorAuthRequest, ConnectorAuthResult, ConnectorCapabilityRequest,
    ConnectorCapabilityResult, ConnectorCommandError, ConnectorHealth, ConnectorImportRequest,
    ConnectorImportResult, ConnectorKnowledgeSource, ConnectorManifest, ConnectorPermission,
    ConnectorSearchRequest, ConnectorSearchResult, APPROVAL_DECISIONS, CONNECTOR_ACTIONS,
    CONNECTOR_AUTH_STATES, FIRST_WAVE_CONNECTOR_IDS, MAX_CONNECTOR_PAYLOAD_FIELDS,
    MAX_CONNECTOR_QUERY_CHARACTERS, MAX_CONNECTOR_RESULT_LIMIT,
};
use crate::oauth_loopback;
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
    ("read:user", "Account identity", "read", true),
    (
        "repo",
        "Repositories, issues, and pull requests",
        "read",
        true,
    ),
    ("read:org", "Organization membership", "read", false),
];
const VERCEL_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("project:read", "Projects", "read", true),
    ("deployment:read", "Deployments", "read", true),
    ("deployment:write", "Promote or rollback", "write", false),
];
const DRIVE_SCOPES: &[(&str, &str, &str, bool)] = &[(
    "https://www.googleapis.com/auth/drive.file",
    "Selected Drive files",
    "read",
    true,
)];
const NOTION_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("read_content", "Read selected content", "read", true),
    ("insert_content", "Create content", "write", false),
    ("update_content", "Update content", "write", false),
];
const GMAIL_SCOPES: &[(&str, &str, &str, bool)] = &[
    (
        "https://www.googleapis.com/auth/gmail.readonly",
        "Read mail",
        "read",
        true,
    ),
    (
        "https://www.googleapis.com/auth/gmail.compose",
        "Create drafts",
        "write",
        false,
    ),
    (
        "https://www.googleapis.com/auth/gmail.send",
        "Send approved mail",
        "write",
        false,
    ),
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
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "Calendar list",
        "read",
        true,
    ),
    (
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "Calendar events",
        "read",
        true,
    ),
    (
        "https://www.googleapis.com/auth/calendar.events",
        "Create or update events",
        "write",
        false,
    ),
];
const LINEAR_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("read", "Workspace data", "read", true),
    ("write", "Issue changes", "write", false),
    ("comments:create", "Create comments", "write", false),
];

const CATALOG: &[ConnectorCatalogEntry] = &[
    ConnectorCatalogEntry {
        id: "github",
        name: "GitHub",
        auth_mode: "oauth-broker",
        permissions: &[
            "read authenticated account identity",
            "read repositories, issues, and pull requests",
        ],
        scopes: GITHUB_SCOPES,
        setup_message: "Register a GitHub OAuth App and configure the Fable auth broker.",
        actions: &[],
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
        actions: &[
            "vercel.promote",
            "vercel.rollback",
            "vercel.create-deployment",
            "vercel.cancel-deployment",
            "vercel.update-project",
            "vercel.create-domain",
            "vercel.update-domain",
            "vercel.delete-domain",
        ],
    },
    ConnectorCatalogEntry {
        id: "google-drive",
        name: "Google Drive",
        auth_mode: "oauth-pkce",
        permissions: &[
            "search accessible file metadata",
            "read or export content only when the matching scope is granted",
            "prepare approval-gated file changes",
        ],
        scopes: DRIVE_SCOPES,
        setup_message: "Enable the Drive API, create a desktop OAuth client, and set FABLE_GOOGLE_OAUTH_CLIENT_ID.",
        actions: &[
            "google-drive.create-file",
            "google-drive.update-file",
            "google-drive.move-file",
            "google-drive.rename-file",
            "google-drive.share-file",
            "google-drive.delete-file",
        ],
    },
    ConnectorCatalogEntry {
        id: "notion",
        name: "Notion",
        auth_mode: "oauth-broker",
        permissions: &[
            "read user-selected pages and databases",
            "prepare approval-gated page, block, comment, and database entry changes",
        ],
        scopes: NOTION_SCOPES,
        setup_message: "Create a Notion public connection and broker callback.",
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
        id: "gmail",
        name: "Gmail",
        auth_mode: "oauth-pkce",
        permissions: &[
            "read selected search results",
            "prepare email drafts; never send by default",
        ],
        scopes: GMAIL_SCOPES,
        setup_message:
            "Enable the Gmail API, create a desktop OAuth client, set FABLE_GOOGLE_OAUTH_CLIENT_ID, and complete required Google verification.",
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
        setup_message: "Enable the Calendar API, create a desktop OAuth client, and set FABLE_GOOGLE_OAUTH_CLIENT_ID.",
        actions: &[
            "google-calendar.create-draft",
            "google-calendar.update-draft",
            "google-calendar.cancel-event",
            "google-calendar.delete-event",
        ],
    },
    ConnectorCatalogEntry {
        id: "linear",
        name: "Linear",
        auth_mode: "oauth-broker",
        permissions: &[
            "read workspace, teams, projects, cycles, issues, comments, labels, and users",
            "create and update issues and comments after approval",
        ],
        scopes: LINEAR_SCOPES,
        setup_message: "Create a Linear OAuth application and configure the Fable auth broker.",
        actions: &[
            "linear.create-issue",
            "linear.update-issue",
            "linear.comment",
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

/// The auth boundary a connector sits behind. Public Google desktop OAuth uses
/// direct loopback PKCE and never needs the broker. Confidential connectors use
/// the configured HTTPS broker and fail closed until it is deployed. The local
/// workspace itself remains local-first and has no external auth.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConnectorAuthBoundary {
    Public,
    Confidential,
}

#[cfg(test)]
pub(crate) fn connector_auth_boundary(connector_id: &str) -> Option<ConnectorAuthBoundary> {
    match CATALOG.iter().find(|entry| entry.id == connector_id)? {
        entry if entry.auth_mode == "oauth-pkce" => Some(ConnectorAuthBoundary::Public),
        entry if matches!(entry.auth_mode, "oauth-broker" | "provider-installation") => {
            Some(ConnectorAuthBoundary::Confidential)
        }
        _ => None,
    }
}

/// Confidential connector ids that require the deployed auth broker.
#[cfg(test)]
pub(crate) const BROKER_REQUIRED_CONNECTOR_IDS: &[&str] =
    &["github", "vercel", "notion", "slack", "linear"];

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
        "github.create-issue" => external_policy(
            "Create Issue",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "github.update-issue" => external_policy(
            "Update Issue",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "github.create-review" => external_policy(
            "Create Review",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "github.update-file" => external_policy(
            "Update File",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "github.create-branch" => external_policy(
            "Create Branch",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "github.dispatch-workflow" => external_policy(
            "Dispatch Workflow",
            "Changes the identified GitHub repository resource after explicit approval.",
        ),
        "vercel.create-deployment" => external_policy(
            "Create Deployment",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "vercel.cancel-deployment" => external_policy(
            "Cancel Deployment",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "vercel.update-project" => external_policy(
            "Update Project",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "vercel.create-domain" => external_policy(
            "Create Domain",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "vercel.update-domain" => external_policy(
            "Update Domain",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "vercel.delete-domain" => external_policy(
            "Delete Domain",
            "Changes the identified Vercel team or project resource after explicit approval.",
        ),
        "linear.create-issue" => linear_policy("Create Issue"),
        "linear.update-issue" => linear_policy("Update Issue"),
        "linear.comment" => linear_policy("Comment"),
        "google-drive.create-file" => ConnectorActionPolicy {
            label: "Create File",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence:
                "Creates a file in the selected Google Drive destination after explicit approval.",
            confirmation_phrase: None,
        },
        "google-drive.update-file" => ConnectorActionPolicy {
            label: "Update File",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence:
                "Replaces content in the selected Google Drive file after explicit approval.",
            confirmation_phrase: None,
        },
        "google-drive.move-file" => ConnectorActionPolicy {
            label: "Move File",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Moves the selected Google Drive item after explicit approval.",
            confirmation_phrase: None,
        },
        "google-drive.rename-file" => ConnectorActionPolicy {
            label: "Rename File",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Renames the selected Google Drive item after explicit approval.",
            confirmation_phrase: None,
        },
        "google-drive.share-file" => ConnectorActionPolicy {
            label: "Share File",
            mode: "full-access",
            risk_level: "high",
            consequence: "Shares the selected Google Drive item with an external recipient.",
            confirmation_phrase: Some("share drive file"),
        },
        "google-drive.delete-file" => ConnectorActionPolicy {
            label: "Delete File",
            mode: "full-access",
            risk_level: "high",
            consequence: "Deletes the selected Google Drive item.",
            confirmation_phrase: Some("delete drive file"),
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
        "google-calendar.delete-event" => ConnectorActionPolicy {
            label: "Delete Event",
            mode: "full-access",
            risk_level: "high",
            consequence: "Permanently deletes the selected calendar event after explicit approval.",
            confirmation_phrase: Some("delete calendar event"),
        },
        "google-calendar.cancel-event" => ConnectorActionPolicy {
            label: "Cancel Event",
            mode: "full-access",
            risk_level: "high",
            consequence: "Cancels the selected calendar event after explicit approval.",
            confirmation_phrase: Some("cancel calendar event"),
        },
        _ => return None,
    };
    Some(policy)
}

fn external_policy(label: &'static str, consequence: &'static str) -> ConnectorActionPolicy {
    ConnectorActionPolicy {
        label,
        mode: "full-access",
        risk_level: "high",
        consequence,
        confirmation_phrase: Some("confirm external write"),
    }
}

fn linear_policy(label: &'static str) -> ConnectorActionPolicy {
    ConnectorActionPolicy {
        label,
        mode: "trusted-scope",
        risk_level: "medium",
        consequence: "Creates or changes the identified Linear issue after explicit approval.",
        confirmation_phrase: None,
    }
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
    build_manifest_with_health(entry, boundary, None)
}

fn build_manifest_with_health(
    entry: &'static ConnectorCatalogEntry,
    boundary: &dyn ConnectorCredentialBoundary,
    health: Option<ConnectorHealth>,
) -> ConnectorManifest {
    let connection = boundary.connection(entry.id);
    let configuration_state = connector_configuration_state(entry);
    let configured = configuration_state == "configured";
    let status = connector_manifest_status(entry, connection.as_ref(), health.as_ref());
    let connected = status == "connected";
    debug_assert!(CONNECTOR_AUTH_STATES.contains(&status));

    let health = health.unwrap_or(ConnectorHealth {
        state: "unknown".to_string(),
        summary: if connected {
            "Credentials available; live provider health has not been checked.".to_string()
        } else if !configured {
            "Provider configuration required".to_string()
        } else {
            "Ready to connect".to_string()
        },
        checked_at: "Not checked".to_string(),
        retry_after: None,
    });
    let health_summary = match health.state.as_str() {
        "healthy" => health.summary.clone(),
        "degraded" | "error" => health.summary.clone(),
        _ if connected => {
            "Credentials available; live provider health has not been checked.".to_string()
        }
        _ if configured => "Ready to connect".to_string(),
        _ => "Provider configuration required".to_string(),
    };

    ConnectorManifest {
        id: entry.id.to_string(),
        name: entry.name.to_string(),
        status: status.to_string(),
        permissions: entry
            .permissions
            .iter()
            .map(|permission| (*permission).to_string())
            .collect(),
        health_summary,
        last_checked_at: health.checked_at.clone(),
        auth_mode: entry.auth_mode.to_string(),
        scopes: entry
            .scopes
            .iter()
            .map(|(id, label, access, required)| ConnectorPermission {
                id: (*id).to_string(),
                label: (*label).to_string(),
                access: (*access).to_string(),
                required: *required,
                granted: connected
                    && connection.as_ref().is_some_and(|connection| {
                        connection
                            .scopes
                            .iter()
                            .any(|scope| scope == id || scope.ends_with(&format!("/{id}")))
                    }),
            })
            .collect(),
        health,
        account: connected
            .then(|| {
                connection
                    .as_ref()
                    .map(|connection| connection.account.clone())
            })
            .flatten(),
        setup_message: (!connected).then(|| {
            if configured {
                "Choose Connect to authorize this provider.".to_string()
            } else {
                entry.setup_message.to_string()
            }
        }),
        supports_search: true,
        supports_import: true,
        supported_actions: entry
            .actions
            .iter()
            .map(|action| (*action).to_string())
            .collect(),
    }
}

fn connector_configuration_state(entry: &'static ConnectorCatalogEntry) -> &'static str {
    match entry.auth_mode {
        "oauth-pkce" => {
            if std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID")
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
            {
                "configured"
            } else {
                "unconfigured"
            }
        }
        "oauth-broker" | "provider-installation" => {
            let broker_url = std::env::var("FABLE_AUTH_BROKER_URL").ok();
            if crate::connector_auth::resolve_broker_endpoints(entry.id, broker_url.as_deref())
                .is_ok()
            {
                "configured"
            } else {
                "unconfigured"
            }
        }
        _ => "configured",
    }
}

fn connector_manifest_status(
    entry: &'static ConnectorCatalogEntry,
    connection: Option<&ConnectorConnection>,
    health: Option<&ConnectorHealth>,
) -> &'static str {
    let configuration_state = connector_configuration_state(entry);
    if configuration_state == "unconfigured" {
        return "unconfigured";
    }
    let Some(connection) = connection else {
        return "configured";
    };
    match connection.status.as_str() {
        "connected" => match health.map(|health| health.state.as_str()) {
            Some("degraded") | Some("error") => "provider-error",
            _ => "connected",
        },
        "expired" => "expired",
        "revoked" => "revoked",
        "configured" => "configured",
        "needs-auth" => "needs-auth",
        "unavailable" => "unavailable",
        "error" => "error",
        "provider-error" => "provider-error",
        _ => "provider-error",
    }
}

/// Resolve live provider health for a connected connector by probing the
/// provider identity endpoint through the authenticated token boundary. Returns
/// `None` when the connector has no probe path; callers keep the prior health.
async fn probe_connector_health(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Option<ConnectorHealth> {
    match connector_id {
        "google-drive" | "gmail" | "google-calendar" => {
            Some(crate::google::probe_health(app, connector_id).await)
        }
        "github" | "vercel" | "linear" => {
            Some(connector_api::probe_health(app, connector_id).await)
        }
        "notion" | "slack" => Some(collaboration_connectors::probe_health(app, connector_id).await),
        _ => None,
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
    let route_mode = action
        .permission_mode
        .as_deref()
        .unwrap_or(action.approval.mode.as_str());
    crate::permission_policy::ensure_permission_allowed(
        route_mode,
        action.permission_profile.as_deref(),
        "connector-write",
        &action.approval.risk_level,
    )
    .map_err(|message| command_error("approval-required", &action.connector_id, &message, false))?;
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
    let route_mode = request
        .permission_mode
        .as_deref()
        .unwrap_or(request.approval.mode.as_str());
    crate::permission_policy::ensure_permission_allowed(
        route_mode,
        request.permission_profile.as_deref(),
        "connector-write",
        request.approval.risk_level.as_str(),
    )
    .map_err(|message| command_error("approval-required", entry.id, &message, false))?;
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

/// Record a connector action into the unified action-history store (observation
/// only). The connector-approval-records store remains the rich per-action
/// audit; this mirrors the terminal states into the inspectable history surface.
/// Best-effort: never blocks execution.
fn audit_connector_action(
    action: &ConnectorActionRequest,
    status: &str,
    error_code: &str,
    message: &str,
) {
    let approval = &action.approval;
    crate::action_history::Recorder::new(
        crate::action_history::categories::CONNECTOR_ACTION,
        &action.connector_id,
        &action.action,
        status,
    )
    .actor("system")
    .mode(&approval.mode)
    .risk(&approval.risk_level)
    .correlation(&approval.id)
    .error(error_code)
    .summary(message)
    // Payload keys are non-secret identifiers (target/preview); values are
    // redacted by the recorder before sealing. Never include tokens/keys.
    .detail(serde_json::json!({
        "connectorId": action.connector_id,
        "proposedAction": action.action,
        "target": action.payload.get("target").cloned().unwrap_or_default(),
        "preview": action.payload.get("preview").cloned().unwrap_or_default(),
    }))
    .record();
}

fn require_connector_workspace(workspace_id: Option<String>) -> Result<(), ConnectorCommandError> {
    let workspace_id = workspace_id
        .unwrap_or_else(|| crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string());
    if workspace_id != crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
        return Err(command_error(
            "invalid-request",
            "workspace",
            "Connector credentials are not configured for this workspace.",
            false,
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn list_connector_statuses(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
) -> Result<Vec<ConnectorManifest>, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let boundary = connector_connections_path(&app)
        .map(|connections_path| NativeCredentialBoundary { connections_path });
    Ok(match boundary {
        Ok(boundary) => list_connector_statuses_with(&boundary),
        Err(_) => list_connector_statuses_with(&UnavailableCredentialBoundary),
    })
}

#[tauri::command]
pub fn start_connector_auth(
    request: ConnectorAuthRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    let declared = entry
        .scopes
        .iter()
        .map(|scope| scope.0)
        .collect::<BTreeSet<_>>();
    let scopes = match request.requested_scopes.as_ref() {
        Some(scopes) if scopes.is_empty() => {
            return Err(command_error(
                "invalid-request",
                entry.id,
                "Incremental authorization requires at least one scope.",
                false,
            ))
        }
        Some(scopes) => {
            let mut selected = Vec::new();
            for scope in scopes {
                let normalized = normalize_spaces(scope);
                if !declared.contains(normalized.as_str()) {
                    return Err(command_error(
                        "invalid-request",
                        entry.id,
                        "Requested OAuth scope is not declared by this connector.",
                        false,
                    ));
                }
                if !selected.contains(&normalized) {
                    selected.push(normalized);
                }
            }
            selected
        }
        None => entry
            .scopes
            .iter()
            .filter(|scope| scope.3)
            .map(|scope| scope.0.to_string())
            .collect(),
    };
    start_auth(entry.id, entry.auth_mode, scopes, request)
}

#[tauri::command]
pub async fn complete_connector_auth(
    app: tauri::AppHandle,
    request: ConnectorAuthRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    complete_auth(&app, entry.id, request).await
}

/// Begin a loopback OAuth flow end-to-end: bind an exact desktop redirect,
/// start the transaction, open the browser, accept one callback, and complete
/// token exchange inside the credential boundary. Confidential providers route
/// exchange through the configured auth broker and fail closed when it is
/// unavailable; public Google clients call Google directly.
#[tauri::command]
pub async fn begin_connector_oauth(
    app: tauri::AppHandle,
    request: ConnectorAuthRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    let declared = entry
        .scopes
        .iter()
        .map(|scope| scope.0)
        .collect::<BTreeSet<_>>();
    let scopes = match request.requested_scopes.as_ref() {
        Some(scopes) if scopes.is_empty() => {
            return Err(command_error(
                "invalid-request",
                entry.id,
                "Incremental authorization requires at least one scope.",
                false,
            ))
        }
        Some(scopes) => {
            let mut selected = Vec::new();
            for scope in scopes {
                let normalized = normalize_spaces(scope);
                if !declared.contains(normalized.as_str()) {
                    return Err(command_error(
                        "invalid-request",
                        entry.id,
                        "Requested OAuth scope is not declared by this connector.",
                        false,
                    ));
                }
                if !selected.contains(&normalized) {
                    selected.push(normalized);
                }
            }
            selected
        }
        None => entry
            .scopes
            .iter()
            .filter(|scope| scope.3)
            .map(|scope| scope.0.to_string())
            .collect(),
    };
    oauth_loopback::run_loopback_oauth(&app, entry.id, entry.auth_mode, scopes, request).await
}

#[tauri::command]
pub async fn clear_connector_auth(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&connector_id)?;
    disconnect(&app, entry.id).await?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    Ok(build_manifest(
        entry,
        &NativeCredentialBoundary {
            connections_path: path,
        },
    ))
}

/// List every connected account for a connector (active first), so the UI can
/// render an account switcher. Token secrets never leave the credential
/// boundary; only non-secret account summaries are returned. Multi-account
/// support lets a user keep several Google accounts connected and switch the
/// one reads/actions resolve against.
#[tauri::command]
pub fn list_connector_accounts(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<Vec<crate::models::ConnectorAccountOption>, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&connector_id)?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    Ok(crate::connector_auth::accounts_for_connector(
        &path, entry.id,
    ))
}

/// Make `account_id` the active account for a connector. Other accounts for the
/// same connector are deactivated but their credentials are preserved, so the
/// user can switch back. Returns the refreshed manifest reflecting the new
/// active account. Fails closed if the account is not connected.
#[tauri::command]
pub fn switch_connector_account(
    app: tauri::AppHandle,
    connector_id: String,
    account_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&connector_id)?;
    let path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    crate::connector_auth::switch_active_account(&path, entry.id, &account_id)?;
    Ok(build_manifest(
        entry,
        &NativeCredentialBoundary {
            connections_path: path,
        },
    ))
}

#[tauri::command]
pub async fn refresh_connector_health(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: Option<String>,
) -> Result<ConnectorManifest, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&connector_id)?;
    // Refresh first: this rotates expiring tokens and fails closed when the
    // connection is missing or the refresh is rejected. A failed refresh is a
    // real provider error, not a fixture fallback.
    let _ = refresh_connection(&app, entry.id).await?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", entry.id, &message, false))?;
    // Probe live provider health through the authenticated token boundary. A
    // probe failure is surfaced as a degraded/error health state, never as a
    // fixture or a fake "connected" claim.
    let health = probe_connector_health(&app, entry.id).await;
    Ok(build_manifest_with_health(
        entry,
        &NativeCredentialBoundary { connections_path },
        health,
    ))
}

#[tauri::command]
pub async fn search_connector(
    app: tauri::AppHandle,
    request: ConnectorSearchRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
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
    if matches!(entry.id, "google-drive" | "gmail" | "google-calendar") {
        return crate::google::search(&app, request).await;
    }
    if matches!(entry.id, "github" | "vercel" | "linear") {
        return connector_api::search(&app, request).await;
    }
    if matches!(entry.id, "notion" | "slack") {
        return collaboration_connectors::search(&app, request).await;
    }
    Err(configuration_required(entry.id))
}

#[tauri::command]
pub async fn read_connector_capability(
    app: tauri::AppHandle,
    request: ConnectorCapabilityRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorCapabilityResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    if !matches!(entry.id, "github" | "vercel" | "linear") {
        return Err(configuration_required(entry.id));
    }
    connector_api::read_capability(&app, request).await
}

#[tauri::command]
pub async fn import_connector_item(
    app: tauri::AppHandle,
    request: ConnectorImportRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorImportResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let entry = require_connector(&request.connector_id)?;
    if request.item.connector_id != entry.id || request.imported_at.trim().is_empty() {
        return Err(command_error(
            "invalid-request",
            entry.id,
            "Connector import metadata does not match the selected provider.",
            false,
        ));
    }
    if matches!(entry.id, "google-drive" | "gmail" | "google-calendar") {
        return crate::google::import(&app, request).await;
    }
    if !matches!(
        entry.id,
        "github" | "vercel" | "linear" | "notion" | "slack"
    ) {
        return Err(configuration_required(entry.id));
    }
    let kind = match request.item.kind.as_str() {
        "repository" | "branch" | "project" | "database" | "conversation" | "calendar" => "folder",
        "deployment" => "web",
        _ => "document",
    };
    Ok(ConnectorImportResult {
        source: ConnectorKnowledgeSource {
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
    workspace_id: Option<String>,
) -> Result<ConnectorActionRequest, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
    let action = validate_connector_action(request)?;
    let connections_path = connector_connections_path(&app)
        .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    let connection = connection_for(&connections_path, &action.connector_id);
    let account_id = connection
        .as_ref()
        .map(|connection| connection.account.id.clone())
        .unwrap_or_else(|| "unconnected".to_string());
    let account_label = connection
        .as_ref()
        .and_then(|connection| connection.account.email.clone())
        .or_else(|| {
            connection
                .as_ref()
                .map(|connection| connection.account.display_name.clone())
        })
        .unwrap_or_else(|| "unconnected account".to_string());
    record_pending_connector_action(
        &connector_approval_records_path(&app)
            .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?,
        &action,
        &account_id,
        &account_label,
    )
    .map_err(|message| command_error("unknown", &action.connector_id, &message, false))?;
    Ok(action)
}

#[tauri::command]
pub async fn execute_approved_connector_action(
    app: tauri::AppHandle,
    request: ConnectorActionExecutionRequest,
    workspace_id: Option<String>,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    require_connector_workspace(workspace_id)?;
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
        audit_connector_action(
            &action,
            "blocked",
            "denied",
            "Connector action denied by user.",
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

    if matches!(
        action.connector_id.as_str(),
        "google-drive" | "gmail" | "google-calendar"
    ) && !matches!(resolution.audit_entry.decision.as_str(), "once" | "modify")
    {
        return Err(command_error(
            "approval-required",
            &action.connector_id,
            "Google mutations require a fresh explicit approval for this exact action.",
            false,
        ));
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

    if matches!(
        action.connector_id.as_str(),
        "google-drive" | "gmail" | "google-calendar"
    ) {
        match crate::google::execute_action(&app, &action).await {
            Ok(result) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(&action, "ok", "", "Google connector action completed.");
                return Ok(result);
            }
            Err(provider_error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&provider_error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &provider_error.code,
                    "Google connector action failed.",
                );
                return Err(provider_error);
            }
        }
    }

    if matches!(action.connector_id.as_str(), "notion" | "slack") {
        match collaboration_connectors::execute(&app, &action).await {
            Ok(result) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(
                    &action,
                    "ok",
                    "",
                    "Collaboration connector action completed.",
                );
                return Ok(result);
            }
            Err(error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &error.code,
                    "Collaboration connector action failed.",
                );
                return Err(error);
            }
        }
    }

    if matches!(action.connector_id.as_str(), "github" | "vercel" | "linear") {
        match connector_api::execute_action(&app, &action).await {
            Ok(provider_resource_id) => {
                update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "completed",
                    &resolution.audit_entry.decided_at,
                    None,
                )
                .map_err(|message| {
                    command_error("unknown", &action.connector_id, &message, false)
                })?;
                audit_connector_action(&action, "ok", "", "Provider connector action completed.");
                return Ok(ConnectorActionResult {
                    request_id: action.id,
                    connector_id: action.connector_id,
                    action: action.action,
                    status: "completed".to_string(),
                    message: "The approved connector action completed.".to_string(),
                    provider_resource_id,
                });
            }
            Err(error) => {
                let _ = update_connector_action_result(
                    &records_path,
                    &action.approval.id,
                    "failed",
                    &resolution.audit_entry.decided_at,
                    Some(&error.code),
                );
                audit_connector_action(
                    &action,
                    "failed",
                    &error.code,
                    "Provider connector action failed.",
                );
                return Err(error);
            }
        }
    }

    let _ = update_connector_action_result(
        &records_path,
        &action.approval.id,
        "failed",
        &resolution.audit_entry.decided_at,
        Some("configuration-required"),
    );
    audit_connector_action(
        &action,
        "failed",
        "configuration-required",
        "Connector is not configured for this action.",
    );
    Err(configuration_required(&action.connector_id))
}

#[allow(dead_code)]
fn _empty_provider_metadata() -> BTreeMap<String, String> {
    BTreeMap::new()
}

#[cfg(test)]
mod workspace_scope_tests {
    use super::*;

    #[test]
    fn connector_commands_fail_closed_for_an_unconfigured_workspace() {
        let error = require_connector_workspace(Some("another-workspace".to_string())).unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }
}
