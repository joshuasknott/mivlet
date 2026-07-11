//! Authenticated canonical Connection records.
//!
//! Provider account ids are transient derivation input only. Durable identity is
//! the opaque workspace-bound Fable Connection id, human-facing metadata stays
//! encrypted, and safe projections never return the secure-store reference.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::authorized_scope::{AuthorizedCommandScope, ScopeAccess};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

const DISPLAY_NAME_MAX: usize = 200;
const EXTERNAL_ACCOUNT_ID_MAX: usize = 512;
const CREDENTIAL_REF_MAX: usize = 256;

#[derive(Clone, Debug)]
pub struct NativeConnectorConnectionWrite<'a> {
    pub connector_definition_key: &'a str,
    pub external_account_id: &'a str,
    pub display_name: &'a str,
    pub lifecycle: &'a str,
    pub authorization_state: &'a str,
    pub health_state: &'a str,
    pub credential_state: &'a str,
    pub expected_revision: Option<i64>,
    pub updated_at: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeConnectionRecord {
    pub id: String,
    pub workspace_id: String,
    pub display_name: String,
    pub kind: String,
    pub ownership: String,
    pub lifecycle: String,
    pub authorization_state: String,
    pub health_state: String,
    pub trust: String,
    pub credential_custody: String,
    pub credential_state: String,
    pub connector_definition_key: String,
    pub enabled_by_default: bool,
    pub revision: i64,
    pub created_by_internal_user_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionContent {
    display_name: String,
    transport: ConnectionTransport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ConnectionTransport {
    NativeConnector {
        connector_definition_key: String,
        external_principal: ExternalPrincipal,
    },
    Mcp {
        transport: String,
        local_launch_reference: String,
        discovery_state: String,
        #[serde(default)]
        discovered_at: Option<String>,
        #[serde(default)]
        discovered_tools: Vec<String>,
        #[serde(default)]
        discovered_resources: Vec<String>,
        #[serde(default)]
        enabled_tools: Vec<String>,
        #[serde(default)]
        enabled_resources: Vec<String>,
        #[serde(default)]
        capability_bindings: Vec<McpCapabilityBinding>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpCapabilityBinding {
    capability_id: String,
    tool_name: String,
    contract_version: String,
    consequence: String,
    trust: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilityBindingWrite {
    pub capability_id: String,
    pub tool_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeMcpCapabilityBinding {
    pub capability_id: String,
    pub tool_name: String,
    pub contract_version: String,
    pub consequence: String,
    pub trust: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeMcpConnectionDetails {
    pub connection_id: String,
    pub connection_revision: i64,
    pub transport: String,
    pub launch_reference: String,
    pub discovery_state: String,
    pub discovered_at: Option<String>,
    pub discovered_tools: Vec<String>,
    pub discovered_resources: Vec<String>,
    pub enabled_tools: Vec<String>,
    pub enabled_resources: Vec<String>,
    pub capability_bindings: Vec<SafeMcpCapabilityBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPrincipal {
    provider: String,
    opaque_subject_reference: String,
}

struct Partial {
    id: String,
    workspace_id: String,
    kind: String,
    ownership: String,
    lifecycle: String,
    authorization_state: String,
    health_state: String,
    trust: String,
    credential_custody: String,
    credential_state: String,
    connector_definition_key: Option<String>,
    enabled_by_default: bool,
    revision: i64,
    created_by_internal_user_id: String,
    created_at: String,
    updated_at: String,
    sealed: crate::store::vault::Sealed,
}

pub fn upsert_native_connector(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    input: NativeConnectorConnectionWrite<'_>,
) -> Result<SafeConnectionRecord> {
    if scope.data.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Connections are workspace-scoped and cannot use project authority.".into(),
        ));
    }
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    let connector = crate::store::repos::scope::normalize_id(
        input.connector_definition_key,
        "Connector definition",
    )?;
    let external_account_id = bounded(
        input.external_account_id,
        "External account",
        EXTERNAL_ACCOUNT_ID_MAX,
    )?;
    let display_name = bounded(input.display_name, "Connection name", DISPLAY_NAME_MAX)?;
    let credential_ref =
        crate::connector_auth::native_connector_credential_ref(&connector, &external_account_id);
    if credential_ref.is_empty()
        || credential_ref.len() > CREDENTIAL_REF_MAX
        || !credential_ref.starts_with("oauth-token:")
        || credential_ref.chars().any(char::is_control)
    {
        return Err(StoreError::Invalid(
            "Connection credential reference is not a valid secure-store binding.".into(),
        ));
    }
    validate_state(input.lifecycle, LIFECYCLES, "lifecycle")?;
    validate_state(
        input.authorization_state,
        AUTHORIZATION_STATES,
        "authorization state",
    )?;
    validate_state(input.health_state, HEALTH_STATES, "health state")?;
    validate_state(
        input.credential_state,
        CREDENTIAL_STATES,
        "credential state",
    )?;

    let id = crate::connector_auth::derive_native_connection_id(
        scope.data.workspace_id(),
        &connector,
        &external_account_id,
    );
    let existing = tx
        .query_row(
            "SELECT revision,authority,kind,connector_definition_key,credential_ref
             FROM connection_record WHERE workspace_id=?1 AND id=?2;",
            rusqlite::params![scope.data.workspace_id(), id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    match (&existing, input.expected_revision) {
        (None, None) => {}
        (None, Some(_)) => {
            return Err(StoreError::Invalid(
                "Connection no longer exists at the expected revision.".into(),
            ))
        }
        (Some((revision, authority, kind, definition, stored_ref)), Some(expected))
            if *revision == expected
                && authority == "local"
                && kind == "native-connector"
                && definition.as_deref() == Some(connector.as_str())
                && stored_ref == &credential_ref => {}
        (Some(_), None) => {
            return Err(StoreError::Invalid(
                "Connection already exists; its expected revision is required.".into(),
            ))
        }
        _ => {
            return Err(StoreError::Invalid(
                "Connection changed or conflicts with existing authority.".into(),
            ))
        }
    }
    let binding_owned_elsewhere: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM connection_record WHERE credential_ref=?1 AND (workspace_id<>?2 OR id<>?3));",
        rusqlite::params![credential_ref, scope.data.workspace_id(), id],
        |row| row.get(0),
    )?;
    if binding_owned_elsewhere {
        return Err(StoreError::Invalid(
            "Connection secure-store binding is already assigned elsewhere.".into(),
        ));
    }

    let content = ConnectionContent {
        display_name,
        transport: ConnectionTransport::NativeConnector {
            connector_definition_key: connector.clone(),
            external_principal: ExternalPrincipal {
                provider: connector.clone(),
                opaque_subject_reference: format!(
                    "external_{}",
                    external_principal_digest(
                        scope.data.workspace_id(),
                        &connector,
                        &external_account_id,
                    )
                ),
            },
        },
    };
    if existing.is_some() {
        let current = get(tx, store, scope, &id)?.ok_or_else(|| {
            StoreError::Invalid("Connection disappeared before it was saved.".into())
        })?;
        if current.display_name == content.display_name
            && current.lifecycle == input.lifecycle
            && current.authorization_state == input.authorization_state
            && current.health_state == input.health_state
            && current.credential_state == input.credential_state
        {
            return Ok(current);
        }
    }
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("Connection content is invalid.".into()))?,
        &aad(scope.data.workspace_id(), &id),
    )?;
    if let Some((revision, ..)) = existing {
        let changed = tx.execute(
            "UPDATE connection_record SET revision=revision+1,lifecycle=?1,authorization_state=?2,
               health_state=?3,credential_state=?4,updated_at=?5,payload=?6,payload_nonce=?7
             WHERE workspace_id=?8 AND id=?9 AND revision=?10;",
            rusqlite::params![
                input.lifecycle,
                input.authorization_state,
                input.health_state,
                input.credential_state,
                input.updated_at,
                sealed.ciphertext,
                sealed.nonce,
                scope.data.workspace_id(),
                id,
                revision,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Invalid(
                "Connection changed before it was saved.".into(),
            ));
        }
    } else {
        tx.execute(
            "INSERT INTO connection_record(
               workspace_id,id,record_type,authority,visibility,owner_member_id,schema_version,
               revision,created_by_internal_user_id,created_by_device_id,kind,ownership,lifecycle,
               authorization_state,health_state,trust,credential_custody,credential_state,
               credential_ref,connector_definition_key,enabled_by_default,created_at,updated_at,
               deleted_at,payload,payload_nonce)
             VALUES(?1,?2,'connection','local','workspace-shared',NULL,1,1,?3,NULL,
               'native-connector','workspace-shared',?4,?5,?6,'fable-reviewed','os-secure-store',
               ?7,?8,?9,1,?10,?10,NULL,?11,?12);",
            rusqlite::params![
                scope.data.workspace_id(),
                id,
                scope.internal_user_id,
                input.lifecycle,
                input.authorization_state,
                input.health_state,
                input.credential_state,
                credential_ref,
                connector,
                input.updated_at,
                sealed.ciphertext,
                sealed.nonce,
            ],
        )?;
    }
    get(tx, store, scope, &id)?.ok_or_else(|| {
        StoreError::Invalid("Connection could not be read after it was saved.".into())
    })
}

pub fn upsert_mcp_stdio(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    launch_reference: &str,
    display_name: &str,
    updated_at: &str,
) -> Result<SafeConnectionRecord> {
    upsert_mcp_server(
        tx,
        store,
        scope,
        launch_reference,
        display_name,
        "stdio",
        updated_at,
    )
}

pub fn upsert_mcp_streamable_http(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    configuration_reference: &str,
    display_name: &str,
    updated_at: &str,
) -> Result<SafeConnectionRecord> {
    upsert_mcp_server(
        tx,
        store,
        scope,
        configuration_reference,
        display_name,
        "streamable-http",
        updated_at,
    )
}

fn upsert_mcp_server(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    launch_reference: &str,
    display_name: &str,
    transport: &str,
    updated_at: &str,
) -> Result<SafeConnectionRecord> {
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    let owner_member_id = scope.private.owner_member_id().ok_or_else(|| {
        StoreError::Invalid("A workspace membership is required for an MCP Connection.".into())
    })?;
    let launch_reference =
        crate::store::repos::scope::normalize_id(launch_reference, "MCP launch reference")?;
    let display_name = bounded(display_name, "Connection name", DISPLAY_NAME_MAX)?;
    let id = derive_mcp_connection_id(
        scope.data.workspace_id(),
        scope.private.owner_subject(),
        &launch_reference,
        transport,
    );
    let existing = tx
        .query_row(
            "SELECT revision,authority,kind,owner_member_id,created_by_internal_user_id
             FROM connection_record WHERE workspace_id=?1 AND id=?2;",
            rusqlite::params![scope.data.workspace_id(), id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    if let Some((_, authority, kind, owner, creator)) = &existing {
        if authority != "local"
            || kind != "mcp"
            || owner.as_deref() != Some(owner_member_id)
            || creator != &scope.internal_user_id
        {
            return Err(StoreError::Invalid(
                "MCP Connection conflicts with existing authority.".into(),
            ));
        }
    }
    let content = ConnectionContent {
        display_name,
        transport: ConnectionTransport::Mcp {
            transport: transport.into(),
            local_launch_reference: launch_reference,
            discovery_state: "not-started".into(),
            discovered_at: None,
            discovered_tools: Vec::new(),
            discovered_resources: Vec::new(),
            enabled_tools: Vec::new(),
            enabled_resources: Vec::new(),
            capability_bindings: Vec::new(),
        },
    };
    if existing.is_some() {
        let current = get(tx, store, scope, &id)?
            .ok_or_else(|| StoreError::Invalid("MCP Connection disappeared before save.".into()))?;
        if current.display_name == content.display_name {
            return Ok(current);
        }
    }
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("MCP Connection content is invalid.".into()))?,
        &aad(scope.data.workspace_id(), &id),
    )?;
    if let Some((revision, ..)) = existing {
        let changed = tx.execute(
            "UPDATE connection_record SET revision=revision+1,lifecycle='authorized',
               health_state='unknown',updated_at=?1,
               payload=?2,payload_nonce=?3
             WHERE workspace_id=?4 AND id=?5 AND revision=?6 AND kind='mcp'
               AND authority='local' AND owner_member_id=?7 AND deleted_at IS NULL;",
            rusqlite::params![
                updated_at,
                sealed.ciphertext,
                sealed.nonce,
                scope.data.workspace_id(),
                id,
                revision,
                owner_member_id
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Invalid(
                "MCP Connection changed before it was saved.".into(),
            ));
        }
    } else {
        tx.execute(
            "INSERT INTO connection_record(
               workspace_id,id,record_type,authority,visibility,owner_member_id,schema_version,
               revision,created_by_internal_user_id,created_by_device_id,kind,ownership,lifecycle,
               authorization_state,health_state,trust,credential_custody,credential_state,
               credential_ref,connector_definition_key,enabled_by_default,created_at,updated_at,
               deleted_at,payload,payload_nonce)
             VALUES(?1,?2,'connection','local','member-private',?3,1,1,?4,NULL,
               'mcp','user-owned','authorized','not-required','unknown','user-managed','none',
               'not-required','',NULL,0,?5,?5,NULL,?6,?7);",
            rusqlite::params![
                scope.data.workspace_id(),
                id,
                owner_member_id,
                scope.internal_user_id,
                updated_at,
                sealed.ciphertext,
                sealed.nonce
            ],
        )?;
    }
    get(tx, store, scope, &id)?
        .ok_or_else(|| StoreError::Invalid("MCP Connection could not be read after save.".into()))
}

pub fn authorize_mcp_oauth(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
    expected_revision: i64,
    credential_ref: &str,
    updated_at: &str,
) -> Result<SafeConnectionRecord> {
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    if credential_ref.is_empty()
        || credential_ref.len() > CREDENTIAL_REF_MAX
        || !credential_ref.starts_with("mcp-oauth-")
        || credential_ref.chars().any(char::is_control)
    {
        return Err(StoreError::Invalid(
            "MCP OAuth credential binding is invalid.".into(),
        ));
    }
    let current = get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("MCP Connection is unavailable.".into()))?;
    if current.kind != "mcp" || current.revision != expected_revision {
        return Err(StoreError::Invalid(
            "MCP Connection changed before authorization completed.".into(),
        ));
    }
    let binding_owned_elsewhere: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM connection_record WHERE credential_ref=?1 AND (workspace_id<>?2 OR id<>?3));",
        rusqlite::params![credential_ref, scope.data.workspace_id(), id],
        |row| row.get(0),
    )?;
    if binding_owned_elsewhere {
        return Err(StoreError::Invalid(
            "MCP OAuth credential binding is already assigned elsewhere.".into(),
        ));
    }
    let changed = tx.execute(
        "UPDATE connection_record SET revision=revision+1,lifecycle='authorized',
           authorization_state='authorized',health_state='unknown',
           credential_custody='os-secure-store',credential_state='available',credential_ref=?1,
           updated_at=?2
         WHERE workspace_id=?3 AND id=?4 AND revision=?5 AND kind='mcp'
           AND authority='local' AND deleted_at IS NULL;",
        rusqlite::params![
            credential_ref,
            updated_at,
            scope.data.workspace_id(),
            id,
            expected_revision,
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "MCP Connection changed before authorization was saved.".into(),
        ));
    }
    get(tx, store, scope, id)?.ok_or_else(|| {
        StoreError::Invalid("MCP Connection could not be read after authorization.".into())
    })
}

