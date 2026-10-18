//! Canonical connector refresh snapshots and durable state transitions.

use std::path::Path;

use crate::models::ConnectorCommandError;

use super::{
    command_error, derive_native_connection_id, finish_metadata_commit, mark_refresh_rejected,
    now_epoch, read_connections, rollback_credential, same_connection_snapshot, write_connections,
    ConnectorConnection, ConnectorSecretStore, CredentialRollback,
};

pub(super) fn refresh_authorization_context(
    connector_id: &str,
) -> Result<
    (
        crate::authorized_scope::AuthorizedCommandScope,
        &'static crate::store::Store,
    ),
    ConnectorCommandError,
> {
    let scope =
        crate::authorized_scope::active_command_scope(crate::authorized_scope::ScopeAccess::Write)
            .map_err(|message| command_error("invalid-request", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    Ok((scope, durable_store))
}

pub(super) fn canonical_connection_for_refresh(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    provider_account_id: &str,
) -> Result<crate::store::repos::connection_record::SafeConnectionRecord, ConnectorCommandError> {
    let id =
        derive_native_connection_id(scope.data.workspace_id(), connector_id, provider_account_id);
    let record = store
        .with_conn(|tx| crate::store::repos::connection_record::get(tx, store, scope, &id))
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Canonical Connection authorization is unavailable.",
                false,
            )
        })?;
    let authorized = record.lifecycle == "authorized"
        && record.authorization_state == "authorized"
        && record.credential_state == "available";
    let refreshable = record.lifecycle == "refresh-required"
        && record.authorization_state == "expired"
        && record.credential_state == "refresh-required";
    if record.connector_definition_key != connector_id || (!authorized && !refreshable) {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Canonical Connection authorization must be recovered before use.",
            false,
        ));
    }
    Ok(record)
}

pub(super) fn canonical_credential_binding(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    provider_account_id: &str,
) -> Result<String, ConnectorCommandError> {
    let id =
        derive_native_connection_id(scope.data.workspace_id(), connector_id, provider_account_id);
    store
        .with_conn(|tx| {
            crate::store::repos::connection_record::native_credential_binding(tx, store, scope, &id)
        })
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))
}

fn verify_refresh_snapshot(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    previous_connections: &[ConnectorConnection],
    credential_ref: &str,
    previous_secret: &str,
) -> Result<(), ConnectorCommandError> {
    let current_connections = read_connections(path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let current_secret = store
        .get(credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    if !same_connection_snapshot(&current_connections, previous_connections)
        || current_secret.as_deref() != Some(previous_secret)
    {
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector state changed before refresh could be saved.",
            true,
        ));
    }
    Ok(())
}

fn transition_refreshed_canonical(
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    account_id: &str,
    expected_revision: i64,
    previous_health_state: &str,
    lifecycle: &str,
    authorization_state: &str,
    health_state: Option<&str>,
    credential_state: &str,
    updated_at: &str,
) -> crate::store::Result<()> {
    durable_store.transaction(|tx| {
        let id = derive_native_connection_id(scope.data.workspace_id(), connector_id, account_id);
        crate::store::repos::connection_record::transition_native_connector(
            tx,
            durable_store,
            scope,
            &id,
            expected_revision,
            lifecycle,
            authorization_state,
            health_state.unwrap_or(previous_health_state),
            credential_state,
            updated_at,
        )?;
        Ok(())
    })
}

pub(super) fn commit_refresh_success<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    previous_connections: &[ConnectorConnection],
    previous_secret: &str,
    canonical_revision: i64,
    canonical_health_state: &str,
    updated_connection: ConnectorConnection,
    updated_secret: &str,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let _guard = before_commit()?;
    verify_refresh_snapshot(
        connector_id,
        store,
        path,
        previous_connections,
        &updated_connection.credential_ref,
        previous_secret,
    )?;
    store
        .set(&updated_connection.credential_ref, updated_secret)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let rollback = CredentialRollback {
        credential_ref: updated_connection.credential_ref.clone(),
        previous_secret: Some(previous_secret.to_string()),
    };
    let mut updated_connections = previous_connections.to_vec();
    let Some(target) = updated_connections.iter_mut().find(|connection| {
        connection.connector_id == connector_id
            && connection.account.id == updated_connection.account.id
    }) else {
        let _ = rollback_credential(store, rollback);
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector state changed before refresh could be saved.",
            true,
        ));
    };
    *target = updated_connection.clone();
    if let Err(error) = write_connections(path, &updated_connections) {
        return finish_metadata_commit(Err(error), store, rollback)
            .map(|_| unreachable!())
            .map_err(|message| command_error("unknown", connector_id, &message, false));
    }
    if let Err(error) = transition_refreshed_canonical(
        durable_store,
        scope,
        connector_id,
        &updated_connection.account.id,
        canonical_revision,
        canonical_health_state,
        "authorized",
        "authorized",
        None,
        "available",
        &updated_connection.updated_at,
    ) {
        let metadata_restored = write_connections(path, previous_connections).is_ok();
        let credential_restored = rollback_credential(store, rollback).is_ok();
        return if metadata_restored && credential_restored {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Mivlet could not finish or fully restore connector refresh; reconnect this provider.",
                false,
            ))
        };
    }
    Ok(updated_connection)
}

pub(super) fn commit_refresh_rejection<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    previous_connections: &[ConnectorConnection],
    previous_secret: &str,
    account_id: &str,
    canonical_revision: i64,
    canonical_health_state: &str,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let _guard = before_commit()?;
    let credential_ref = previous_connections
        .iter()
        .find(|connection| {
            connection.connector_id == connector_id && connection.account.id == account_id
        })
        .ok_or_else(|| {
            command_error(
                "conflict",
                connector_id,
                "Connector state changed before refresh could be saved.",
                true,
            )
        })?
        .credential_ref
        .clone();
    verify_refresh_snapshot(
        connector_id,
        store,
        path,
        previous_connections,
        &credential_ref,
        previous_secret,
    )?;
    let mut rejected = previous_connections.to_vec();
    mark_refresh_rejected(connector_id, account_id, &mut rejected);
    write_connections(path, &rejected)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let updated_at = rejected
        .iter()
        .find(|connection| {
            connection.connector_id == connector_id && connection.account.id == account_id
        })
        .map(|connection| connection.updated_at.as_str())
        .unwrap_or("0");
    if let Err(error) = transition_refreshed_canonical(
        durable_store,
        scope,
        connector_id,
        account_id,
        canonical_revision,
        canonical_health_state,
        "refresh-required",
        "expired",
        Some("unhealthy"),
        "refresh-required",
        updated_at,
    ) {
        return if write_connections(path, previous_connections).is_ok() {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Mivlet could not finish or fully restore rejected connector refresh; reconnect this provider.",
                false,
            ))
        };
    }
    Err(command_error(
        "expired-auth",
        connector_id,
        "Connector token refresh was rejected; reconnect the account.",
        false,
    ))
}
