//! Transport-neutral semantic capability resolution over canonical Connections.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::models::{ConnectorCapabilityRequest, ConnectorCommandError, ConnectorSearchRequest};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeReadAdapter {
    Capability(&'static str),
    Search,
}

struct NativeReadImplementation {
    capability_id: &'static str,
    connector_id: &'static str,
    adapter: NativeReadAdapter,
    required_scopes: &'static [&'static str],
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
        adapter: NativeReadAdapter::Search,
        required_scopes: &["https://www.googleapis.com/auth/drive.file"],
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
    pub result: serde_json::Value,
}

struct ResolvedNativeRead {
    implementation: &'static NativeReadImplementation,
    connection_id: String,
    availability: String,
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

fn resolve_native_read(
    app: &tauri::AppHandle,
    capability_id: &str,
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
    let scope = crate::authorized_scope::command_scope(
        Some(crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
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
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)
        .map_err(|message| error("connection-not-authorized", capability_id, &message, false))?;
    Ok(ResolvedNativeRead {
        implementation,
        connection_id,
        availability,
    })
}

pub(crate) async fn read(
    app: &tauri::AppHandle,
    capability_id: String,
    input: BTreeMap<String, serde_json::Value>,
    cursor: Option<String>,
) -> Result<SemanticCapabilityReadResult, ConnectorCommandError> {
    let resolved = resolve_native_read(app, &capability_id)?;
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
        NativeReadAdapter::Search => {
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
            let result =
                crate::google::search_for_connection(app, request, Some(&resolved.connection_id))
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
    };
    Ok(SemanticCapabilityReadResult {
        capability_id,
        availability: resolved.availability,
        connection_id: resolved.connection_id,
        connector_id,
        implementation_evidence: "adapter-validated".into(),
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
            NativeReadAdapter::Search
        );
        assert_eq!(
            implementation("source.file.search")
                .unwrap()
                .required_scopes,
            &["https://www.googleapis.com/auth/drive.file"]
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
