//! Idempotent feature migration after core migrations. It deliberately does not
//! allocate a competing numbered schema version during concurrent integration.
use crate::store::{Result, StoreError};
use rusqlite::{Connection, OptionalExtension};

pub(crate) fn apply(conn: &Connection) -> Result<()> {
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key='feature:event-automations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version.as_deref().is_some_and(|value| value != "1") {
        return Err(StoreError::Invalid(
            "This event automation storage version is unsupported.".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let schema: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='local_schedule'",
        [],
        |row| row.get(0),
    )?;
    if !schema.contains("CHECK(trigger_kind IN ('once','daily','weekly','event'))") {
        if tx.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))? != 0 {
            return Err(StoreError::Invalid(
                "The event migration requires the store's foreign-key maintenance fence.".into(),
            ));
        }
        let constraint = "CHECK(trigger_kind IN ('once','daily','weekly'))";
        if !schema.contains(constraint) {
            return Err(StoreError::Invalid(
                "The schedule schema needs compatible event-trigger integration.".into(),
            ));
        }
        let open = schema
            .find('(')
            .ok_or_else(|| StoreError::Invalid("The schedule schema is invalid.".into()))?;
        let ddl = format!(
            "CREATE TABLE local_schedule_event_v1 {}",
            schema[open..].replace(
                constraint,
                "CHECK(trigger_kind IN ('once','daily','weekly','event'))"
            )
        );
        let mut statement = tx.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='local_schedule' AND type IN ('index','trigger') AND sql IS NOT NULL")?;
        let dependents = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        tx.execute_batch(&ddl)?;
        tx.execute_batch("INSERT INTO local_schedule_event_v1 SELECT * FROM local_schedule; DROP TABLE local_schedule; ALTER TABLE local_schedule_event_v1 RENAME TO local_schedule;")?;
        for dependent in dependents {
            tx.execute_batch(&dependent)?;
        }
    }
    tx.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS local_event_delivery (
        workspace_id TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        schedule_revision INTEGER NOT NULL,
        fingerprint TEXT,
        body_fingerprint TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','claimed','rejected','paused','expired','removed')),
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        dedup_until TEXT NOT NULL,
        occurrence_id TEXT,
        redacted_at TEXT,
        payload BLOB NOT NULL,
        payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,owner_subject,id),
        FOREIGN KEY(workspace_id,owner_subject,schedule_id) REFERENCES local_schedule(workspace_id,owner_subject,id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_id,owner_subject,occurrence_id) REFERENCES local_schedule_occurrence(workspace_id,owner_subject,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_event_delivery_idempotency ON local_event_delivery(workspace_id,owner_subject,schedule_id,fingerprint) WHERE fingerprint IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_event_delivery_body ON local_event_delivery(workspace_id,owner_subject,schedule_id,body_fingerprint) WHERE body_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_local_event_delivery_pending ON local_event_delivery(workspace_id,owner_subject,schedule_id,state,received_at,id);
      INSERT OR REPLACE INTO schema_meta(key,value) VALUES('feature:event-automations','1');
    "#)?;
    let violation = tx
        .query_row("PRAGMA foreign_key_check", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    if violation.is_some() {
        return Err(StoreError::Corrupt(
            "Event automation migration could not preserve relationships.".into(),
        ));
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_store_startup_applies_events_and_restores_foreign_keys() {
        use crate::store::{
            vault::{MasterKey, Vault},
            Store,
        };
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store.with_conn(|conn| {
            assert_eq!(conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))?, 1);
            assert_eq!(conn.query_row("SELECT value FROM schema_meta WHERE key='feature:event-automations'", [], |row| row.get::<_, String>(0))?, "1");
            let schema: String = conn.query_row("SELECT sql FROM sqlite_master WHERE name='local_schedule'", [], |row| row.get(0))?;
            assert!(schema.contains("CHECK(trigger_kind IN ('once','daily','weekly','event'))"));
            assert!(conn.query_row("PRAGMA foreign_key_check", [], |row| row.get::<_, String>(0)).optional()?.is_none());
            Ok(())
        }).unwrap();
    }

    #[test]
    fn preserves_existing_clock_rows_children_indexes_and_additional_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO schema_meta VALUES('version','42');
            CREATE TABLE local_schedule(workspace_id TEXT NOT NULL,owner_subject TEXT NOT NULL,id TEXT NOT NULL,trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('once','daily','weekly')),payload BLOB NOT NULL,extra_column TEXT,PRIMARY KEY(workspace_id,owner_subject,id));
            CREATE INDEX clock_index ON local_schedule(trigger_kind);
            CREATE TABLE local_schedule_occurrence(workspace_id TEXT NOT NULL,owner_subject TEXT NOT NULL,id TEXT NOT NULL,schedule_id TEXT NOT NULL,PRIMARY KEY(workspace_id,owner_subject,id),FOREIGN KEY(workspace_id,owner_subject,schedule_id) REFERENCES local_schedule(workspace_id,owner_subject,id) ON DELETE CASCADE);
            INSERT INTO local_schedule VALUES('workspace','account','clock','daily',x'0123456789','keep');
            INSERT INTO local_schedule_occurrence VALUES('workspace','account','occurrence','clock');").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        assert!(
            matches!(apply(&conn), Err(StoreError::Invalid(message)) if message.contains("foreign-key maintenance fence"))
        );
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        apply(&conn).unwrap();
        apply(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let preserved: (Vec<u8>, String) = conn
            .query_row(
                "SELECT payload,extra_column FROM local_schedule WHERE id='clock'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(preserved, (vec![1, 35, 69, 103, 137], "keep".into()));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM local_schedule_occurrence",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='clock_index'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT value FROM schema_meta WHERE key='version'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "42"
        );
        assert!(conn
            .query_row("PRAGMA foreign_key_check", [], |row| row
                .get::<_, String>(0))
            .optional()
            .unwrap()
            .is_none());
        conn.execute(
            "INSERT INTO local_schedule VALUES('workspace','account','event','event',x'00',NULL)",
            [],
        )
        .unwrap();
        assert!(conn.execute("INSERT INTO local_event_delivery(workspace_id,owner_subject,id,schedule_id,schedule_revision,state,received_at,expires_at,dedup_until,payload,payload_nonce) VALUES('workspace','account','bad','missing',1,'pending','now','later','later',x'00',x'00')",[]).is_err());
    }

    #[test]
    fn refuses_unknown_feature_versions_without_overwriting_them() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO schema_meta VALUES('feature:event-automations','future');").unwrap();
        assert!(apply(&conn).is_err());
        assert_eq!(
            conn.query_row("SELECT value FROM schema_meta", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "future"
        );
    }
}
