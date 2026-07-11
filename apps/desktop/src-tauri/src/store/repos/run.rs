//! Agent runs. The transcript and error text may carry sensitive content, so
//! they live in the encrypted `payload`; provider/model/status are non-secret
//! catalog enums stored as plaintext columns for indexing.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store};

/// Upsert a run. `payload` carries transcript, pending approvals, and error.
#[allow(clippy::too_many_arguments)]
pub fn upsert(
    tx: &Connection,
    store: &Store,
    id: &str,
    thread_id: Option<&str>,
    provider_id: &str,
    model: &str,
    status: &str,
    turn: usize,
    recoverable: bool,
    retry_count: usize,
    created_at: &str,
    updated_at: &str,
    payload: &Value,
) -> Result<()> {
    upsert_scoped(
        tx,
        store,
        &DataScope::legacy_default(),
        id,
        thread_id,
        provider_id,
        model,
        status,
        turn,
        recoverable,
        retry_count,
        created_at,
        updated_at,
        payload,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    thread_id: Option<&str>,
    provider_id: &str,
    model: &str,
    status: &str,
    turn: usize,
    recoverable: bool,
    retry_count: usize,
    created_at: &str,
    updated_at: &str,
    payload: &Value,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    let existing = tx
        .query_row(
            "SELECT workspace_id, thread_id, provider_id, model, status, turn, recoverable,
                    retry_count, created_at, updated_at, payload, payload_nonce
             FROM run WHERE id=?1",
            [id],
            |row| {
                Ok(ExistingRun {
                    workspace_id: row.get(0)?,
                    thread_id: row.get(1)?,
                    provider_id: row.get(2)?,
                    model: row.get(3)?,
                    status: row.get(4)?,
                    turn: row.get(5)?,
                    recoverable: row.get::<_, i64>(6)? != 0,
                    retry_count: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    sealed: Sealed {
                        ciphertext: row.get(10)?,
                        nonce: row.get(11)?,
                    },
                })
            },
        )
        .optional()?;

    if let Some(existing) = existing {
        if existing.workspace_id != scope.workspace_id()
            || existing.thread_id.as_deref() != thread_id
            || existing.created_at != created_at
        {
            return Err(crate::store::StoreError::Invalid(
                "Agent run ownership and creation identity are immutable.".into(),
            ));
        }

        if is_terminal_status(&existing.status) {
            let existing_payload = open_json(store, &existing.sealed, &aad(id))?;
            let exact_replay = existing.provider_id == provider_id
                && existing.model == model
                && existing.status == status
                && existing.turn == turn as i64
                && existing.recoverable == recoverable
                && existing.retry_count == retry_count as i64
                && existing.updated_at == updated_at
                && existing_payload == *payload;
            if exact_replay {
                return Ok(());
            }
            return Err(crate::store::StoreError::Invalid(
                "A terminal agent run is immutable.".into(),
            ));
        }
    }
    if let Some(thread_id) = thread_id {
        let owner: Option<String> = tx
            .query_row(
                "SELECT workspace_id FROM thread WHERE id=?1",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(scope.workspace_id()) {
            return Err(crate::store::StoreError::Invalid(
                "Run thread does not belong to this workspace.".into(),
            ));
        }
    }
    let sealed = seal_json(store, payload, &aad(id))?;
    tx.execute(
        "INSERT INTO run (id, workspace_id, thread_id, provider_id, model, status, turn, recoverable,
                          retry_count, created_at, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           provider_id=excluded.provider_id, model=excluded.model, status=excluded.status, turn=excluded.turn,
           recoverable=excluded.recoverable, retry_count=excluded.retry_count,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            scope.workspace_id(),
            thread_id,
            provider_id,
            model,
            status,
            turn as i64,
            recoverable as i64,
            retry_count as i64,
            created_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "cancelled" | "failed" | "interrupted")
}

struct ExistingRun {
    workspace_id: String,
    thread_id: Option<String>,
    provider_id: String,
    model: String,
    status: String,
    turn: i64,
    recoverable: bool,
    retry_count: i64,
    created_at: String,
    updated_at: String,
    sealed: Sealed,
}

/// Read a run's metadata + decrypted payload.
pub struct RunRow {
    pub id: String,
    pub thread_id: Option<String>,
    pub provider_id: String,
    pub model: String,
    pub status: String,
    pub turn: i64,
    pub recoverable: bool,
    pub retry_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<RunRow>> {
    get_scoped(tx, store, &DataScope::legacy_default(), id)
}
pub fn get_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
) -> Result<Option<RunRow>> {
    scope.ensure_exists(tx)?;
    let row = tx
        .query_row(
            "SELECT id, thread_id, provider_id, model, status, turn, recoverable,
                    retry_count, created_at, updated_at, payload, payload_nonce
             FROM run WHERE id = ?1 AND workspace_id=?2;",
            rusqlite::params![id, scope.workspace_id()],
            |row| {
                Ok(RunPartial {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    provider_id: row.get(2)?,
                    model: row.get(3)?,
                    status: row.get(4)?,
                    turn: row.get(5)?,
                    recoverable: row.get::<_, i64>(6)? != 0,
                    retry_count: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    sealed: Sealed {
                        ciphertext: row.get::<_, Vec<u8>>(10)?,
                        nonce: row.get::<_, Vec<u8>>(11)?,
                    },
                })
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some(p) => {
            let payload = open_json(store, &p.sealed, &aad(&p.id))?;
            Ok(Some(RunRow {
                id: p.id,
                thread_id: p.thread_id,
                provider_id: p.provider_id,
                model: p.model,
                status: p.status,
                turn: p.turn,
                recoverable: p.recoverable,
                retry_count: p.retry_count,
                created_at: p.created_at,
                updated_at: p.updated_at,
                payload,
            }))
        }
    }
}

/// Internal partial read carrying the still-sealed payload.
struct RunPartial {
    id: String,
    thread_id: Option<String>,
    provider_id: String,
    model: String,
    status: String,
    turn: i64,
    recoverable: bool,
    retry_count: i64,
    created_at: String,
    updated_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

/// List runs by status (e.g. recover interrupted runs).
pub fn list_by_status(tx: &Connection, statuses: &[&str]) -> Result<Vec<String>> {
    list_by_status_scoped(tx, &DataScope::legacy_default(), statuses)
}
pub fn list_by_status_scoped(
    tx: &Connection,
    scope: &DataScope,
    statuses: &[&str],
) -> Result<Vec<String>> {
    scope.ensure_exists(tx)?;
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT id FROM run WHERE workspace_id=? AND status IN ({placeholders}) ORDER BY created_at;");
    let mut stmt = tx.prepare(&sql)?;
    let params = rusqlite::params_from_iter(
        std::iter::once(scope.workspace_id()).chain(statuses.iter().copied()),
    );
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete a run (cascades to tool_calls, approvals, artifacts).
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), id)
}
pub fn delete_scoped(tx: &Connection, scope: &DataScope, id: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM run WHERE id = ?1 AND workspace_id=?2;",
        rusqlite::params![id, scope.workspace_id()],
    )?;
    Ok(())
}

fn aad(id: &str) -> String {
    format!("run:{id}")
}

use rusqlite::OptionalExtension as _;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::artifact;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn seed_scope(store: &Store, workspace: &str, thread: &str) -> DataScope {
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES (?1,?1,'t','t')",
                    [workspace],
                )?;
                let sealed = seal_json(store, &serde_json::json!({}), &format!("thread:{thread}"))?;
                tx.execute(
                    "INSERT INTO thread(id,workspace_id,title,created_at,updated_at,payload,payload_nonce)
                     VALUES (?1,?2,'Thread','t','t',?3,?4)",
                    rusqlite::params![thread, workspace, sealed.ciphertext, sealed.nonce],
                )?;
                Ok(())
            })
            .unwrap();
        DataScope::workspace(workspace).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn save(
        store: &Store,
        scope: &DataScope,
        id: &str,
        thread: &str,
        status: &str,
        created_at: &str,
        updated_at: &str,
        payload: &Value,
    ) -> Result<()> {
        store.transaction(|tx| {
            upsert_scoped(
                tx,
                store,
                scope,
                id,
                Some(thread),
                "provider",
                "model",
                status,
                1,
                false,
                0,
                created_at,
                updated_at,
                payload,
            )
        })
    }

    #[test]
    fn conflicting_cross_workspace_upsert_fails_and_cannot_expose_linked_artifact() {
        let store = store();
        let alpha = seed_scope(&store, "alpha", "thread-alpha");
        let beta = seed_scope(&store, "beta", "thread-beta");
        let completed = serde_json::json!({"answer":"alpha"});
        save(
            &store,
            &alpha,
            "shared-run",
            "thread-alpha",
            "completed",
            "created",
            "finished",
            &completed,
        )
        .unwrap();
        store
            .transaction(|tx| {
                let sealed = seal_json(
                    &store,
                    &serde_json::json!({"secret":"alpha-artifact"}),
                    "artifact:alpha:user:legacy-test-user:artifact-alpha",
                )?;
                tx.execute(
                    "INSERT INTO artifact(workspace_id,owner_subject,authority,visibility,owner_internal_user_id,
                      id,run_id,thread_id,kind,status,revision,current_version_id,title_fingerprint,
                      content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce)
                     VALUES ('alpha','user:legacy-test-user','local','member-private','legacy-test-user',
                      'artifact-alpha','shared-run','thread-alpha','document','draft',1,'artifact-alpha:v1','title',
                      'hash',1,'t','t',?1,?2)",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                let version=seal_json(&store,&serde_json::json!({"id":"artifact-alpha:v1"}),
                    "artifact_version:alpha:user:legacy-test-user:artifact-alpha:artifact-alpha:v1")?;
                tx.execute("INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,
                  content_fingerprint,size_bytes,created_at,payload,payload_nonce)
                  VALUES ('alpha','user:legacy-test-user','artifact-alpha','artifact-alpha:v1',1,'available',
                  'hash',1,'t',?1,?2)",rusqlite::params![version.ciphertext,version.nonce])?;
                Ok(())
            })
            .unwrap();

        let takeover = save(
            &store,
            &beta,
            "shared-run",
            "thread-beta",
            "streaming",
            "created",
            "later",
            &serde_json::json!({"answer":"beta"}),
        );
        assert!(takeover.is_err());
        assert!(store
            .with_conn(|tx| artifact::get(tx, &store, &beta, "artifact-alpha"))
            .unwrap()
            .is_none());
        let preserved = store
            .with_conn(|tx| get_scoped(tx, &store, &alpha, "shared-run"))
            .unwrap()
            .unwrap();
        assert_eq!(preserved.thread_id.as_deref(), Some("thread-alpha"));
        assert_eq!(preserved.payload, completed);
    }

    #[test]
    fn run_thread_and_created_at_are_immutable_before_terminal_state() {
        let store = store();
        let scope = seed_scope(&store, "alpha", "thread-one");
        seed_scope(&store, "other", "unused");
        store
            .transaction(|tx| {
                let sealed = seal_json(&store, &Value::Null, "thread:thread-two")?;
                tx.execute(
                    "INSERT INTO thread(id,workspace_id,title,created_at,updated_at,payload,payload_nonce)
                     VALUES ('thread-two','alpha','Thread','t','t',?1,?2)",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                Ok(())
            })
            .unwrap();
        save(
            &store,
            &scope,
            "run-1",
            "thread-one",
            "streaming",
            "created",
            "one",
            &serde_json::json!({"partial":1}),
        )
        .unwrap();
        assert!(save(
            &store,
            &scope,
            "run-1",
            "thread-two",
            "streaming",
            "created",
            "two",
            &serde_json::json!({"partial":2}),
        )
        .is_err());
        assert!(save(
            &store,
            &scope,
            "run-1",
            "thread-one",
            "streaming",
            "different-created-at",
            "two",
            &serde_json::json!({"partial":2}),
        )
        .is_err());
    }

    #[test]
    fn terminal_result_allows_exact_replay_but_rejects_every_replacement() {
        let store = store();
        let scope = seed_scope(&store, "alpha", "thread-one");
        let terminal = serde_json::json!({"answer":"final"});
        save(
            &store,
            &scope,
            "run-1",
            "thread-one",
            "streaming",
            "created",
            "streaming-at",
            &serde_json::json!({"answer":"partial"}),
        )
        .unwrap();
        save(
            &store,
            &scope,
            "run-1",
            "thread-one",
            "completed",
            "created",
            "finished-at",
            &terminal,
        )
        .unwrap();
        save(
            &store,
            &scope,
            "run-1",
            "thread-one",
            "completed",
            "created",
            "finished-at",
            &terminal,
        )
        .expect("exact replay is idempotent");

        for (status, updated_at, payload) in [
            ("failed", "late", serde_json::json!({"error":"replacement"})),
            (
                "streaming",
                "stale",
                serde_json::json!({"answer":"partial"}),
            ),
            (
                "completed",
                "later",
                serde_json::json!({"answer":"changed"}),
            ),
        ] {
            assert!(save(
                &store,
                &scope,
                "run-1",
                "thread-one",
                status,
                "created",
                updated_at,
                &payload,
            )
            .is_err());
        }
        let preserved = store
            .with_conn(|tx| get_scoped(tx, &store, &scope, "run-1"))
            .unwrap()
            .unwrap();
        assert_eq!(preserved.status, "completed");
        assert_eq!(preserved.updated_at, "finished-at");
        assert_eq!(preserved.payload, terminal);
    }
}
