//! Connector catalogue, scopes and health projections.

use super::*;

pub(crate) struct ConnectorCatalogEntry {
    id: &'static str,
    name: &'static str,
    auth_mode: &'static str,
    permissions: &'static [&'static str],
    scopes: &'static [(&'static str, &'static str, &'static str, bool)],
    setup_message: &'static str,
    actions: &'static [&'static str],
}

pub(crate) struct ConnectorActionPolicy {
    label: &'static str,
    mode: &'static str,
    risk_level: &'static str,
    consequence: &'static str,
    confirmation_phrase: Option<&'static str>,
}

pub(crate) const GITHUB_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("read:user", "Account identity", "read", true),
    ("read:org", "Organization membership", "read", true),
];
pub(crate) const GITHUB_DISALLOWED_SCOPES: &[&str] = &["repo", "public_repo", "delete_repo"];
pub(crate) const VERCEL_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("project:read", "Projects", "read", true),
    ("deployment:read", "Deployments", "read", true),
    (
        "deployment:write",
        "Approved deployment, project, and domain changes",
        "write",
        true,
    ),
];
pub(crate) const DRIVE_SCOPES: &[(&str, &str, &str, bool)] = &[
    (
        "https://www.googleapis.com/auth/drive",
        "Read and manage all Drive files",
        "write",
        false,
    ),
    (
        "https://www.googleapis.com/auth/drive.file",
        "Selected Drive files you create or change",
        "write",
        true,
    ),
    (
        "https://www.googleapis.com/auth/drive.readonly",
        "Search and read all Drive files",
        "read",
        false,
    ),
];
pub(crate) const NOTION_SCOPES: &[(&str, &str, &str, bool)] = &[];
pub(crate) const GMAIL_SCOPES: &[(&str, &str, &str, bool)] = &[
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
pub(crate) const SLACK_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("channels:read", "Channel list", "read", true),
    ("channels:history", "Selected channel history", "read", true),
    ("groups:read", "Private channel list", "read", false),
    (
        "groups:history",
        "Selected private channel history",
        "read",
        false,
    ),
    ("im:read", "Direct message list", "read", false),
    ("mpim:read", "Group direct message list", "read", false),
    ("users:read", "Workspace users", "read", true),
    (
        "chat:write",
        "Post, reply, edit, or delete after approval",
        "write",
        true,
    ),
    (
        "reactions:write",
        "Add or remove reactions after approval",
        "write",
        true,
    ),
];
pub(crate) const CALENDAR_SCOPES: &[(&str, &str, &str, bool)] = &[
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
pub(crate) const LINEAR_SCOPES: &[(&str, &str, &str, bool)] = &[
    ("read", "Workspace data", "read", true),
    (
        "write",
        "Create or change issues and comments after approval",
        "write",
        true,
    ),
];

pub(crate) const DRIVE_FILE_ACTION_SCOPES: &[&str] =
    &["https://www.googleapis.com/auth/drive.file"];
pub(crate) const GMAIL_COMPOSE_ACTION_SCOPES: &[&str] =
    &["https://www.googleapis.com/auth/gmail.compose"];
pub(crate) const GMAIL_SEND_ACTION_SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
];
pub(crate) const CALENDAR_WRITE_ACTION_SCOPES: &[&str] =
    &["https://www.googleapis.com/auth/calendar.events"];
pub(crate) const VERCEL_WRITE_ACTION_SCOPES: &[&str] = &["deployment:write"];
pub(crate) const LINEAR_WRITE_ACTION_SCOPES: &[&str] = &["write"];
pub(crate) const SLACK_CHAT_ACTION_SCOPES: &[&str] = &["chat:write"];
pub(crate) const SLACK_REACTION_ACTION_SCOPES: &[&str] = &["reactions:write"];