pub(crate) fn mcp_oauth_credential_binding(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
) -> Result<Option<String>> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let current = get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("MCP Connection is unavailable.".into()))?;
    let credential_ref: String = tx.query_row(
        "SELECT credential_ref FROM connection_record
         WHERE workspace_id=?1 AND id=?2 AND kind='mcp' AND deleted_at IS NULL;",
        rusqlite::params![scope.data.workspace_id(), id],
        |row| row.get(0),
    )?;
    if current.authorization_state == "not-required"
        && current.credential_state == "not-required"
        && current.credential_custody == "none"
        && credential_ref.is_empty()
    {
        return Ok(None);
    }
    if current.authorization_state != "authorized"
        || current.credential_state != "available"
        || current.credential_custody != "os-secure-store"
        || credential_ref.is_empty()
        || credential_ref.len() > CREDENTIAL_REF_MAX
        || !credential_ref.starts_with("mcp-oauth-")
        || credential_ref.chars().any(char::is_control)
    {
        return Err(StoreError::Invalid(
            "MCP Connection credential metadata is inconsistent.".into(),
        ));
    }
    Ok(Some(credential_ref))
}

pub(crate) fn mcp_details_for_launch(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    launch_reference: &str,
) -> Result<SafeMcpConnectionDetails> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let launch_reference =
        crate::store::repos::scope::normalize_id(launch_reference, "MCP launch reference")?;
    let id = derive_mcp_connection_id(
        scope.data.workspace_id(),
        scope.private.owner_subject(),
        &launch_reference,
        "stdio",
    );
    let row = tx
        .query_row(
            &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
            rusqlite::params![scope.data.workspace_id(), id],
            read_partial,
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("MCP Connection is unavailable.".into()))?;
    let details = mcp_projection(store, &row)?;
    if details.transport != "stdio" {
        return Err(StoreError::Invalid(
            "Local MCP Connection is unavailable.".into(),
        ));
    }
    Ok(details)
}

