//! Transport-neutral semantic capability resolution over canonical Connections.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::models::{ConnectorCapabilityRequest, ConnectorCommandError, ConnectorSearchRequest};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeReadAdapter {
    Capability(&'static str),
    Search(NativeSearchAdapter),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeSearchAdapter {
    Google,
    GoogleCalendarEvents,
    GoogleCalendarList,
    Notion,
    SlackChannels,
}

struct NativeReadImplementation {
    capability_id: &'static str,
    connector_id: &'static str,
    adapter: NativeReadAdapter,
    required_scopes: &'static [&'static str],
}

impl NativeReadImplementation {
    fn adapter_reference(&self) -> String {
        let adapter = match self.adapter {
            NativeReadAdapter::Capability(capability) => capability,
            NativeReadAdapter::Search(NativeSearchAdapter::Google) => "google.search",
            NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarEvents) => {
                "google.calendar-events.search"
            }
            NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarList) => {
                "google.calendar-list.search"
            }
            NativeReadAdapter::Search(NativeSearchAdapter::Notion) => "notion.search",
            NativeReadAdapter::Search(NativeSearchAdapter::SlackChannels) => {
                "slack.channels.search"
            }
        };
        format!("native:{}:{adapter}", self.connector_id)
    }
}

const NATIVE_READ_IMPLEMENTATIONS: &[NativeReadImplementation] = &[
    NativeReadImplementation {
        capability_id: "source.repository.list",
        connector_id: "github",
        adapter: NativeReadAdapter::Capability("repositories.list"),
        required_scopes: &["repo"],
    },
    NativeReadImplementation {
        capability_id: "software.deployment.list",
        connector_id: "vercel",
        adapter: NativeReadAdapter::Capability("deployments.read"),
        required_scopes: &["deployment:read"],
    },
    NativeReadImplementation {
        capability_id: "work.issue.list",
        connector_id: "linear",
        adapter: NativeReadAdapter::Capability("issues.read"),
        required_scopes: &["read"],
    },
    NativeReadImplementation {
        capability_id: "source.file.search",
        connector_id: "google-drive",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::Google),
        required_scopes: &["https://www.googleapis.com/auth/drive.file"],
    },
    NativeReadImplementation {
        capability_id: "communication.channel.list",
        connector_id: "slack",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::SlackChannels),
        required_scopes: &["channels:read", "groups:read"],
    },
    NativeReadImplementation {
        capability_id: "knowledge.content.search",
        connector_id: "notion",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::Notion),
        required_scopes: &["read_content"],
    },
    NativeReadImplementation {
        capability_id: "communication.email.search",
        connector_id: "gmail",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::Google),
        required_scopes: &["https://www.googleapis.com/auth/gmail.readonly"],
    },
    NativeReadImplementation {
        capability_id: "calendar.list",
        connector_id: "google-calendar",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarList),
        required_scopes: &["https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
    },
    NativeReadImplementation {
        capability_id: "calendar.event.search",
        connector_id: "google-calendar",
        adapter: NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarEvents),
        required_scopes: &["https://www.googleapis.com/auth/calendar.events.readonly"],
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticCapabilityReadResult {
    pub capability_id: String,
    pub availability: String,
    pub connection_id: String,
    pub connector_id: String,
    pub implementation_evidence: String,
    pub matched_grant_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery_evidence:
        Option<crate::store::repos::capability_evidence::CapabilityImplementationEvidence>,
    pub result: serde_json::Value,
}

struct ResolvedNativeRead {
    implementation: &'static NativeReadImplementation,
    connection_id: String,
    connection_revision: i64,
    connection_display_name: String,
    availability: String,
    discovery_evidence:
        Option<crate::store::repos::capability_evidence::CapabilityImplementationEvidence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityGrantTarget {
    pub capability_id: String,
    pub connection_id: String,
    pub connection_revision: i64,
    pub connection_display_name: String,
    pub consequence: String,
    pub availability: String,
}

fn error(code: &str, capability_id: &str, message: &str, retryable: bool) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.into(),
        connector_id: capability_id.into(),
        message: message.into(),
        retryable,
        retry_after: None,
    }
}

