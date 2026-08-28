//! Stable ownership boundary shared by all user-owned repositories.

use rusqlite::{Connection, OptionalExtension};

use crate::store::{Result, StoreError};

pub const DEFAULT_WORKSPACE_ID: &str = "default";
pub const MAX_OWNER_ID_LEN: usize = 128;
pub const LOCAL_AUTHORITY: &str = "local";
pub const MEMBER_PRIVATE_VISIBILITY: &str = "member-private";
pub const LEGACY_UNOWNED_SUBJECT: &str = "legacy-unowned";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataScope {
    workspace_id: String,
    project_id: Option<String>,
}

/// Native-only access boundary for member-private Knowledge and Memory data.
/// Renderer payloads never construct this value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivateDataScope {
    data: DataScope,
    owner_subject: String,
    owner_member_id: Option<String>,
    owner_internal_user_id: Option<String>,
}

impl PrivateDataScope {
    pub fn for_authenticated_user(
        data: DataScope,
        internal_user_id: &str,
        member_id: Option<&str>,
    ) -> Result<Self> {
        let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
        let owner_member_id = member_id
            .map(|value| normalize_id(value, "Member"))
            .transpose()?;
        let owner_subject = owner_member_id
            .as_ref()
            .map(|id| format!("member:{id}"))
            .unwrap_or_else(|| format!("user:{internal_user_id}"));
        Ok(Self {
            data,
            owner_subject,
            owner_internal_user_id: owner_member_id.is_none().then_some(internal_user_id),
            owner_member_id,
        })
    }

    pub(crate) fn legacy_unowned(data: DataScope) -> Self {
        Self {
            data,
            owner_subject: LEGACY_UNOWNED_SUBJECT.into(),
            owner_member_id: None,
            owner_internal_user_id: None,
        }
    }

    pub fn data(&self) -> &DataScope {
        &self.data
    }

    pub fn workspace_id(&self) -> &str {
        self.data.workspace_id()
    }

    pub fn project_id(&self) -> Option<&str> {
        self.data.project_id()
    }

    pub fn owner_subject(&self) -> &str {
        &self.owner_subject
    }

    pub fn owner_member_id(&self) -> Option<&str> {
        self.owner_member_id.as_deref()
    }

    pub fn owner_internal_user_id(&self) -> Option<&str> {
        self.owner_internal_user_id.as_deref()
    }

    pub fn authority(&self) -> &'static str {
        LOCAL_AUTHORITY
    }

    pub fn visibility(&self) -> &'static str {
        MEMBER_PRIVATE_VISIBILITY
    }

    pub fn ensure_exists(&self, conn: &Connection) -> Result<()> {
        self.data.ensure_exists(conn)
    }
}

impl DataScope {
    pub fn new(workspace_id: impl Into<String>, project_id: Option<String>) -> Result<Self> {
        let workspace_id = normalize_id(&workspace_id.into(), "Workspace")?;
        let project_id = project_id
            .map(|value| normalize_id(&value, "Project"))
            .transpose()?;
        Ok(Self {
            workspace_id,
            project_id,
        })
    }

    pub fn workspace(workspace_id: impl Into<String>) -> Result<Self> {
        Self::new(workspace_id, None)
    }