pub(crate) fn mcp_details_for_remote(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    configuration_reference: &str,
) -> Result<SafeMcpConnectionDetails> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let reference = crate::store::repos::scope::normalize_id(
        configuration_reference,
        "MCP configuration reference",
    )?;
    let id = derive_mcp_connection_id(
        scope.data.workspace_id(),
        scope.private.owner_subject(),
        &reference,
        "streamable-http",
    );
    let row = tx
        .query_row(
            &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
            rusqlite::params![scope.data.workspace_id(), id],
            read_partial,
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("Remote MCP Connection is unavailable.".into()))?;
    let details = mcp_projection(store, &row)?;
    if details.transport != "streamable-http" {
        return Err(StoreError::Invalid(
            "Remote MCP Connection is unavailable.".into(),
        ));
    }
    Ok(details)
}

pub(crate) fn record_mcp_discovery(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
    expected_revision: i64,
    tools: Vec<String>,
    resources: Vec<String>,
    observed_at: &str,
) -> Result<SafeMcpConnectionDetails> {
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    let row = tx
        .query_row(
            &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
            rusqlite::params![scope.data.workspace_id(), connection_id],
            read_partial,
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("MCP Connection is unavailable.".into()))?;
    if row.kind != "mcp" || row.revision != expected_revision {
        return Err(StoreError::Invalid(
            "MCP Connection changed during discovery.".into(),
        ));
    }
    let tools = normalized_discovery_values(tools, "tool", 256, 256)?;
    let resources = normalized_discovery_values(resources, "resource", 256, 2_048)?;
    let mut content = open_content(store, &row)?;
    let ConnectionTransport::Mcp {
        discovery_state,
        discovered_at,
        discovered_tools,
        discovered_resources,
        enabled_tools,
        enabled_resources,
        capability_bindings,
        ..
    } = &mut content.transport
    else {
        return Err(StoreError::Invalid(
            "Connection content conflicts with its MCP identity.".into(),
        ));
    };
    *discovery_state = "discovered".into();
    *discovered_at = Some(observed_at.to_string());
    *discovered_tools = tools;
    *discovered_resources = resources;
    enabled_tools.retain(|name| discovered_tools.binary_search(name).is_ok());
    enabled_resources.retain(|uri| discovered_resources.binary_search(uri).is_ok());
    capability_bindings.retain(|binding| {
        discovered_tools.binary_search(&binding.tool_name).is_ok()
            && enabled_tools.binary_search(&binding.tool_name).is_ok()
    });
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("MCP discovery is invalid.".into()))?,
        &aad(scope.data.workspace_id(), connection_id),
    )?;
    let changed = tx.execute(
        "UPDATE connection_record SET revision=revision+1,health_state='healthy',updated_at=?1,
           payload=?2,payload_nonce=?3
         WHERE workspace_id=?4 AND id=?5 AND revision=?6 AND kind='mcp'
           AND authority='local' AND deleted_at IS NULL;",
        rusqlite::params![
            observed_at,
            sealed.ciphertext,
            sealed.nonce,
            scope.data.workspace_id(),
            connection_id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "MCP Connection changed before discovery was saved.".into(),
        ));
    }
    mcp_details_for_id(tx, store, scope, connection_id)
}