pub(crate) const CATALOG: &[ConnectorCatalogEntry] = &[
    ConnectorCatalogEntry {
        id: "github",
        name: "GitHub",
        auth_mode: "oauth-broker",
        permissions: &[
            "read authenticated account identity and organization membership",
            "read public repositories, issues, and pull requests; private repositories are not granted",
        ],
        scopes: GITHUB_SCOPES,
        setup_message: "Register a classic GitHub OAuth App (not a GitHub App) and configure the Mivlet auth broker. The broker requests read:user and read:org only. Classic repo is not requested. Public-repository REST may work; private-repository reads are not granted.",
        actions: &[],
    },
    ConnectorCatalogEntry {
        id: "vercel",
        name: "Vercel",
        auth_mode: "provider-installation",
        permissions: &[
            "read projects and deployments",
            "change deployments, projects, and domains only after approval",
        ],
        scopes: VERCEL_SCOPES,
        setup_message: "Create a Vercel integration with read and write access and configure its External Flow redirect. Mivlet requests deployment:write because native promote, rollback, create, cancel, project, and domain actions exist.",
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
        setup_message: "Enable the Drive API, create a desktop OAuth client, and set its client id and secret in Mivlet's local environment.",
        actions: &[
            "google-drive.create-file",
            "google-drive.upload-artifact",
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
        setup_message: "Create a Notion public integration and configure the Mivlet auth broker. Notion does not take OAuth scope query parameters; capabilities are set in the Notion console, and sharing is Notion's page-sharing model.",
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
            "Enable the Gmail API, create a desktop OAuth client, set its client id and secret in Mivlet's local environment, and complete required Google verification.",
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
        setup_message: "Create a Slack app with bot scopes for channel reads plus chat:write and reactions:write, and configure its HTTPS broker callback. Those write scopes match native post, reply, edit, delete, and reaction actions.",
        actions: &[
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
        setup_message: "Enable the Calendar API, create a desktop OAuth client, and set its client id and secret in Mivlet's local environment.",
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
        setup_message: "Create a Linear OAuth application with read and write and configure the Mivlet auth broker. write is requested because native issue create, issue update, and comment actions exist; create-only Linear scopes are not requested separately.",
        actions: &[
            "linear.create-issue",
            "linear.update-issue",
            "linear.comment",
        ],
    },
];

pub(crate) fn require_connector(
    connector_id: &str,
) -> Result<&'static ConnectorCatalogEntry, ConnectorCommandError> {
    let normalized = normalize_spaces(connector_id).to_ascii_lowercase();
    CATALOG
        .iter()
        .find(|entry| entry.id == normalized)
        .ok_or_else(|| command_error("invalid-request", &normalized, "Unknown connector.", false))
}

pub(crate) fn action_policy(action: &str) -> Option<ConnectorActionPolicy> {
    let policy = match action {
        "google-drive.upload-artifact" => ConnectorActionPolicy {
            label: "Upload Deliverable",
            mode: "full-access", risk_level: "high",
            consequence: "Creates a new file in the selected Google Drive folder using the exact approved deliverable bytes.",
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
            consequence: "Creates a calendar event after Mivlet approval.",
            confirmation_phrase: None,
        },
        "google-calendar.update-draft" => ConnectorActionPolicy {
            label: "Update Draft",
            mode: "trusted-scope",
            risk_level: "medium",
            consequence: "Updates the selected calendar event after Mivlet approval.",
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

pub(crate) fn external_policy(
    label: &'static str,
    consequence: &'static str,
) -> ConnectorActionPolicy {
    ConnectorActionPolicy {
        label,
        mode: "full-access",
        risk_level: "high",
        consequence,
        confirmation_phrase: Some("confirm external write"),
    }
}

pub(crate) fn linear_policy(label: &'static str) -> ConnectorActionPolicy {
    ConnectorActionPolicy {
        label,
        mode: "trusted-scope",
        risk_level: "medium",
        consequence: "Creates or changes the identified Linear issue after explicit approval.",
        confirmation_phrase: None,
    }
}

pub(crate) fn command_error(
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

pub(crate) fn configuration_required(connector_id: &str) -> ConnectorCommandError {
    command_error(
        "configuration-required",
        connector_id,
        &redact_connector_text(
            "Provider configuration and OS secure storage are required before live connector access.",
        ),
        false,
    )
}

pub(crate) fn connection_has_scope(connection: &ConnectorConnection, scope_id: &str) -> bool {
    let shorthand = format!("/{scope_id}");
    connection
        .scopes
        .iter()
        .any(|scope| scope == scope_id || scope.ends_with(&shorthand))
}

pub(crate) fn missing_required_scopes(
    entry: &'static ConnectorCatalogEntry,
    connection: &ConnectorConnection,
) -> bool {
    entry
        .scopes
        .iter()
        .any(|(id, _, _, required)| *required && !connection_has_scope(connection, id))
}

pub(crate) fn connection_has_disallowed_github_scope(connection: &ConnectorConnection) -> bool {
    connection.connector_id == "github"
        && connection
            .scopes
            .iter()
            .any(|scope| GITHUB_DISALLOWED_SCOPES.contains(&scope.as_str()))
}

pub(crate) fn action_required_scopes(action: &str) -> &'static [&'static str] {
    match action {
        "google-drive.create-file"
        | "google-drive.upload-artifact"
        | "google-drive.update-file"
        | "google-drive.move-file"
        | "google-drive.rename-file"
        | "google-drive.share-file"
        | "google-drive.delete-file" => DRIVE_FILE_ACTION_SCOPES,
        "gmail.create-draft" => GMAIL_COMPOSE_ACTION_SCOPES,
        "gmail.send" => GMAIL_SEND_ACTION_SCOPES,
        "google-calendar.create-draft"
        | "google-calendar.update-draft"
        | "google-calendar.cancel-event"
        | "google-calendar.delete-event" => CALENDAR_WRITE_ACTION_SCOPES,
        "vercel.promote"
        | "vercel.rollback"
        | "vercel.create-deployment"
        | "vercel.cancel-deployment"
        | "vercel.update-project"
        | "vercel.create-domain"
        | "vercel.update-domain"
        | "vercel.delete-domain" => VERCEL_WRITE_ACTION_SCOPES,
        "linear.create-issue" | "linear.update-issue" | "linear.comment" => {
            LINEAR_WRITE_ACTION_SCOPES
        }
        "slack.post" | "slack.reply" | "slack.edit" | "slack.delete" => SLACK_CHAT_ACTION_SCOPES,
        "slack.react-add" | "slack.react-remove" => SLACK_REACTION_ACTION_SCOPES,
        _ => &[],
    }
}

pub(crate) fn action_available(action: &str, connection: &ConnectorConnection) -> bool {
    let required = action_required_scopes(action);
    required.is_empty()
        || required
            .iter()
            .any(|scope| connection_has_scope(connection, scope))
}

pub(crate) fn build_manifest(
    entry: &'static ConnectorCatalogEntry,
    boundary: &dyn ConnectorCredentialBoundary,
) -> ConnectorManifest {
    build_manifest_with_health(entry, boundary, None)
}

pub(crate) fn build_manifest_with_health(
    entry: &'static ConnectorCatalogEntry,
    boundary: &dyn ConnectorCredentialBoundary,
    health: Option<ConnectorHealth>,
) -> ConnectorManifest {
    // A credential without an explicitly authorized projection scope is not a
    // usable connection. Do not infer or substitute a legacy workspace.
    let connection = boundary
        .workspace_id()
        .and_then(|_| boundary.connection(entry.id));
    let configuration_state = connector_configuration_state(entry);
    let configured = configuration_state == "configured";
    let health = health.or_else(|| {
        connection
            .as_ref()
            .and_then(|connection| boundary.health(entry.id, connection))
    });
    let status = connector_manifest_status(entry, connection.as_ref(), health.as_ref());
    let connected = status == "connected";
    let missing_required = connected
        && connection
            .as_ref()
            .is_some_and(|connection| missing_required_scopes(entry, connection));
    let overprivileged = connected
        && connection
            .as_ref()
            .is_some_and(connection_has_disallowed_github_scope);
    let connector_available = connected && !missing_required && !overprivileged;
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
        _ if overprivileged => {
            "Write-capable GitHub scopes are no longer requested; reconnect this provider."
                .to_string()
        }
        _ if missing_required => {
            "Missing required OAuth scopes; reconnect this provider.".to_string()
        }
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
                    && connection
                        .as_ref()
                        .is_some_and(|connection| connection_has_scope(connection, id)),
            })
            .collect(),
        health,
        account: connected
            .then(|| {
                connection.as_ref().and_then(|connection| {
                    boundary.workspace_id().map(|workspace_id| {
                        safe_account_projection(&connection.account, entry.id, workspace_id)
                    })
                })
            })
            .flatten(),
        setup_message: (!connected).then(|| {
            if configured {
                "Choose Connect to authorize this provider.".to_string()
            } else {
                entry.setup_message.to_string()
            }
        }),
        supports_search: connector_available,
        supports_import: connector_available,
        supported_actions: entry
            .actions
            .iter()
            .filter(|action| {
                connected
                    && connection
                        .as_ref()
                        .is_some_and(|connection| action_available(action, connection))
            })
            .map(|action| (*action).to_string())
            .collect(),
    }
}

pub(crate) fn selected_auth_scopes(
    entry: &'static ConnectorCatalogEntry,
    requested_scopes: Option<&[String]>,
) -> Result<Vec<String>, ConnectorCommandError> {
    let declared = entry
        .scopes
        .iter()
        .map(|scope| scope.0)
        .collect::<BTreeSet<_>>();
    let mut selected = Vec::new();
    let mut push_unique = |scope: &str| {
        let normalized = normalize_spaces(scope);
        if !selected.contains(&normalized) {
            selected.push(normalized);
        }
    };

    match requested_scopes {
        Some([]) => {
            if declared.is_empty() {
                return Ok(Vec::new());
            }
            return Err(command_error(
                "invalid-request",
                entry.id,
                "Requested OAuth scope set requires at least one scope.",
                false,
            ));
        }
        Some(scopes) => {
            if entry.auth_mode == "oauth-pkce" {
                for &(scope, _, _, required) in entry.scopes {
                    if required {
                        push_unique(scope);
                    }
                }
            }
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
                push_unique(&normalized);
            }
        }
        None => {
            for &(scope, _, _, required) in entry.scopes {
                if required {
                    push_unique(scope);
                }
            }
        }
    }

    Ok(selected)
}