fn implementation(capability_id: &str) -> Option<&'static NativeReadImplementation> {
    NATIVE_READ_IMPLEMENTATIONS
        .iter()
        .find(|implementation| implementation.capability_id == capability_id)
}

fn availability_for(
    implementation: &NativeReadImplementation,
    connection: &crate::connector_auth::ConnectorConnection,
    canonical: &crate::store::repos::connection_record::SafeConnectionRecord,
) -> Result<&'static str, ConnectorCommandError> {
    if connection.connector_id != implementation.connector_id
        || canonical.connector_definition_key != implementation.connector_id
    {
        return Err(error(
            "provider-boundary",
            implementation.capability_id,
            "Resolved Connection does not match the declared capability implementation.",
            false,
        ));
    }
    if canonical.lifecycle != "authorized" || canonical.authorization_state != "authorized" {
        return Err(error(
            "connection-not-authorized",
            implementation.capability_id,
            "The selected Connection is not authorized for this capability.",
            false,
        ));
    }
    if canonical.credential_state != "available" {
        return Err(error(
            "credential-unavailable",
            implementation.capability_id,
            "The selected Connection credential is unavailable.",
            false,
        ));
    }
    if implementation
        .required_scopes
        .iter()
        .any(|required| !connection.scopes.iter().any(|granted| granted == required))
    {
        return Err(error(
            "scope-denied",
            implementation.capability_id,
            "The selected Connection has not granted the scope required for this capability.",
            false,
        ));
    }
    match canonical.health_state.as_str() {
        "healthy" => Ok("available"),
        "unknown" | "degraded" => Ok("degraded"),
        "unhealthy" | "offline" => Err(error(
            "connection-unhealthy",
            implementation.capability_id,
            "The selected Connection is not healthy enough for this capability.",
            true,
        )),
        _ => Err(error(
            "implementation-unverified",
            implementation.capability_id,
            "Capability health evidence is unavailable.",
            true,
        )),
    }
}

pub(crate) fn persist_native_discovery_evidence(
    tx: &rusqlite::Connection,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connection: &crate::connector_auth::ConnectorConnection,
    canonical: &crate::store::repos::connection_record::SafeConnectionRecord,
    observed_at: &str,
) -> crate::store::Result<
    Vec<crate::store::repos::capability_evidence::CapabilityImplementationEvidence>,
> {
    if connection.connector_id != canonical.connector_definition_key {
        return Err(crate::store::StoreError::Invalid(
            "Connection discovery evidence crosses its provider boundary.".into(),
        ));
    }
    let observations = NATIVE_READ_IMPLEMENTATIONS
        .iter()
        .filter(|implementation| implementation.connector_id == connection.connector_id)
        .filter_map(|implementation| {
            availability_for(implementation, connection, canonical)
                .ok()
                .map(|availability| {
                    (
                        implementation.capability_id,
                        availability,
                        implementation.adapter_reference(),
                    )
                })
        })
        .collect::<Vec<_>>();
    let writes = observations
        .iter()
        .map(|(capability_key, availability, adapter_reference)| {
            crate::store::repos::capability_evidence::NativeCapabilityObservation {
                capability_key,
                availability,
                adapter_reference,
            }
        })
        .collect::<Vec<_>>();
    crate::store::repos::capability_evidence::replace_native_observations(
        tx,
        scope,
        &canonical.id,
        canonical.revision,
        observed_at,
        &writes,
    )
}