pub(crate) fn set_mcp_enablement(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
    expected_revision: i64,
    enabled_tools: Vec<String>,
    enabled_resources: Vec<String>,
    capability_bindings: Vec<McpCapabilityBindingWrite>,
    updated_at: &str,
) -> Result<SafeMcpConnectionDetails> {
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    let row = tx
        .query_row(
            &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
            rusqlite::params![scope.data.workspace_id(), connection_id],
            read_partial,
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("MCP Connection is unavailable.".into()))?;
    if row.kind != "mcp" || row.revision != expected_revision {
        return Err(StoreError::Invalid(
            "MCP Connection changed before access was saved.".into(),
        ));
    }
    let mut content = open_content(store, &row)?;
    let ConnectionTransport::Mcp {
        discovery_state,
        discovered_tools,
        discovered_resources,
        enabled_tools: stored_tools,
        enabled_resources: stored_resources,
        capability_bindings: stored_bindings,
        ..
    } = &mut content.transport
    else {
        return Err(StoreError::Invalid(
            "Connection content conflicts with its MCP identity.".into(),
        ));
    };
    if discovery_state != "discovered" {
        return Err(StoreError::Invalid(
            "MCP access cannot be enabled before discovery.".into(),
        ));
    }
    let enabled_tools = normalized_discovery_values(enabled_tools, "tool", 256, 256)?;
    let enabled_resources = normalized_discovery_values(enabled_resources, "resource", 256, 2_048)?;
    if enabled_tools
        .iter()
        .any(|name| discovered_tools.binary_search(name).is_err())
        || enabled_resources
            .iter()
            .any(|uri| discovered_resources.binary_search(uri).is_err())
    {
        return Err(StoreError::Invalid(
            "MCP access includes an item that was not discovered on this Connection.".into(),
        ));
    }
    *stored_tools = enabled_tools;
    *stored_resources = enabled_resources;
    *stored_bindings = normalize_mcp_capability_bindings(capability_bindings, stored_tools)?;
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("MCP enablement is invalid.".into()))?,
        &aad(scope.data.workspace_id(), connection_id),
    )?;
    let changed = tx.execute(
        "UPDATE connection_record SET revision=revision+1,updated_at=?1,payload=?2,payload_nonce=?3
         WHERE workspace_id=?4 AND id=?5 AND revision=?6 AND kind='mcp'
           AND authority='local' AND deleted_at IS NULL;",
        rusqlite::params![
            updated_at,
            sealed.ciphertext,
            sealed.nonce,
            scope.data.workspace_id(),
            connection_id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "MCP Connection changed before access was saved.".into(),
        ));
    }
    mcp_details_for_id(tx, store, scope, connection_id)
}

pub(crate) fn require_enabled_mcp_tool(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
    expected_revision: i64,
    tool_name: &str,
) -> Result<()> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let details = mcp_details_for_id(tx, store, scope, connection_id)?;
    if details.connection_revision != expected_revision
        || details.discovery_state != "discovered"
        || details
            .enabled_tools
            .binary_search_by(|candidate| candidate.as_str().cmp(tool_name))
            .is_err()
    {
        return Err(StoreError::Invalid(
            "This MCP tool is not enabled on the current Connection revision.".into(),
        ));
    }
    Ok(())
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
) -> Result<Option<SafeConnectionRecord>> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let partial = tx
        .query_row(
            &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
            rusqlite::params![scope.data.workspace_id(), id],
            read_partial,
        )
        .optional()?;
    partial.map(|row| open_safe(store, row)).transpose()
}