pub(crate) fn connector_configuration_state(entry: &'static ConnectorCatalogEntry) -> &'static str {
    match entry.auth_mode {
        "oauth-pkce" => {
            if crate::connector_auth::google_oauth_client_id()
                .is_some_and(|value| !value.trim().is_empty())
            {
                "configured"
            } else {
                "unconfigured"
            }
        }
        "oauth-broker" | "provider-installation" => {
            let broker_url = crate::connector_auth::auth_broker_url();
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

pub(crate) fn connector_manifest_status(
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
pub(crate) async fn probe_connector_health(
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

pub(crate) fn canonical_health_state(state: &str) -> &'static str {
    match state {
        "healthy" => "healthy",
        "degraded" => "degraded",
        "error" => "unhealthy",
        _ => "unknown",
    }
}

pub(crate) fn persist_connector_health_state(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    provider_account_id: &str,
    health: &ConnectorHealth,
) -> crate::store::Result<()> {
    store.transaction(|tx| {
        let id = crate::connector_auth::derive_native_connection_id(
            scope.data.workspace_id(),
            connector_id,
            provider_account_id,
        );
        let existing = crate::store::repos::connection_record::get(tx, store, scope, &id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Connection is unavailable.".into())
            })?;
        crate::store::repos::connection_record::transition_native_connector(
            tx,
            store,
            scope,
            &id,
            existing.revision,
            &existing.lifecycle,
            &existing.authorization_state,
            canonical_health_state(&health.state),
            &existing.credential_state,
            &health.checked_at,
        )?;
        Ok(())
    })
}

pub(crate) fn list_connector_statuses_with(
    boundary: &dyn ConnectorCredentialBoundary,
) -> Vec<ConnectorManifest> {
    debug_assert_eq!(
        CATALOG.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        SUPPORTED_CONNECTOR_IDS
    );
    CATALOG
        .iter()
        .map(|entry| build_manifest(entry, boundary))
        .collect()
}

pub(crate) fn list_unconfigured_workspace_connector_statuses() -> Vec<ConnectorManifest> {
    let mut manifests = list_connector_statuses_with(&UnavailableCredentialBoundary);
    for manifest in &mut manifests {
        let message =
            "Connector credentials are not configured for this Mivlet workspace.".to_string();
        manifest.status = "unconfigured".to_string();
        manifest.health.state = "unknown".to_string();
        manifest.health.summary = message.clone();
        manifest.health.checked_at = "Not checked".to_string();
        manifest.health.retry_after = None;
        manifest.health_summary = message.clone();
        manifest.setup_message = Some(message);
        manifest.account = None;
        manifest.supports_search = false;
        manifest.supports_import = false;
        manifest.supported_actions.clear();
        for scope in &mut manifest.scopes {
            scope.granted = false;
        }
    }
    manifests
}