fn resolve_native_read(
    app: &tauri::AppHandle,
    capability_id: &str,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<ResolvedNativeRead, ConnectorCommandError> {
    let implementation = implementation(capability_id).ok_or_else(|| {
        error(
            "capability-unknown",
            capability_id,
            "Fable does not know this semantic capability.",
            false,
        )
    })?;
    let identity = crate::clerk_identity::native_identity_generation_snapshot()
        .map_err(|message| error("connection-not-authorized", capability_id, &message, false))?;
    // Validate the requested project boundary independently, then resolve the
    // Connection through workspace authority because Connections themselves
    // are never project-owned. The capability grant below retains the narrower
    // project scope.
    crate::authorized_scope::command_scope(
        Some(workspace_id.to_string()),
        project_id.map(str::to_string),
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map_err(|message| error("privacy-boundary", capability_id, &message, false))?;
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id.to_string()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map_err(|message| error("privacy-boundary", capability_id, &message, false))?;
    let path = crate::paths::connector_connections_path(app)
        .map_err(|message| error("no-eligible-connection", capability_id, &message, false))?;
    let connection = crate::connector_auth::usable_connection(&path, implementation.connector_id)
        .ok_or_else(|| {
        error(
            "no-eligible-connection",
            capability_id,
            "No authorized Connection can provide this capability.",
            false,
        )
    })?;
    let connection_id = crate::connector_auth::derive_native_connection_id(
        scope.data.workspace_id(),
        implementation.connector_id,
        &connection.account.id,
    );
    let store = crate::store::try_global().ok_or_else(|| {
        error(
            "implementation-unverified",
            capability_id,
            "Fable's encrypted Connection store is unavailable.",
            false,
        )
    })?;
    let canonical = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::get(tx, store, &scope, &connection_id)
        })
        .map_err(|store_error| {
            error(
                "implementation-unverified",
                capability_id,
                &store_error.to_string(),
                false,
            )
        })?
        .ok_or_else(|| {
            error(
                "no-eligible-connection",
                capability_id,
                "The selected Connection is unavailable.",
                false,
            )
        })?;
    let availability = availability_for(implementation, &connection, &canonical)?.to_string();
    let expected_adapter = implementation.adapter_reference();
    let discovery_evidence = store
        .with_conn(|tx| {
            crate::store::repos::capability_evidence::list_current_for_connection(
                tx,
                &scope,
                &connection_id,
            )
        })
        .map_err(|store_error| {
            error(
                "implementation-unverified",
                capability_id,
                &store_error.to_string(),
                false,
            )
        })?
        .into_iter()
        .find(|evidence| {
            evidence.capability_key == capability_id
                && evidence.adapter_reference == expected_adapter
                && evidence.availability == availability
        });
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)
        .map_err(|message| error("connection-not-authorized", capability_id, &message, false))?;
    Ok(ResolvedNativeRead {
        implementation,
        connection_id,
        connection_revision: canonical.revision,
        connection_display_name: canonical.display_name,
        availability,
        discovery_evidence,
    })
}

pub(crate) fn native_grant_target(
    app: &tauri::AppHandle,
    workspace_id: &str,
    project_id: Option<&str>,
    capability_id: &str,
) -> Result<CapabilityGrantTarget, ConnectorCommandError> {
    let resolved = resolve_native_read(app, capability_id, workspace_id, project_id)?;
    Ok(CapabilityGrantTarget {
        capability_id: capability_id.to_string(),
        connection_id: resolved.connection_id,
        connection_revision: resolved.connection_revision,
        connection_display_name: resolved.connection_display_name,
        consequence: "read".into(),
        availability: resolved.availability,
    })
}