pub(crate) fn native_credential_binding(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
) -> Result<String> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let record = get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("Connection is unavailable.".into()))?;
    if record.kind != "native-connector" || record.connector_definition_key.is_empty() {
        return Err(StoreError::Invalid(
            "Connection has no native credential binding.".into(),
        ));
    }
    let credential_ref: String = tx.query_row(
        "SELECT credential_ref FROM connection_record
         WHERE workspace_id=?1 AND id=?2 AND kind='native-connector' AND deleted_at IS NULL;",
        rusqlite::params![scope.data.workspace_id(), id],
        |row| row.get(0),
    )?;
    if credential_ref.is_empty()
        || credential_ref.len() > CREDENTIAL_REF_MAX
        || !credential_ref.starts_with("oauth-token:")
        || credential_ref.chars().any(char::is_control)
    {
        return Err(StoreError::Invalid(
            "Connection credential binding is invalid.".into(),
        ));
    }
    Ok(credential_ref)
}

pub fn transition_native_connector(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
    expected_revision: i64,
    lifecycle: &str,
    authorization_state: &str,
    health_state: &str,
    credential_state: &str,
    updated_at: &str,
) -> Result<SafeConnectionRecord> {
    require_current_scope(tx, scope, ScopeAccess::Write)?;
    validate_state(lifecycle, LIFECYCLES, "lifecycle")?;
    validate_state(
        authorization_state,
        AUTHORIZATION_STATES,
        "authorization state",
    )?;
    validate_state(health_state, HEALTH_STATES, "health state")?;
    validate_state(credential_state, CREDENTIAL_STATES, "credential state")?;
    let current = get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("Connection is unavailable.".into()))?;
    if current.kind != "native-connector"
        || current.revision != expected_revision
        || current.connector_definition_key.is_empty()
    {
        return Err(StoreError::Invalid(
            "Connection changed or conflicts with existing authority.".into(),
        ));
    }
    if current.lifecycle == lifecycle
        && current.authorization_state == authorization_state
        && current.health_state == health_state
        && current.credential_state == credential_state
    {
        return Ok(current);
    }
    let changed = tx.execute(
        "UPDATE connection_record SET revision=revision+1,lifecycle=?1,authorization_state=?2,
           health_state=?3,credential_state=?4,updated_at=?5
         WHERE workspace_id=?6 AND id=?7 AND revision=?8 AND kind='native-connector'
           AND authority='local' AND deleted_at IS NULL;",
        rusqlite::params![
            lifecycle,
            authorization_state,
            health_state,
            credential_state,
            updated_at,
            scope.data.workspace_id(),
            id,
            expected_revision,
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Connection changed before its lifecycle was saved.".into(),
        ));
    }
    get(tx, store, scope, id)?.ok_or_else(|| {
        StoreError::Invalid("Connection could not be read after its lifecycle changed.".into())
    })
}

pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Vec<SafeConnectionRecord>> {
    require_current_scope(tx, scope, ScopeAccess::Read)?;
    let mut stmt = tx.prepare(&format!(
        "{SELECT} WHERE workspace_id=?1 AND deleted_at IS NULL ORDER BY updated_at DESC,id"
    ))?;
    let partials = stmt
        .query_map([scope.data.workspace_id()], read_partial)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    partials
        .into_iter()
        .map(|row| open_safe(store, row))
        .collect()
}

const SELECT: &str = "SELECT id,workspace_id,kind,ownership,lifecycle,authorization_state,
  health_state,trust,credential_custody,credential_state,connector_definition_key,
  enabled_by_default,revision,created_by_internal_user_id,created_at,updated_at,payload,payload_nonce
  FROM connection_record";

fn read_partial(row: &rusqlite::Row<'_>) -> rusqlite::Result<Partial> {
    Ok(Partial {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind: row.get(2)?,
        ownership: row.get(3)?,
        lifecycle: row.get(4)?,
        authorization_state: row.get(5)?,
        health_state: row.get(6)?,
        trust: row.get(7)?,
        credential_custody: row.get(8)?,
        credential_state: row.get(9)?,
        connector_definition_key: row.get(10)?,
        enabled_by_default: row.get(11)?,
        revision: row.get(12)?,
        created_by_internal_user_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        sealed: crate::store::vault::Sealed {
            ciphertext: row.get(16)?,
            nonce: row.get(17)?,
        },
    })
}

