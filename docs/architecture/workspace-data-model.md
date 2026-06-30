# Workspace and Project Data Scopes

This document describes Fable's workspace and project ownership models, active-workspace isolation guarantees, persistence boundaries, and developer guidance for adding scoped entities.

## 1. Ownership Models

Fable's durable local ownership root is a **workspace**. Workspaces are top-level silos of user data.
A **project** belongs to exactly one workspace.

All user-owned database records must be associated with a workspace:
- **Workspace-scoped records** carry a valid `workspace_id` and have a `null` `project_id`. They are useful across the entire workspace (e.g., connector accounts, workspace-wide preferences, or shared knowledge sources).
- **Project-scoped records** carry both a `workspace_id` and a `project_id`. The project ID must resolve to a project that belongs to the same workspace.

### The `default` Workspace
The `default` workspace is Fable's stable compatibility workspace. During the v4 schema migration, any pre-workspace records (written before multi-workspace isolation was introduced) are automatically assigned to `default` without deleting or rewriting encrypted payloads. Legacy payloads are decrypted using their original AAD (Additional Authenticated Data) on first read, and subsequently resealed using workspace-bound AAD on write.

---

## 2. Scoping Rules by Entity

| Entity | Scope | SQLite Table | Description |
| :--- | :--- | :--- | :--- |
| **Settings & Preferences** | Workspace-Only | `preferences` | App-wide settings and layout parameters. Project-scoped updates are rejected. |
| **Connectors** | Workspace-Only | `connector_account` | Metadata for third-party connector configurations. Project-scoped configurations are rejected. |
| **Connector Cache** | Workspace-Only | `connector_cache`, `connector_cache_settings` | Secret-free cached item data. Rebuilt per workspace from sources. |
| **Projects** | Workspace-Level Root | `project` | Top-level project entities. Carry a `workspace_id`. |
| **Threads & Messages** | Project-Scoped | `thread`, `message` | Conversations belong strictly to a project. |
| **Runs & Tool Calls** | Project-Scoped | `run`, `tool_call`, `approval` | Execution runs and approval records inherit the project scope. |
| **Knowledge Sources** | Workspace or Project | `knowledge_source` | Sources can belong to the entire workspace or be scoped to a specific project. |
| **Memory Records** | Workspace or Project | `memory_record` | Fact memories can belong to the entire workspace or be scoped to a specific project. |
| **Schedules & Jobs** | Workspace or Project | `schedule`, `scheduled_job` | Automation schedules can run at the workspace level or project level. |
| **Workflows** | Workspace or Project | `workflow_definition`, `workflow_run` | Definitions and run logs can be workspace-wide or project-scoped. |

---

## 3. Active-Workspace Isolation Guarantees

Isolation is enforced at the domain and repository layers using the `DataScope` struct.

### SQL Query Predicate Enforcement
Repositories validate the workspace and, when supplied, the workspace/project relationship before permitting database access.
- For **Workspace-scoped** operations, queries filter on `workspace_id = ? AND project_id IS NULL` (in SQL, `project_id IS ?` where the parameter is `None`).
- For **Project-scoped** operations, queries filter on `workspace_id = ? AND project_id = ?`.
- **Workspace-level queries intentionally do not return project-scoped rows.** Callers must explicitly specify the target project scope to fetch project-scoped records.

### Cross-Workspace Protection Invariants
1. **No Shared Keyring References**: A connector account's keyring reference (`credential_ref`, pointing to OS secure credentials) cannot be shared across workspaces. Attempts to register the same credential reference in a different workspace are rejected at the storage layer to prevent cross-workspace identity theft.
2. **Strict Record Ownership Protection**: The helper function `ensure_record_owner` checks existing records before write. An ID owned by workspace A cannot be modified, claimed, or deleted by a query using workspace B. Cross-workspace deletes are treated as no-ops instead of failing, preventing leakage.
3. **Fails Closed on Missing Workspaces**: Connector credentials commands and commands targeting non-existent workspaces will fail closed (returning an error) instead of falling back to the `default` workspace.
4. **Portable Archive Isolation**: Workspace export traverses project-owned descendants through the target workspace and binds directly scoped sections to the same workspace. Import validates project ownership before mutation and rejects cross-workspace ID takeovers.

---

## 4. Developer Guidance

When adding new workspace-owned entities or writing repository queries, follow these guidelines to avoid unscoped queries and maintain workspace boundaries:

### A. Use `DataScope`
Every repository method that reads, writes, or deletes user-owned records **must** take a `&DataScope` argument. Never pass raw workspace or project IDs as strings to repositories.

```rust
pub fn list_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope
) -> Result<Vec<MyRecord>> {
    // 1. Always validate that the workspace/project exist and are related
    scope.ensure_exists(tx)?;

    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, project_id, payload, payload_nonce
         FROM my_table
         WHERE workspace_id = ?1 AND project_id IS ?2;"
    )?;

    // 2. Bind workspace_id and project_id from the DataScope
    let rows = stmt.query_map(rusqlite::params![
        scope.workspace_id(),
        scope.project_id()
    ], |row| {
        // ...
    })?;
    // ...
}
```

### B. Register Ownership Checks
For tables where records have unique global IDs (e.g. `knowledge_source`, `memory_record`, `schedule`), ensure you register your table in `repos::scope::ensure_record_owner` and call it during inserts/updates:

```rust
// In apps/desktop/src-tauri/src/store/repos/scope.rs:
pub fn ensure_record_owner(
    conn: &Connection,
    table: &str,
    id: &str,
    scope: &DataScope,
) -> Result<()> {
    let sql = match table {
        "knowledge_source" => "SELECT workspace_id, project_id FROM knowledge_source WHERE id=?1;",
        "my_new_table" => "SELECT workspace_id, project_id FROM my_new_table WHERE id=?1;",
        // ...
    };
    // ...
}
```

Then in your repository write path, call:
```rust
ensure_record_owner(tx, "my_new_table", &id, scope)?;
```

### C. Reject Out-of-Scope Options Explicitly
If your table does not support project-level scoping (like `preferences` or `connector_account`), validate and return an error:

```rust
if scope.project_id().is_some() {
    return Err(StoreError::Invalid(
        "My entity is workspace-scoped and cannot use a project scope.".into()
    ));
}
```

### D. Avoid Unscoped SQL Queries
Never write queries without a `workspace_id` predicate. Do not use queries like `SELECT * FROM table WHERE id = ?1` unless you also filter by `workspace_id` or verify ownership first. Unscoped queries violate the isolation guarantees and will fail reviews.