    pub fn legacy_default() -> Self {
        Self {
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            project_id: None,
        }
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn project_id(&self) -> Option<&str> {
        self.project_id.as_deref()
    }

    pub fn ensure_exists(&self, conn: &Connection) -> Result<()> {
        let workspace_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace WHERE id = ?1);",
            [self.workspace_id()],
            |row| row.get(0),
        )?;
        if !workspace_exists {
            return Err(StoreError::Invalid("Workspace does not exist.".into()));
        }
        if let Some(project_id) = self.project_id() {
            let owner = conn
                .query_row(
                    "SELECT workspace_id FROM project WHERE id = ?1;",
                    [project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if owner.as_deref() != Some(self.workspace_id()) {
                return Err(StoreError::Invalid(
                    "Project does not belong to the supplied workspace.".into(),
                ));
            }
        }
        Ok(())
    }
}

pub fn normalize_id(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_OWNER_ID_LEN
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if !valid {
        return Err(StoreError::Invalid(format!(
            "{label} id must be 1-{MAX_OWNER_ID_LEN} URL-safe characters."
        )));
    }
    Ok(value.to_string())
}

pub(crate) fn ensure_record_owner(
    conn: &Connection,
    table: &str,
    id: &str,
    scope: &DataScope,
) -> Result<()> {
    let sql = match table {
        "knowledge_source" => {
            "SELECT workspace_id, project_id FROM knowledge_source WHERE id=?1 AND workspace_id=?2;"
        }
        "memory_record" => {
            "SELECT workspace_id, project_id FROM memory_record WHERE id=?1 AND workspace_id=?2;"
        }
        "schedule" => "SELECT workspace_id, project_id FROM schedule WHERE id=?1;",
        _ => return Err(StoreError::Invalid("Unknown ownership table.".into())),
    };
    let owner = conn
        .query_row(
            sql,
            rusqlite::params_from_iter(if table == "schedule" {
                vec![id]
            } else {
                vec![id, scope.workspace_id()]
            }),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if owner.as_ref().is_some_and(|(workspace, project)| {
        workspace != scope.workspace_id() || project.as_deref() != scope.project_id()
    }) {
        return Err(StoreError::Invalid(
            "Record id is already owned by another workspace or project.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::{
        connector_account, knowledge_source, memory_record, preferences, workspace,
    };
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn add_workspace(store: &Store, id: &str) {
        store
            .transaction(|tx| workspace::upsert(tx, id, id, "2026-01-01T00:00:00Z"))
            .unwrap();
    }

    #[test]
    fn private_knowledge_and_tombstones_are_owner_qualified() {
        let store = store();
        add_workspace(&store, "shared");
        let data = DataScope::workspace("shared").unwrap();
        let alpha =
            PrivateDataScope::for_authenticated_user(data.clone(), "user-a", Some("member-a"))
                .unwrap();
        let beta =
            PrivateDataScope::for_authenticated_user(data, "user-b", Some("member-b")).unwrap();
        let source = |title: &str| {
            json!({
                "id":"same-content-id", "title":title, "kind":"document", "connectorId":"local-files",
                "trust":"untrusted", "contentFingerprint":"fp", "sizeBytes":1, "origin":"local-import"
            })
        };
        store
            .transaction(|tx| {
                knowledge_source::upsert_private(tx, &store, &alpha, source("Alpha"), "now")?;
                knowledge_source::upsert_private(tx, &store, &beta, source("Beta"), "now")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store
                .with_conn(|tx| knowledge_source::list_private(tx, &store, &alpha))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .with_conn(|tx| knowledge_source::list_private(tx, &store, &beta))
                .unwrap()
                .len(),
            1
        );

        store
            .transaction(|tx| knowledge_source::delete_private(tx, &alpha, "same-content-id"))
            .unwrap();
        assert!(store
            .with_conn(|tx| knowledge_source::list_private(tx, &store, &alpha))
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .with_conn(|tx| knowledge_source::list_private(tx, &store, &beta))
                .unwrap()
                .len(),
            1
        );
        store
            .transaction(|tx| {
                let blocked =
                    knowledge_source::upsert_private(tx, &store, &alpha, source("Again"), "later");
                assert!(blocked
                    .unwrap_err()
                    .to_string()
                    .contains("Deleted knowledge"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn private_ciphertext_cannot_be_substituted_between_owners() {
        let store = store();
        add_workspace(&store, "shared");
        let data = DataScope::workspace("shared").unwrap();
        let alpha =
            PrivateDataScope::for_authenticated_user(data.clone(), "user-a", Some("member-a"))
                .unwrap();
        let beta =
            PrivateDataScope::for_authenticated_user(data, "user-b", Some("member-b")).unwrap();
        let source = |title: &str| {
            json!({
                "id":"same", "title":title, "kind":"document", "connectorId":"local-files",
                "trust":"untrusted", "contentFingerprint":"fp", "sizeBytes":1, "origin":"local-import"
            })
        };
        store.transaction(|tx| {
            knowledge_source::upsert_private(tx, &store, &alpha, source("Alpha"), "now")?;
            knowledge_source::upsert_private(tx, &store, &beta, source("Beta"), "now")?;
            let sealed: (Vec<u8>, Vec<u8>) = tx.query_row(
                "SELECT payload,payload_nonce FROM knowledge_source WHERE workspace_id='shared' AND owner_subject='member:member-a' AND id='same'",
                [], |row| Ok((row.get(0)?,row.get(1)?)))?;
            tx.execute(
                "UPDATE knowledge_source SET payload=?1,payload_nonce=?2 WHERE workspace_id='shared' AND owner_subject='member:member-b' AND id='same'",
                rusqlite::params![sealed.0,sealed.1])?;
            Ok(())
        }).unwrap();
        assert!(store
            .with_conn(|tx| knowledge_source::list_private(tx, &store, &beta))
            .is_err());
    }

    #[test]
    fn private_memory_owner_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite3");
        let vault = Vault::new(&MasterKey::generate().unwrap()).unwrap();
        let store = Store::open(&path, vault.clone()).unwrap();
        add_workspace(&store, "shared");
        let owner = PrivateDataScope::for_authenticated_user(
            DataScope::workspace("shared").unwrap(),
            "user-a",
            Some("member-a"),
        )
        .unwrap();
        store
            .transaction(|tx| {
                memory_record::upsert_private(
                    tx,
                    &store,
                    &owner,
                    json!({
                        "id":"memory", "kind":"fact", "title":"Private", "value":"Value",
                        "approved":true, "createdAt":"now"
                    }),
                    "now",
                )
            })
            .unwrap();
        drop(store);
        let reopened = Store::open(&path, vault).unwrap();
        let rows = reopened
            .with_conn(|tx| memory_record::list_private(tx, &reopened, &owner))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].payload["authorityScope"]["ownerMemberId"],
            "member-a"
        );
    }

    #[test]
    fn settings_with_the_same_key_are_isolated_by_workspace() {
        let store = store();
        add_workspace(&store, "alpha");
        add_workspace(&store, "beta");
        let alpha = DataScope::workspace("alpha").unwrap();
        let beta = DataScope::workspace("beta").unwrap();

        store
            .transaction(|tx| {
                preferences::upsert_scoped(
                    tx,
                    &store,
                    &alpha,
                    "shell",
                    &serde_json::json!({"theme":"light"}),
                    "now",
                )?;
                preferences::upsert_scoped(
                    tx,
                    &store,
                    &beta,
                    "shell",
                    &serde_json::json!({"theme":"dark"}),
                    "now",
                )
            })
            .unwrap();

        let alpha_value = store
            .with_conn(|tx| preferences::get_scoped(tx, &store, &alpha, "shell"))
            .unwrap()
            .unwrap();
        let beta_value = store
            .with_conn(|tx| preferences::get_scoped(tx, &store, &beta, "shell"))
            .unwrap()
            .unwrap();
        assert_eq!(alpha_value["theme"], "light");
        assert_eq!(beta_value["theme"], "dark");
    }

    #[test]
    fn deletion_cascades_chunks_and_pins_and_blocks_resurrection() {
        let store = store();
        add_workspace(&store, "alpha");
        let scope = DataScope::workspace("alpha").unwrap();
        store
            .transaction(|tx| {
                knowledge_source::upsert_from_value_scoped(
                    tx,
                    &store,
                    &scope,
                    serde_json::json!({"id":"source","title":"Alpha","connectorId":"local-files"}),
                    "now",
                )?;
                tx.execute(
                    "INSERT INTO knowledge_chunk
                       (workspace_id, owner_subject, source_id, id, ordinal, content_fingerprint, payload, payload_nonce)
                     VALUES ('alpha', 'legacy-unowned', 'source', 'chunk', 0, 'fp', x'01', x'02');",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO pinned_context
                       (workspace_id, owner_subject, id, source_id, scope_level, pinned_at)
                     VALUES ('alpha', 'legacy-unowned', 'pin', 'source', 'global', 'now');",
                    [],
                )?;
                knowledge_source::delete_scoped(tx, &scope, "source")
            })
            .unwrap();

        store
            .with_conn(|tx| {
                let chunks: i64 =
                    tx.query_row("SELECT COUNT(*) FROM knowledge_chunk", [], |r| r.get(0))?;
                let pins: i64 =
                    tx.query_row("SELECT COUNT(*) FROM pinned_context", [], |r| r.get(0))?;
                assert_eq!((chunks, pins), (0, 0));
                Ok(())
            })
            .unwrap();
        assert!(store
            .transaction(|tx| knowledge_source::upsert_from_value_scoped(
                tx,
                &store,
                &scope,
                serde_json::json!({"id":"source","title":"Resurrected"}),
                "later",
            ))
            .is_err());
    }

    #[test]
    fn disabled_and_forgotten_records_never_enter_live_reads() {
        let store = store();
        add_workspace(&store, "alpha");
        let scope = DataScope::workspace("alpha").unwrap();
        store
            .transaction(|tx| {
                knowledge_source::upsert_from_value_scoped(
                    tx,
                    &store,
                    &scope,
                    serde_json::json!({"id":"disabled","title":"Hidden","disabled":true}),
                    "now",
                )?;
                memory_record::upsert_from_value_scoped(
                    tx,
                    &store,
                    &scope,
                    serde_json::json!({"id":"memory","kind":"fact","title":"Hidden","value":"secret"}),
                    "now",
                )?;
                memory_record::forget_scoped(tx, &scope, "memory", "2026-07-01T00:00:00Z")?;
                Ok(())
            })
            .unwrap();
        assert!(store
            .with_conn(|tx| knowledge_source::list_scoped(tx, &store, &scope))
            .unwrap()
            .is_empty());
        assert!(store
            .with_conn(|tx| memory_record::list_scoped(tx, &store, &scope))
            .unwrap()
            .is_empty());
        assert!(store
            .transaction(|tx| memory_record::upsert_from_value_scoped(
                tx,
                &store,
                &scope,
                serde_json::json!({"id":"memory","kind":"fact","title":"Again","value":"again"}),
                "later",
            ))
            .is_err());
    }

    #[test]
    fn connector_keyring_references_cannot_be_shared_across_workspaces() {
        let store = store();
        add_workspace(&store, "alpha");
        add_workspace(&store, "beta");
        let alpha = DataScope::workspace("alpha").unwrap();
        let beta = DataScope::workspace("beta").unwrap();
        let account = serde_json::json!({
            "connectorId":"github",
            "credentialRef":"oauth-token:alpha:github:1"
        });
        store
            .transaction(|tx| {
                connector_account::upsert_from_value_scoped(
                    tx,
                    &store,
                    &alpha,
                    account.clone(),
                    "now",
                )
            })
            .unwrap();
        assert!(store
            .transaction(|tx| {
                connector_account::upsert_from_value_scoped(tx, &store, &beta, account, "now")
            })
            .is_err());
    }
}