fn open_safe(store: &Store, row: Partial) -> Result<SafeConnectionRecord> {
    let content = open_content(store, &row)?;
    match &content.transport {
        ConnectionTransport::NativeConnector {
            connector_definition_key,
            ..
        } if row.kind == "native-connector"
            && row.connector_definition_key.as_deref() == Some(connector_definition_key) => {}
        ConnectionTransport::Mcp {
            transport,
            local_launch_reference,
            discovery_state,
            ..
        } if row.kind == "mcp"
            && row.connector_definition_key.is_none()
            && matches!(transport.as_str(), "stdio" | "streamable-http")
            && !local_launch_reference.is_empty()
            && matches!(discovery_state.as_str(), "not-started" | "discovered") => {}
        _ => {
            return Err(StoreError::Invalid(
                "Connection content conflicts with its storage identity.".into(),
            ))
        }
    }
    Ok(SafeConnectionRecord {
        id: row.id,
        workspace_id: row.workspace_id,
        display_name: content.display_name,
        kind: row.kind,
        ownership: row.ownership,
        lifecycle: row.lifecycle,
        authorization_state: row.authorization_state,
        health_state: row.health_state,
        trust: row.trust,
        credential_custody: row.credential_custody,
        credential_state: row.credential_state,
        connector_definition_key: row.connector_definition_key.unwrap_or_default(),
        enabled_by_default: row.enabled_by_default,
        revision: row.revision,
        created_by_internal_user_id: row.created_by_internal_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn open_content(store: &Store, row: &Partial) -> Result<ConnectionContent> {
    serde_json::from_value(open_json(
        store,
        &row.sealed,
        &aad(&row.workspace_id, &row.id),
    )?)
    .map_err(|_| StoreError::Invalid("Connection content is invalid.".into()))
}

fn mcp_details_for_id(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
) -> Result<SafeMcpConnectionDetails> {
    let row = tx.query_row(
        &format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL"),
        rusqlite::params![scope.data.workspace_id(), connection_id],
        read_partial,
    )?;
    mcp_projection(store, &row)
}

fn mcp_projection(store: &Store, row: &Partial) -> Result<SafeMcpConnectionDetails> {
    if row.kind != "mcp" {
        return Err(StoreError::Invalid(
            "Connection is not an MCP Connection.".into(),
        ));
    }
    let content = open_content(store, row)?;
    let ConnectionTransport::Mcp {
        transport,
        local_launch_reference,
        discovery_state,
        discovered_at,
        discovered_tools,
        discovered_resources,
        enabled_tools,
        enabled_resources,
        capability_bindings,
    } = content.transport
    else {
        return Err(StoreError::Invalid(
            "Connection content conflicts with its MCP identity.".into(),
        ));
    };
    if transport != "stdio" && transport != "streamable-http" {
        return Err(StoreError::Invalid("MCP transport is unavailable.".into()));
    }
    Ok(SafeMcpConnectionDetails {
        connection_id: row.id.clone(),
        connection_revision: row.revision,
        transport,
        launch_reference: local_launch_reference,
        discovery_state,
        discovered_at,
        discovered_tools,
        discovered_resources,
        enabled_tools,
        enabled_resources,
        capability_bindings: capability_bindings
            .into_iter()
            .map(|binding| SafeMcpCapabilityBinding {
                capability_id: binding.capability_id,
                tool_name: binding.tool_name,
                contract_version: binding.contract_version,
                consequence: binding.consequence,
                trust: binding.trust,
            })
            .collect(),
    })
}

fn normalize_mcp_capability_bindings(
    values: Vec<McpCapabilityBindingWrite>,
    enabled_tools: &[String],
) -> Result<Vec<McpCapabilityBinding>> {
    if values.len() > 8 {
        return Err(StoreError::Invalid(
            "MCP capability bindings exceed the supported limit.".into(),
        ));
    }
    let mut bindings = Vec::with_capacity(values.len());
    for value in values {
        let capability_id = bounded(&value.capability_id, "MCP capability", 160)?;
        if capability_id != "knowledge.content.search" {
            return Err(StoreError::Invalid(
                "This MCP semantic capability is not supported.".into(),
            ));
        }
        let tool_name = bounded(&value.tool_name, "MCP tool", 256)?;
        if enabled_tools.binary_search(&tool_name).is_err() {
            return Err(StoreError::Invalid(
                "An MCP semantic binding must name an enabled discovered tool.".into(),
            ));
        }
        if bindings
            .iter()
            .any(|binding: &McpCapabilityBinding| binding.capability_id == capability_id)
        {
            return Err(StoreError::Invalid(
                "An MCP semantic capability can bind to only one tool on a Connection.".into(),
            ));
        }
        bindings.push(McpCapabilityBinding {
            capability_id,
            tool_name,
            contract_version: "fable.connected-source-search.v1".into(),
            consequence: "read".into(),
            trust: "untrusted".into(),
        });
    }
    bindings.sort_by(|left, right| left.capability_id.cmp(&right.capability_id));
    Ok(bindings)
}

pub(crate) fn require_mcp_capability_binding(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connection_id: &str,
    expected_revision: i64,
    capability_id: &str,
) -> Result<SafeMcpCapabilityBinding> {
    let details = mcp_details_for_id(tx, store, scope, connection_id)?;
    if details.connection_revision != expected_revision || details.discovery_state != "discovered" {
        return Err(StoreError::Invalid(
            "The MCP semantic binding is stale or unavailable.".into(),
        ));
    }
    details
        .capability_bindings
        .into_iter()
        .find(|binding| binding.capability_id == capability_id)
        .ok_or_else(|| {
            StoreError::Invalid("No MCP tool is bound to this semantic capability.".into())
        })
}

fn normalized_discovery_values(
    values: Vec<String>,
    label: &str,
    max_items: usize,
    max_chars: usize,
) -> Result<Vec<String>> {
    if values.len() > max_items {
        return Err(StoreError::Invalid(format!(
            "MCP {label} discovery exceeds the supported limit."
        )));
    }
    let mut normalized = values
        .into_iter()
        .map(|value| bounded(&value, &format!("MCP {label}"), max_chars))
        .collect::<Result<Vec<_>>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "{label} must be between 1 and {max} characters."
        )));
    }
    Ok(value.to_string())
}

fn validate_state(value: &str, allowed: &[&str], label: &str) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Connection {label} is invalid."
        )))
    }
}

fn aad(workspace_id: &str, id: &str) -> String {
    format!("connection_record:{workspace_id}:{id}")
}

fn external_principal_digest(workspace_id: &str, connector_id: &str, account_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.connection.external-principal.v1\0");
    for value in [workspace_id, connector_id, account_id] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!("{:x}", digest.finalize())
}

fn derive_mcp_connection_id(
    workspace_id: &str,
    owner_subject: &str,
    launch_reference: &str,
    transport: &str,
) -> String {
    let mut digest = Sha256::new();
    if transport == "stdio" {
        digest.update(b"fable.connection.mcp-stdio.v1\0");
    } else {
        digest.update(b"fable.connection.mcp-streamable-http.v1\0");
    }
    for value in [workspace_id, owner_subject, launch_reference] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!(
        "connection_mcp_{}",
        &format!("{:x}", digest.finalize())[..32]
    )
}

