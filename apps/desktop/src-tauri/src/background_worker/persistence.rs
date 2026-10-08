use crate::collaboration::models::{Author, Work};
use crate::store::repos::{
    collaboration as repo, collaboration::Kind, preferences, scope::DataScope,
};
use crate::store::{Store, StoreError};
use rusqlite::Connection;

const KEY: &str = "nativeBackgroundExecution";
static GENERATION: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    version: u32,
    enabled: bool,
    generation: u64,
}

fn settings_at(conn: &Connection, store: &Store) -> crate::store::Result<Settings> {
    let value = preferences::get_scoped(conn, store, &DataScope::legacy_default(), KEY)?;
    let settings: Settings = value
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| {
            StoreError::Invalid(
                "Background execution settings are invalid; execution is paused.".into(),
            )
        })?
        .unwrap_or(Settings {
            version: 1,
            enabled: false,
            generation: 0,
        });
    if settings.version != 1 {
        return Err(StoreError::Invalid(
            "Unsupported background settings.".into(),
        ));
    }
    Ok(settings)
}

pub(crate) fn capture_generation(store: &Store) -> Result<(), String> {
    let settings = store
        .with_conn(|conn| settings_at(conn, store))
        .map_err(|e| e.to_string())?;
    if !settings.enabled {
        return Err("Background execution is disabled.".into());
    }
    GENERATION
        .set(settings.generation)
        .map_err(|_| "Background account generation was already captured.".into())
}

pub(crate) fn enabled(store: &Store) -> Result<bool, String> {
    store
        .with_conn(|conn| enabled_at(conn, store))
        .map_err(|e| e.to_string())
}

pub(crate) fn enabled_at(conn: &Connection, store: &Store) -> crate::store::Result<bool> {
    let settings = settings_at(conn, store)?;
    Ok(settings.enabled
        && GENERATION
            .get()
            .is_none_or(|generation| *generation == settings.generation))
}

pub(crate) fn set_enabled(store: &Store, enabled: bool) -> Result<(), String> {
    store
        .transaction(|conn| set_enabled_at(conn, store, enabled))
        .map_err(|e| e.to_string())
}

fn set_enabled_at(conn: &Connection, store: &Store, enabled: bool) -> crate::store::Result<()> {
    let current = settings_at(conn, store)?;
    if current.enabled == enabled {
        return Ok(());
    }
    let next = Settings {
        version: 1,
        enabled,
        generation: current
            .generation
            .checked_add(1)
            .ok_or_else(|| StoreError::Invalid("Background generation exhausted.".into()))?,
    };
    preferences::upsert_scoped(
        conn,
        store,
        &DataScope::legacy_default(),
        KEY,
        &serde_json::to_value(next)
            .map_err(|_| StoreError::Invalid("Background settings could not be encoded.".into()))?,
        &chrono::Utc::now().to_rfc3339(),
    )
}

/// Outgoing-account suspension uses its already bound store even after the
/// credential expired. IPC availability cannot keep the worker authorized.
pub(crate) fn revoke_at(conn: &Connection, store: &Store) -> crate::store::Result<()> {
    set_enabled_at(conn, store, false)
}

pub(crate) fn owns_work(work: &Work) -> bool {
    work.execution_owner.as_deref() == Some("native-background")
}

pub(crate) fn owns_attempt(
    conn: &Connection,
    store: &Store,
    run: &str,
) -> crate::store::Result<bool> {
    if !super::owner_alive() {
        return Ok(false);
    }
    let scope = crate::authorized_scope::resolve(
        conn,
        None,
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let Some(author) = repo::get::<Author>(conn, store, &scope.private, Kind::Author, run)? else {
        return Ok(false);
    };
    let Some(id) = author.work_id else {
        return Ok(false);
    };
    Ok(
        repo::get::<Work>(conn, store, &scope.private, Kind::Work, &id)?.is_some_and(|w| {
            owns_work(&w)
                && w.generation == author.generation
                && w.current_run_id.as_deref() == Some(run)
                && w.status.executing()
        }),
    )
}
