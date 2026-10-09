//! Account-private control state in the existing encrypted native repository.
//! No schema allocation and no bearer/code/verifier is persisted or exported.
use super::{invalid, models::*, Result};
use crate::{
    authorized_scope::AuthorizedCommandScope,
    store::{repos::preferences, Store},
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

fn key(scope: &AuthorizedCommandScope) -> String {
    format!(
        "mcp-server:{:x}",
        Sha256::digest(scope.private.owner_subject().as_bytes())
    )
}

pub(super) fn read(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Saved> {
    preferences::get_scoped(conn, store, &scope.data, &key(scope))?
        .map(serde_json::from_value)
        .transpose()
        .map(|value| value.unwrap_or_default())
        .map_err(|_| invalid("MCP access data is unavailable. Access is disabled."))
}

pub(super) fn write(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    saved: &Saved,
) -> Result<()> {
    preferences::upsert_scoped(
        conn,
        store,
        &scope.data,
        &key(scope),
        &serde_json::to_value(saved).map_err(|_| invalid("MCP access could not be saved."))?,
        &chrono::Utc::now().to_rfc3339(),
    )
}

pub(super) fn profiles(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Vec<crate::models::MivletAgentProfile>> {
    let value =
        preferences::get_scoped(conn, store, &scope.data, "document:runtime-snapshot.json")?
            .unwrap_or_default();
    serde_json::from_value(
        value
            .get("agents")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .map_err(|_| invalid("The native agent profiles are unavailable."))
}

pub(super) fn authenticate(saved: &Saved, bearer: &str, resource: &str) -> Result<Grant> {
    let now = chrono::Utc::now().timestamp();
    if !saved.enabled || bearer.len() != 43 {
        return Err(invalid("Authentication required."));
    }
    let hash = super::hash(bearer);
    let token = saved
        .tokens
        .iter()
        .find(|t| t.hash == hash && t.expires_at > now)
        .ok_or_else(|| invalid("Authentication required."))?;
    let grant = saved
        .grants
        .iter()
        .find(|g| {
            g.id == token.grant_id && !g.revoked && g.expires_at > now && g.resource == resource
        })
        .ok_or_else(|| invalid("Authentication required."))?;
    Ok(grant.clone())
}

pub(crate) fn check_work(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    root: &crate::collaboration::models::Work,
    agent_id: &str,
    permission_mode: &str,
) -> Result<()> {
    let Some(external) = &root.external_client else {
        return Ok(());
    };
    let saved = read(conn, store, scope)?;
    let now = chrono::Utc::now().timestamp();
    let grant = saved
        .grants
        .iter()
        .find(|g| g.id == external.grant_id && !g.revoked && g.expires_at > now)
        .ok_or_else(|| {
            invalid("The external client's access expired or was revoked. Review this Work.")
        })?;
    if !saved.enabled
        || grant.access != Access::RequestTasks
        || !grant.agent_ids.iter().any(|id| id == agent_id)
        || rank(permission_mode) > rank(&grant.permission_mode)
    {
        return Err(invalid(
            "This Work exceeds the external client's current grant.",
        ));
    }
    Ok(())
}

pub(super) fn rank(mode: &str) -> u8 {
    match mode {
        "full-access" => 2,
        "trusted-scope" => 1,
        _ => 0,
    }
}