pub(crate) async fn read(
    app: &tauri::AppHandle,
    workspace_id: String,
    project_id: Option<String>,
    capability_id: String,
    input: BTreeMap<String, serde_json::Value>,
    cursor: Option<String>,
) -> Result<SemanticCapabilityReadResult, ConnectorCommandError> {
    let resolved = resolve_native_read(app, &capability_id, &workspace_id, project_id.as_deref())?;
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        project_id,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| error("privacy-boundary", &capability_id, &message, false))?;
    let store = crate::store::try_global().ok_or_else(|| {
        error(
            "implementation-unverified",
            &capability_id,
            "Fable's encrypted capability-grant store is unavailable.",
            false,
        )
    })?;
    let grant_result = store
        .transaction(|tx| {
            crate::store::repos::capability_grant::authorize_and_consume(
                tx,
                store,
                &scope,
                &capability_id,
                &resolved.connection_id,
                "read",
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|store_error| {
            error(
                "implementation-unverified",
                &capability_id,
                &store_error.to_string(),
                false,
            )
        })?;
    let grants = grant_result
        .map_err(|failure| error(failure.code, &capability_id, failure.message, false))?;
    let matched_grant_ids = grants.into_iter().map(|grant| grant.id).collect();
    let connector_id = resolved.implementation.connector_id.to_string();
    let result = match resolved.implementation.adapter {
        NativeReadAdapter::Capability(adapter_capability) => {
            let request = ConnectorCapabilityRequest {
                connector_id: connector_id.clone(),
                capability: adapter_capability.into(),
                input,
                cursor,
            };
            let result = crate::connector_api::read_capability_for_connection(
                app,
                request,
                Some(&resolved.connection_id),
            )
            .await?;
            serde_json::to_value(result).map_err(|_| {
                error(
                    "implementation-unverified",
                    &capability_id,
                    "Fable could not encode the capability result.",
                    false,
                )
            })?
        }
        NativeReadAdapter::Search(search_adapter) => {
            let query = match input.get("query") {
                Some(value) => value.as_str().ok_or_else(|| {
                    error(
                        "invalid-request",
                        &capability_id,
                        "Capability search query must be text.",
                        false,
                    )
                })?,
                None => "",
            };
            let limit = match input.get("limit") {
                Some(value) => Some(
                    usize::try_from(value.as_u64().filter(|limit| *limit > 0).ok_or_else(
                        || {
                            error(
                                "invalid-request",
                                &capability_id,
                                "Capability search limit must be a positive whole number.",
                                false,
                            )
                        },
                    )?)
                    .map_err(|_| {
                        error(
                            "invalid-request",
                            &capability_id,
                            "Capability search limit is too large.",
                            false,
                        )
                    })?,
                ),
                None => None,
            };
            let request = ConnectorSearchRequest {
                connector_id: connector_id.clone(),
                query: query.into(),
                limit,
                cursor,
            };
            if matches!(
                search_adapter,
                NativeSearchAdapter::GoogleCalendarList | NativeSearchAdapter::SlackChannels
            ) && !request.query.trim().is_empty()
            {
                return Err(error(
                    "invalid-request",
                    &capability_id,
                    "This list capability does not accept a search query.",
                    false,
                ));
            }
            if search_adapter == NativeSearchAdapter::GoogleCalendarEvents
                && request.query.trim().is_empty()
            {
                return Err(error(
                    "invalid-request",
                    &capability_id,
                    "Calendar event search requires a query.",
                    false,
                ));
            }
            let result = match search_adapter {
                NativeSearchAdapter::Google
                | NativeSearchAdapter::GoogleCalendarEvents
                | NativeSearchAdapter::GoogleCalendarList => {
                    crate::google::search_for_connection(
                        app,
                        request,
                        Some(&resolved.connection_id),
                    )
                    .await?
                }
                NativeSearchAdapter::Notion | NativeSearchAdapter::SlackChannels => {
                    crate::collaboration_connectors::search_for_connection(
                        app,
                        request,
                        Some(&resolved.connection_id),
                    )
                    .await?
                }
            };
            serde_json::to_value(result).map_err(|_| {
                error(
                    "implementation-unverified",
                    &capability_id,
                    "Fable could not encode the capability result.",
                    false,
                )
            })?
        }
    };
    Ok(SemanticCapabilityReadResult {
        capability_id,
        availability: resolved.availability,
        connection_id: resolved.connection_id,
        connector_id,
        implementation_evidence: "adapter-validated".into(),
        matched_grant_ids,
        discovery_evidence: resolved.discovery_evidence,
        result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnectorAccountSummary;

    fn connection(scopes: &[&str]) -> crate::connector_auth::ConnectorConnection {
        crate::connector_auth::ConnectorConnection {
            connector_id: "github".into(),
            account: ConnectorAccountSummary {
                id: "provider-account".into(),
                display_name: "GitHub".into(),
                handle: None,
                email: None,
                workspace: None,
                avatar_url: None,
            },
            status: "connected".into(),
            scopes: scopes.iter().map(|scope| (*scope).into()).collect(),
            expires_at: None,
            credential_ref: "opaque-native-only".into(),
            connected_at: "1".into(),
            updated_at: "1".into(),
            is_active: true,
        }
    }

    fn canonical(health: &str) -> crate::store::repos::connection_record::SafeConnectionRecord {
        crate::store::repos::connection_record::SafeConnectionRecord {
            id: "connection_opaque".into(),
            workspace_id: "default".into(),
            display_name: "GitHub".into(),
            kind: "native-connector".into(),
            ownership: "workspace-shared".into(),
            lifecycle: "authorized".into(),
            authorization_state: "authorized".into(),
            health_state: health.into(),
            trust: "fable-reviewed".into(),
            credential_custody: "os-secure-store".into(),
            credential_state: "available".into(),
            connector_definition_key: "github".into(),
            enabled_by_default: true,
            revision: 1,
            created_by_internal_user_id: "user-a".into(),
            created_at: "1".into(),
            updated_at: "1".into(),
        }
    }

    #[test]
    fn registry_resolves_only_declared_scope_and_health_evidence() {
        let registered = implementation("source.repository.list").unwrap();
        assert_eq!(registered.connector_id, "github");
        assert_eq!(
            registered.adapter,
            NativeReadAdapter::Capability("repositories.list")
        );
        assert_eq!(
            implementation("software.deployment.list").unwrap().adapter,
            NativeReadAdapter::Capability("deployments.read")
        );
        assert_eq!(
            implementation("software.deployment.list")
                .unwrap()
                .required_scopes,
            &["deployment:read"]
        );
        assert_eq!(
            implementation("work.issue.list").unwrap().adapter,
            NativeReadAdapter::Capability("issues.read")
        );
        assert_eq!(
            implementation("work.issue.list").unwrap().required_scopes,
            &["read"]
        );
        assert_eq!(
            implementation("source.file.search").unwrap().adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::Google)
        );
        assert_eq!(
            implementation("source.file.search")
                .unwrap()
                .required_scopes,
            &["https://www.googleapis.com/auth/drive.file"]
        );
        assert_eq!(
            implementation("communication.channel.list")
                .unwrap()
                .adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::SlackChannels)
        );
        assert_eq!(
            implementation("communication.channel.list")
                .unwrap()
                .required_scopes,
            &["channels:read", "groups:read"]
        );
        assert_eq!(
            implementation("knowledge.content.search").unwrap().adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::Notion)
        );
        assert_eq!(
            implementation("knowledge.content.search")
                .unwrap()
                .required_scopes,
            &["read_content"]
        );
        assert_eq!(
            implementation("communication.email.search")
                .unwrap()
                .adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::Google)
        );
        assert_eq!(
            implementation("communication.email.search")
                .unwrap()
                .required_scopes,
            &["https://www.googleapis.com/auth/gmail.readonly"]
        );
        assert_eq!(
            implementation("calendar.list").unwrap().adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarList)
        );
        assert_eq!(
            implementation("calendar.list").unwrap().required_scopes,
            &["https://www.googleapis.com/auth/calendar.calendarlist.readonly"]
        );
        assert_eq!(
            implementation("calendar.event.search").unwrap().adapter,
            NativeReadAdapter::Search(NativeSearchAdapter::GoogleCalendarEvents)
        );
        assert_eq!(
            implementation("calendar.event.search")
                .unwrap()
                .required_scopes,
            &["https://www.googleapis.com/auth/calendar.events.readonly"]
        );
        let mut drive_connection = connection(&["https://www.googleapis.com/auth/drive.file"]);
        drive_connection.connector_id = "google-drive".into();
        let mut drive_canonical = canonical("healthy");
        drive_canonical.connector_definition_key = "google-drive".into();
        assert_eq!(
            availability_for(
                implementation("source.file.search").unwrap(),
                &drive_connection,
                &drive_canonical,
            )
            .unwrap(),
            "available"
        );
        let mut slack_connection = connection(&["channels:read", "groups:read"]);
        slack_connection.connector_id = "slack".into();
        let mut slack_canonical = canonical("healthy");
        slack_canonical.connector_definition_key = "slack".into();
        assert_eq!(
            availability_for(
                implementation("communication.channel.list").unwrap(),
                &slack_connection,
                &slack_canonical,
            )
            .unwrap(),
            "available"
        );
        let mut notion_connection = connection(&["read_content"]);
        notion_connection.connector_id = "notion".into();
        let mut notion_canonical = canonical("healthy");
        notion_canonical.connector_definition_key = "notion".into();
        assert_eq!(
            availability_for(
                implementation("knowledge.content.search").unwrap(),
                &notion_connection,
                &notion_canonical,
            )
            .unwrap(),
            "available"
        );
        let mut gmail_connection = connection(&["https://www.googleapis.com/auth/gmail.readonly"]);
        gmail_connection.connector_id = "gmail".into();
        let mut gmail_canonical = canonical("healthy");
        gmail_canonical.connector_definition_key = "gmail".into();
        assert_eq!(
            availability_for(
                implementation("communication.email.search").unwrap(),
                &gmail_connection,
                &gmail_canonical,
            )
            .unwrap(),
            "available"
        );
        let mut calendar_connection =
            connection(&["https://www.googleapis.com/auth/calendar.calendarlist.readonly"]);
        calendar_connection.connector_id = "google-calendar".into();
        let mut calendar_canonical = canonical("healthy");
        calendar_canonical.connector_definition_key = "google-calendar".into();
        assert_eq!(
            availability_for(
                implementation("calendar.list").unwrap(),
                &calendar_connection,
                &calendar_canonical,
            )
            .unwrap(),
            "available"
        );
        let mut event_connection =
            connection(&["https://www.googleapis.com/auth/calendar.events.readonly"]);
        event_connection.connector_id = "google-calendar".into();
        assert_eq!(
            availability_for(
                implementation("calendar.event.search").unwrap(),
                &event_connection,
                &calendar_canonical,
            )
            .unwrap(),
            "available"
        );
        assert_eq!(
            availability_for(
                implementation("software.deployment.list").unwrap(),
                &connection(&["deployment:read"]),
                &canonical("healthy"),
            )
            .unwrap_err()
            .code,
            "provider-boundary"
        );
        assert_eq!(
            availability_for(registered, &connection(&["repo"]), &canonical("healthy")).unwrap(),
            "available"
        );
        assert_eq!(
            availability_for(registered, &connection(&["repo"]), &canonical("unknown")).unwrap(),
            "degraded"
        );
        assert_eq!(
            availability_for(registered, &connection(&[]), &canonical("healthy"))
                .unwrap_err()
                .code,
            "scope-denied"
        );
        assert_eq!(
            availability_for(registered, &connection(&["repo"]), &canonical("offline"))
                .unwrap_err()
                .code,
            "connection-unhealthy"
        );
        assert!(implementation("unknown.capability").is_none());
    }
}
