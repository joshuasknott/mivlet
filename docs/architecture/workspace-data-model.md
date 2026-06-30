# Workspace data ownership

Fable's durable local ownership root is a workspace. Projects belong to exactly
one workspace. User-owned records always carry a `workspace_id`; records that
are useful across a workspace carry a null `project_id`, while project-owned
records carry a project id that must resolve inside the same workspace.

`default` is the stable compatibility workspace. Schema migration v4 assigns
all pre-workspace records to it without deleting or rewriting encrypted
payloads. Legacy payloads use their original encryption associated data on the
first read; a subsequent write reseals them with workspace-bound associated
data.

Domain code uses `DataScope` and typed repositories. Repositories validate the
workspace and, when supplied, the workspace/project relationship before access.
Reads, searches, updates, and deletes include workspace ownership in their SQL
predicate. The desktop currently supplies `default` explicitly until workspace
selection is exposed in the shell.

Settings and connector configuration are workspace-owned. Knowledge, memory,
schedules, workflow definitions, and workflow runs may be workspace-owned or
project-owned. Workspace-level queries intentionally do not include
project-owned rows; callers must supply the project scope explicitly.

The current shell selects `default`. Connector credential commands reject
non-default workspaces until the account-switching UI and workspace-namespaced
keyring lifecycle land; this fails closed instead of returning the default
workspace's connector state. Connector cache data already supports arbitrary
workspace ids and remains query-isolated.

User-authored content remains in the encrypted local store. Connector
credentials remain in the OS credential store and SQLite stores only an opaque
keyring reference. A keyring reference cannot be assigned to multiple
workspaces. Local-data export requires a workspace and exports only that
workspace's document adapter records; connector credentials and workflow
payloads are excluded.

## Dependent branch contract

- Schedule-SQLite should use `DataScope` and `repos::schedule`, and may use the
  v4 `workflow_definition` / `workflow_run` tables. It must preserve the
  workspace/project predicates when adding queue tables.
- Export/import should address one explicit workspace per operation. Project
  ids are meaningful only with their owning workspace. Credential references,
  connector secret state, and encrypted payload bytes are not portable export
  data.
- New tables containing user-owned records must have `workspace_id`; use a
  nullable `project_id` only when workspace-owned records are valid.
