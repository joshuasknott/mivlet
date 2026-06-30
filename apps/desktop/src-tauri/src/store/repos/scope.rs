//! Stable ownership boundary shared by all user-owned repositories.

use rusqlite::{Connection, OptionalExtension};

use crate::store::{Result, StoreError};

pub const DEFAULT_WORKSPACE_ID: &str = "default";
pub const MAX_OWNER_ID_LEN: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataScope {
    workspace_id: String,
    project_id: Option<String>,
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
        "knowledge_source" => "SELECT workspace_id, project_id FROM knowledge_source WHERE id=?1;",
        "memory_record" => "SELECT workspace_id, project_id FROM memory_record WHERE id=?1;",
        "schedule" => "SELECT workspace_id, project_id FROM schedule WHERE id=?1;",
        _ => return Err(StoreError::Invalid("Unknown ownership table.".into())),
    };
    let owner = conn
        .query_row(sql, [id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
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
        connector_account, knowledge_source, memory_record, preferences, schedule, workflow,
        workspace,
    };
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn add_workspace(store: &Store, id: &str) {
        store
            .transaction(|tx| workspace::upsert(tx, id, id, "2026-01-01T00:00:00Z"))
            .unwrap();
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
    fn project_scope_must_belong_to_workspace() {
        let store = store();
        add_workspace(&store, "alpha");
        add_workspace(&store, "beta");
        let alpha = DataScope::workspace("alpha").unwrap();
        let sealed = store.seal_payload(b"{}", "project:p1").unwrap();
        store
            .transaction(|tx| {
                workspace::upsert_project(
                    tx,
                    &alpha,
                    "p1",
                    "fingerprint",
                    "now",
                    &sealed.ciphertext,
                    &sealed.nonce,
                )
            })
            .unwrap();

        assert!(store
            .with_conn(|tx| DataScope::new("alpha", Some("p1".into()))?.ensure_exists(tx))
            .is_ok());
        assert!(store
            .with_conn(|tx| DataScope::new("beta", Some("p1".into()))?.ensure_exists(tx))
            .is_err());
    }

    #[test]
    fn knowledge_memory_schedule_and_workflow_do_not_cross_workspace() {
        let store = store();
        add_workspace(&store, "alpha");
        add_workspace(&store, "beta");
        let alpha = DataScope::workspace("alpha").unwrap();
        let beta = DataScope::workspace("beta").unwrap();

        store
            .transaction(|tx| {
                knowledge_source::upsert_from_value_scoped(
                    tx,
                    &store,
                    &alpha,
                    serde_json::json!({"id":"k1","title":"Alpha","connectorId":"local-files"}),
                    "now",
                )?;
                memory_record::upsert_from_value_scoped(
                    tx,
                    &store,
                    &alpha,
                    serde_json::json!({"id":"m1","kind":"fact","title":"Alpha","value":"private"}),
                    "now",
                )?;
                schedule::upsert_from_value_scoped(
                    tx,
                    &store,
                    &alpha,
                    serde_json::json!({"id":"s1","day":"Mon","time":"09:00","name":"Alpha"}),
                    "now",
                )?;
                workflow::upsert_definition(
                    tx,
                    &store,
                    &alpha,
                    "wf1",
                    1,
                    "now",
                    "now",
                    &serde_json::json!({"id":"wf1","secret":"encrypted"}),
                )
            })
            .unwrap();

        assert_eq!(
            store
                .with_conn(|tx| knowledge_source::list_scoped(tx, &store, &alpha))
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .with_conn(|tx| knowledge_source::list_scoped(tx, &store, &beta))
            .unwrap()
            .is_empty());
        assert!(store
            .with_conn(|tx| memory_record::list_scoped(tx, &store, &beta))
            .unwrap()
            .is_empty());
        assert!(store
            .with_conn(|tx| schedule::list_scoped(tx, &store, &beta))
            .unwrap()
            .is_empty());
        assert!(store
            .with_conn(|tx| workflow::list_definitions(tx, &store, &beta))
            .unwrap()
            .is_empty());

        // A cross-workspace delete is a no-op and cannot remove alpha's row.
        store
            .transaction(|tx| knowledge_source::delete_scoped(tx, &beta, "k1"))
            .unwrap();
        assert_eq!(
            store
                .with_conn(|tx| knowledge_source::list_scoped(tx, &store, &alpha))
                .unwrap()
                .len(),
            1
        );
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