pub(crate) fn require_current_scope(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    access: ScopeAccess,
) -> Result<()> {
    if scope.data.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Connections are workspace-scoped and cannot use project authority.".into(),
        ));
    }
    let current =
        crate::authorized_scope::resolve(tx, Some(scope.data.workspace_id()), None, access)?;
    if current.internal_user_id != scope.internal_user_id || current.member_id != scope.member_id {
        return Err(StoreError::Invalid(
            "Connection authority changed before the operation completed.".into(),
        ));
    }
    Ok(())
}

const LIFECYCLES: &[&str] = &[
    "pending-authorization",
    "authorizing",
    "authorized",
    "refresh-required",
    "revoked",
    "disconnected",
    "removed",
];
const AUTHORIZATION_STATES: &[&str] = &[
    "not-required",
    "pending",
    "authorized",
    "expired",
    "denied",
    "revoked",
    "unavailable",
];
const HEALTH_STATES: &[&str] = &["unknown", "healthy", "degraded", "unhealthy", "offline"];
const CREDENTIAL_STATES: &[&str] = &[
    "not-required",
    "available",
    "refresh-required",
    "unavailable",
    "revoked",
    "unknown",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::store::repos::workspace_directory::{
        select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
        WorkspaceDirectoryUpsert,
    };
    use crate::store::vault::{MasterKey, Vault};

    fn summary(user: &str, workspace: &str, member: &str) -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: user.into(),
            fable_workspace_id: workspace.into(),
            name: workspace.into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: member.into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "t".into(),
        }
    }

    fn input<'a>(expected_revision: Option<i64>) -> NativeConnectorConnectionWrite<'a> {
        NativeConnectorConnectionWrite {
            connector_definition_key: "gmail",
            external_account_id: "provider-account-secret",
            display_name: "Work Gmail",
            lifecycle: "authorized",
            authorization_state: "authorized",
            health_state: "unknown",
            credential_state: "available",
            expected_revision,
            updated_at: "2026-07-11T14:00:00Z",
        }
    }

    #[test]
    fn authenticated_writer_is_workspace_bound_encrypted_and_revision_checked() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let (scope_a, local_b) = store
            .transaction(|tx| {
                let a = upsert_authoritative_summary(
                    tx,
                    &summary("user-a", "workspace-a", "member-a"),
                )?;
                let b = upsert_authoritative_summary(
                    tx,
                    &summary("user-b", "workspace-b", "member-b"),
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                select_active_workspace(tx, "user-a", "workspace-a", "t")?;
                Ok((
                    resolve(tx, Some(&a.local_workspace_id), None, ScopeAccess::Write)?,
                    b.local_workspace_id,
                ))
            })
            .unwrap();
        let created = store
            .transaction(|tx| upsert_native_connector(tx, &store, &scope_a, input(None)))
            .unwrap();
        assert_eq!(created.revision, 1);
        assert_eq!(created.workspace_id, scope_a.data.workspace_id());
        assert!(!serde_json::to_string(&created)
            .unwrap()
            .contains("provider-account-secret"));
        assert!(!serde_json::to_string(&created)
            .unwrap()
            .contains("oauth-token:"));

        let stored_payload = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT payload FROM connection_record WHERE workspace_id=?1 AND id=?2",
                    rusqlite::params![scope_a.data.workspace_id(), created.id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&stored_payload).contains("Work Gmail"));
        assert!(!String::from_utf8_lossy(&stored_payload).contains("provider-account-secret"));

        assert!(store
            .transaction(|tx| upsert_native_connector(tx, &store, &scope_a, input(None)))
            .unwrap_err()
            .to_string()
            .contains("expected revision"));
        let unchanged = store
            .transaction(|tx| upsert_native_connector(tx, &store, &scope_a, input(Some(1))))
            .unwrap();
        assert_eq!(unchanged.revision, 1);
        let mut changed = input(Some(1));
        changed.health_state = "healthy";
        let updated = store
            .transaction(|tx| upsert_native_connector(tx, &store, &scope_a, changed))
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert!(store
            .transaction(|tx| upsert_native_connector(tx, &store, &scope_a, input(Some(1))))
            .is_err());
        let disconnected = store
            .transaction(|tx| {
                transition_native_connector(
                    tx,
                    &store,
                    &scope_a,
                    &updated.id,
                    2,
                    "disconnected",
                    "revoked",
                    "offline",
                    "revoked",
                    "2026-07-11T15:00:00Z",
                )
            })
            .unwrap();
        assert_eq!(disconnected.revision, 3);
        assert_eq!(disconnected.lifecycle, "disconnected");
        assert_eq!(disconnected.authorization_state, "revoked");
        assert!(store
            .transaction(|tx| {
                transition_native_connector(
                    tx,
                    &store,
                    &scope_a,
                    &updated.id,
                    2,
                    "removed",
                    "revoked",
                    "offline",
                    "revoked",
                    "2026-07-11T15:01:00Z",
                )
            })
            .is_err());

        store
            .transaction(|tx| {
                set_current_internal_user(tx, "user-b", "t")?;
                select_active_workspace(tx, "user-b", "workspace-b", "t")?;
                let scope_b = resolve(tx, Some(&local_b), None, ScopeAccess::Write)?;
                assert!(list(tx, &store, &scope_a).is_err());
                assert!(list(tx, &store, &scope_b)?.is_empty());
                assert!(upsert_native_connector(tx, &store, &scope_b, input(None)).is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn writer_rejects_unknown_states_and_project_scope() {
        let mut invalid = input(None);
        invalid.lifecycle = "connected-ish";
        assert!(validate_state(invalid.lifecycle, LIFECYCLES, "lifecycle").is_err());

        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let data = crate::store::repos::scope::DataScope::new("default", Some("project-a".into()))
            .unwrap();
        let project_scope = AuthorizedCommandScope {
            private: crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
                data.clone(),
                "user-a",
                Some("member-a"),
            )
            .unwrap(),
            data,
            internal_user_id: "user-a".into(),
            member_id: Some("member-a".into()),
        };
        assert!(store
            .transaction(|tx| upsert_native_connector(tx, &store, &project_scope, input(None)))
            .unwrap_err()
            .to_string()
            .contains("workspace-scoped"));
    }

    #[test]
    fn mcp_connection_is_private_disabled_and_credential_free() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = store
            .transaction(|tx| {
                let workspace = upsert_authoritative_summary(
                    tx,
                    &summary("user-a", "workspace-a", "member-a"),
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                select_active_workspace(tx, "user-a", "workspace-a", "t")?;
                resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )
            })
            .unwrap();
        let created = store
            .transaction(|tx| {
                upsert_mcp_stdio(
                    tx,
                    &store,
                    &scope,
                    "local-files",
                    "Local files",
                    "2026-07-11T20:00:00Z",
                )
            })
            .unwrap();
        assert_eq!(created.kind, "mcp");
        assert_eq!(created.ownership, "user-owned");
        assert_eq!(created.trust, "user-managed");
        assert_eq!(created.credential_custody, "none");
        assert_eq!(created.credential_state, "not-required");
        assert!(store
            .with_conn(|tx| mcp_oauth_credential_binding(tx, &store, &scope, &created.id))
            .unwrap()
            .is_none());
        assert!(!created.enabled_by_default);
        assert!(created.connector_definition_key.is_empty());
        assert_eq!(
            store
                .with_conn(|tx| list(tx, &store, &scope))
                .unwrap()
                .len(),
            1
        );
        let stored = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT visibility,owner_member_id,credential_ref,connector_definition_key,
                            enabled_by_default FROM connection_record WHERE id=?1",
                    [&created.id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, i64>(4)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(
            stored,
            (
                "member-private".into(),
                "member-a".into(),
                "".into(),
                None,
                0
            )
        );

        let discovered = store
            .transaction(|tx| {
                record_mcp_discovery(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    created.revision,
                    vec!["write".into(), "read".into(), "read".into()],
                    vec!["file:///safe".into()],
                    "2026-07-11T20:01:00Z",
                )
            })
            .unwrap();
        assert_eq!(discovered.connection_revision, 2);
        assert_eq!(discovered.discovery_state, "discovered");
        assert_eq!(discovered.discovered_tools, ["read", "write"]);
        assert!(discovered.enabled_tools.is_empty());
        assert!(store
            .transaction(|tx| {
                set_mcp_enablement(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    discovered.connection_revision,
                    vec!["not-discovered".into()],
                    Vec::new(),
                    Vec::new(),
                    "2026-07-11T20:01:30Z",
                )
            })
            .is_err());
        let enabled = store
            .transaction(|tx| {
                set_mcp_enablement(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    discovered.connection_revision,
                    vec!["read".into()],
                    vec!["file:///safe".into()],
                    vec![McpCapabilityBindingWrite {
                        capability_id: "knowledge.content.search".into(),
                        tool_name: "read".into(),
                    }],
                    "2026-07-11T20:01:30Z",
                )
            })
            .unwrap();
        assert_eq!(enabled.connection_revision, 3);
        assert_eq!(enabled.enabled_tools, ["read"]);
        assert_eq!(enabled.enabled_resources, ["file:///safe"]);
        assert_eq!(enabled.capability_bindings.len(), 1);
        assert_eq!(
            enabled.capability_bindings[0],
            SafeMcpCapabilityBinding {
                capability_id: "knowledge.content.search".into(),
                tool_name: "read".into(),
                contract_version: "fable.connected-source-search.v1".into(),
                consequence: "read".into(),
                trust: "untrusted".into(),
            }
        );
        let binding = store
            .with_conn(|tx| {
                require_mcp_capability_binding(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    enabled.connection_revision,
                    "knowledge.content.search",
                )
            })
            .unwrap();
        assert_eq!(binding.tool_name, "read");
        assert!(store
            .transaction(|tx| {
                record_mcp_discovery(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    created.revision,
                    vec!["forged".into()],
                    Vec::new(),
                    "2026-07-11T20:02:00Z",
                )
            })
            .is_err());
        let rediscovered = store
            .transaction(|tx| {
                record_mcp_discovery(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    enabled.connection_revision,
                    vec!["write".into()],
                    Vec::new(),
                    "2026-07-11T20:03:00Z",
                )
            })
            .unwrap();
        assert!(rediscovered.enabled_tools.is_empty());
        assert!(rediscovered.capability_bindings.is_empty());
        let authorized = store
            .transaction(|tx| {
                authorize_mcp_oauth(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    rediscovered.connection_revision,
                    "mcp-oauth-opaque-binding",
                    "2026-07-11T20:04:00Z",
                )
            })
            .unwrap();
        assert_eq!(authorized.authorization_state, "authorized");
        assert_eq!(authorized.credential_custody, "os-secure-store");
        assert_eq!(authorized.credential_state, "available");
        assert_eq!(
            store
                .with_conn(|tx| { mcp_oauth_credential_binding(tx, &store, &scope, &created.id) })
                .unwrap()
                .as_deref(),
            Some("mcp-oauth-opaque-binding")
        );
        assert!(!serde_json::to_string(&authorized)
            .unwrap()
            .contains("mcp-oauth-opaque-binding"));
        assert!(store
            .transaction(|tx| {
                authorize_mcp_oauth(
                    tx,
                    &store,
                    &scope,
                    &created.id,
                    rediscovered.connection_revision,
                    "mcp-oauth-other-binding",
                    "2026-07-11T20:05:00Z",
                )
            })
            .is_err());
    }

    #[test]
    fn transport_enum_preserves_existing_native_payload_shape() {
        let content: ConnectionContent = serde_json::from_value(serde_json::json!({
            "displayName": "Work Gmail",
            "transport": {
                "kind": "native-connector",
                "connectorDefinitionKey": "gmail",
                "externalPrincipal": {
                    "provider": "gmail",
                    "opaqueSubjectReference": "external_abc"
                }
            }
        }))
        .unwrap();
        assert!(matches!(
            content.transport,
            ConnectionTransport::NativeConnector {
                connector_definition_key,
                ..
            } if connector_definition_key == "gmail"
        ));
    }
}
