//! Durable, secret-free hosted workspace directory and active selection.
//!
//! Convex remains authoritative for the records mirrored here. This repository
//! only persists the latest authoritative summary for one internal user and
//! enforces that a locally remembered selection still belongs to that user and
//! remains active before it can scope local work.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::repos::{scope::normalize_id, workspace};
use crate::store::{Result, StoreError};

const WORKSPACE_STATUSES: &[&str] = &["active", "locked", "pending-deletion", "deleted"];
const MEMBERSHIP_STATUSES: &[&str] = &["active", "suspended", "removed"];
const ROLES: &[&str] = &["owner", "admin", "editor", "viewer"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryUpsert {
    pub internal_user_id: String,
    pub fable_workspace_id: String,
    pub name: String,
    pub workspace_status: String,
    pub workspace_revision: i64,
    pub policy_revision: i64,
    pub member_id: String,
    pub role: String,
    pub membership_status: String,
    pub membership_revision: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectorySummary {
    pub fable_workspace_id: String,
    pub local_workspace_id: String,
    pub name: String,
    pub workspace_status: String,
    pub workspace_revision: i64,
    pub policy_revision: i64,
    pub member_id: String,
    pub role: String,
    pub membership_status: String,
    pub membership_revision: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkspaceSelection {
    pub local_workspace_id: String,
    pub fable_workspace_id: Option<String>,
    pub name: String,
    pub source: String,
}

/// Native-only authorization context for commands that read or mutate
/// workspace-owned data. The current user binding is established by the
/// authenticated bootstrap and can never be supplied by a webview caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedWorkspaceContext {
    pub active_workspace: ActiveWorkspaceSelection,
    pub internal_user_id: String,
    pub member_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeviceMirrorUpsert {
    pub device_id: String,
    pub kind: String,
    pub label: String,
    pub status: String,
    pub registered_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeviceSummary {
    pub device_id: String,
    pub kind: String,
    pub label: String,
    pub status: String,
    pub registered_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

struct ExistingWorkspaceMirror {
    name: String,
    status: String,
    revision: i64,
    policy_revision: i64,
}

struct ExistingMembershipMirror {
    member_id: String,
    internal_user_id: String,
    role: String,
    status: String,
    revision: i64,
}

pub fn upsert_authoritative_summary(
    conn: &Connection,
    input: &WorkspaceDirectoryUpsert,
) -> Result<WorkspaceDirectorySummary> {
    validate_input(input)?;
    let local_workspace_id = existing_local_workspace_id(conn, &input.fable_workspace_id)?
        .unwrap_or_else(|| hosted_local_workspace_id(&input.fable_workspace_id));

    ensure_local_workspace_is_available(conn, &local_workspace_id, &input.fable_workspace_id)?;
    ensure_workspace_update_is_monotonic(conn, input)?;
    ensure_internal_user_is_active_or_new(conn, &input.internal_user_id)?;

    let existing_member =
        existing_membership_for_user(conn, &input.fable_workspace_id, &input.internal_user_id)?;
    if existing_member
        .as_ref()
        .is_some_and(|member| member.member_id != input.member_id)
    {
        return Err(StoreError::Invalid(
            "The hosted membership id changed locally; refresh its authoritative mirror before selecting it."
                .into(),
        ));
    }
    if let Some(existing_member) =
        existing_membership_by_id(conn, &input.fable_workspace_id, &input.member_id)?
    {
        if existing_member.internal_user_id != input.internal_user_id {
            return Err(StoreError::Invalid(
                "The hosted membership is already bound to another internal user.".into(),
            ));
        }
        ensure_membership_update_is_monotonic(&existing_member, input)?;
    }

    // All revision and payload checks run before this local ownership row can
    // be renamed. A stale hosted response therefore cannot change either the
    // visible name or the active/inactive authorization state.
    workspace::upsert(conn, &local_workspace_id, &input.name, &input.updated_at)?;
    conn.execute(
        "INSERT INTO fable_internal_user_mirror
           (internal_user_id, status, revision, updated_at)
         VALUES (?1, 'active', ?2, ?3)
         ON CONFLICT(internal_user_id) DO NOTHING;",
        rusqlite::params![
            input.internal_user_id,
            input.membership_revision,
            input.updated_at
        ],
    )?;
    conn.execute(
        "INSERT INTO fable_workspace_mirror
           (fable_workspace_id, local_workspace_id, status, revision, policy_revision, deleted_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?3='deleted' THEN ?6 ELSE '' END, ?6)
         ON CONFLICT(fable_workspace_id) DO UPDATE SET
           status=excluded.status,
           revision=excluded.revision,
           policy_revision=excluded.policy_revision,
           deleted_at=excluded.deleted_at,
           updated_at=excluded.updated_at;",
        rusqlite::params![
            input.fable_workspace_id,
            local_workspace_id,
            input.workspace_status,
            input.workspace_revision,
            input.policy_revision,
            input.updated_at
        ],
    )?;
    conn.execute(
        "INSERT INTO fable_membership_mirror
           (fable_workspace_id, member_id, internal_user_id, role, status, revision, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(fable_workspace_id, member_id) DO UPDATE SET
           role=excluded.role, status=excluded.status, revision=excluded.revision,
           updated_at=excluded.updated_at;",
        rusqlite::params![
            input.fable_workspace_id,
            input.member_id,
            input.internal_user_id,
            input.role,
            input.membership_status,
            input.membership_revision,
            input.updated_at
        ],
    )?;

    // A revoked, suspended, locked, or deleted record must never remain the
    // remembered scope. Once no active hosted selection remains, resolution
    // intentionally falls back to the legacy local workspace.
    if input.workspace_status != "active" || input.membership_status != "active" {
        conn.execute(
            "DELETE FROM active_workspace_selection
             WHERE internal_user_id=?1 AND fable_workspace_id=?2;",
            rusqlite::params![input.internal_user_id, input.fable_workspace_id],
        )?;
    }

    summary_for_user(conn, &input.internal_user_id, &input.fable_workspace_id)?.ok_or_else(|| {
        StoreError::Invalid("The hosted workspace summary could not be read after saving.".into())
    })
}

fn ensure_workspace_update_is_monotonic(
    conn: &Connection,
    input: &WorkspaceDirectoryUpsert,
) -> Result<()> {
    let existing = conn
        .query_row(
            "SELECT local.name, w.status, w.revision, w.policy_revision
             FROM fable_workspace_mirror AS w
             JOIN workspace AS local ON local.id=w.local_workspace_id
             WHERE w.fable_workspace_id=?1;",
            [&input.fable_workspace_id],
            |row| {
                Ok(ExistingWorkspaceMirror {
                    name: row.get(0)?,
                    status: row.get(1)?,
                    revision: row.get(2)?,
                    policy_revision: row.get(3)?,
                })
            },
        )
        .optional()?;
    let Some(existing) = existing else {
        return Ok(());
    };
    if input.workspace_revision < existing.revision
        || input.policy_revision < existing.policy_revision
    {
        return Err(StoreError::Invalid(
            "A stale hosted workspace summary cannot replace the local mirror.".into(),
        ));
    }
    if input.workspace_revision == existing.revision
        && (input.name != existing.name || input.workspace_status != existing.status)
    {
        return Err(StoreError::Invalid(
            "A conflicting hosted workspace summary has the same revision as the local mirror."
                .into(),
        ));
    }
    Ok(())
}

fn ensure_internal_user_is_active_or_new(conn: &Connection, internal_user_id: &str) -> Result<()> {
    let status = conn
        .query_row(
            "SELECT status FROM fable_internal_user_mirror WHERE internal_user_id=?1;",
            [internal_user_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if status.as_deref().is_some_and(|status| status != "active") {
        return Err(StoreError::Invalid(
            "An inactive internal user cannot update the hosted workspace mirror.".into(),
        ));
    }
    Ok(())
}

fn ensure_membership_update_is_monotonic(
    existing: &ExistingMembershipMirror,
    input: &WorkspaceDirectoryUpsert,
) -> Result<()> {
    if input.membership_revision < existing.revision {
        return Err(StoreError::Invalid(
            "A stale hosted membership summary cannot replace the local mirror.".into(),
        ));
    }
    if input.membership_revision == existing.revision
        && (input.role != existing.role || input.membership_status != existing.status)
    {
        return Err(StoreError::Invalid(
            "A conflicting hosted membership summary has the same revision as the local mirror."
                .into(),
        ));
    }
    Ok(())
}

pub fn list_authoritative_summaries(
    conn: &Connection,
    internal_user_id: &str,
) -> Result<Vec<WorkspaceDirectorySummary>> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    let mut stmt = conn.prepare(
        "SELECT w.fable_workspace_id, w.local_workspace_id, local.name,
                w.status, w.revision, w.policy_revision, m.member_id, m.role, m.status,
                m.revision, MAX(w.updated_at, m.updated_at)
         FROM fable_membership_mirror AS m
         JOIN fable_workspace_mirror AS w ON w.fable_workspace_id=m.fable_workspace_id
         JOIN workspace AS local ON local.id=w.local_workspace_id
         JOIN fable_internal_user_mirror AS u ON u.internal_user_id=m.internal_user_id
         WHERE m.internal_user_id=?1 AND u.status='active'
           AND w.status='active' AND m.status='active'
         ORDER BY local.name COLLATE NOCASE, w.fable_workspace_id;",
    )?;
    let rows = stmt.query_map([internal_user_id], read_summary)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Reconciles one account's active hosted inventory. Entries omitted from a
/// freshly authenticated `listMine` response are retained for history but are
/// no longer local authority: their membership is marked removed and any
/// remembered selection is cleared in the same transaction.
pub fn reconcile_active_workspace_inventory(
    conn: &Connection,
    internal_user_id: &str,
    active_fable_workspace_ids: &[String],
    observed_at: &str,
) -> Result<()> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    if observed_at.trim().is_empty() {
        return Err(StoreError::Invalid(
            "Hosted inventory observation time is required.".into(),
        ));
    }
    let mut active = std::collections::BTreeSet::new();
    for fable_workspace_id in active_fable_workspace_ids {
        normalize_id(fable_workspace_id, "Hosted workspace")?;
        if !active.insert(fable_workspace_id) {
            return Err(StoreError::Invalid(
                "Hosted workspace inventory contains a duplicate id.".into(),
            ));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT fable_workspace_id FROM fable_membership_mirror
         WHERE internal_user_id=?1 AND status <> 'removed';",
    )?;
    let missing = stmt
        .query_map([internal_user_id.as_str()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|workspace_id| !active.contains(workspace_id))
        .collect::<Vec<_>>();
    for workspace_id in missing {
        conn.execute(
            "UPDATE fable_membership_mirror
             SET status='removed', updated_at=?1
             WHERE internal_user_id=?2 AND fable_workspace_id=?3;",
            rusqlite::params![observed_at, internal_user_id, workspace_id],
        )?;
        conn.execute(
            "DELETE FROM active_workspace_selection
             WHERE internal_user_id=?1 AND fable_workspace_id=?2;",
            rusqlite::params![internal_user_id, workspace_id],
        )?;
    }
    Ok(())
}

/// Returns `None` until the native authenticated-account adapter establishes
/// a current internal-user binding. No webview-facing caller supplies or reads
/// that binding.
pub fn list_authoritative_summaries_for_current_user(
    conn: &Connection,
) -> Result<Option<Vec<WorkspaceDirectorySummary>>> {
    current_internal_user_id(conn)?
        .map(|internal_user_id| list_authoritative_summaries(conn, &internal_user_id))
        .transpose()
}

pub fn select_active_workspace(
    conn: &Connection,
    internal_user_id: &str,
    fable_workspace_id: &str,
    selected_at: &str,
) -> Result<ActiveWorkspaceSelection> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    let fable_workspace_id = normalize_id(fable_workspace_id, "Hosted workspace")?;
    let summary =
        selectable_summary(conn, &internal_user_id, &fable_workspace_id)?.ok_or_else(|| {
            StoreError::Invalid(
                "The requested hosted workspace is unavailable for this user.".into(),
            )
        })?;
    conn.execute(
        "INSERT INTO active_workspace_selection
           (internal_user_id, local_workspace_id, fable_workspace_id, selected_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(internal_user_id) DO UPDATE SET
           local_workspace_id=excluded.local_workspace_id,
           fable_workspace_id=excluded.fable_workspace_id,
           selected_at=excluded.selected_at;",
        rusqlite::params![
            internal_user_id,
            summary.local_workspace_id,
            summary.fable_workspace_id,
            selected_at
        ],
    )?;
    Ok(ActiveWorkspaceSelection {
        local_workspace_id: summary.local_workspace_id,
        fable_workspace_id: Some(summary.fable_workspace_id),
        name: summary.name,
        source: "hosted".into(),
    })
}

/// Establishes the one native current-account binding after authenticated
/// hosted bootstrap. This is intentionally Rust-only: webview IPC must never
/// be able to assert an arbitrary internal user id.
pub fn set_current_internal_user(
    conn: &Connection,
    internal_user_id: &str,
    established_at: &str,
) -> Result<()> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    let active: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM fable_internal_user_mirror
           WHERE internal_user_id=?1 AND status='active'
         );",
        [internal_user_id.as_str()],
        |row| row.get(0),
    )?;
    if !active {
        return Err(StoreError::Invalid(
            "The authenticated internal user is unavailable.".into(),
        ));
    }
    if established_at.trim().is_empty() {
        return Err(StoreError::Invalid(
            "Current account establishment time is required.".into(),
        ));
    }
    conn.execute(
        "INSERT INTO current_internal_user (singleton, internal_user_id, established_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(singleton) DO UPDATE SET
           internal_user_id=excluded.internal_user_id,
           established_at=excluded.established_at;",
        rusqlite::params![internal_user_id, established_at],
    )?;
    Ok(())
}

/// Clears only the currently active native account binding. Remembered
/// per-account selections deliberately remain for a later authenticated return.
pub fn clear_current_internal_user(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM current_internal_user WHERE singleton=1;", [])?;
    Ok(())
}

pub fn upsert_account_device_summaries(
    conn: &Connection,
    internal_user_id: &str,
    devices: &[AccountDeviceMirrorUpsert],
    observed_at: &str,
) -> Result<()> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    if observed_at.trim().is_empty() {
        return Err(StoreError::Invalid(
            "Device observation time is required.".into(),
        ));
    }
    let active: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM fable_internal_user_mirror WHERE internal_user_id=?1 AND status='active');",
        [internal_user_id.as_str()],
        |row| row.get(0),
    )?;
    if !active {
        return Err(StoreError::Invalid(
            "The authenticated internal user is unavailable.".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for device in devices {
        normalize_id(&device.device_id, "Device")?;
        if !seen.insert(&device.device_id)
            || !["desktop", "mobile", "web"].contains(&device.kind.as_str())
            || !["pending", "active", "revoked"].contains(&device.status.as_str())
            || device.label.trim().is_empty()
            || device.registered_at.trim().is_empty()
        {
            return Err(StoreError::Invalid(
                "Hosted account device summary is invalid.".into(),
            ));
        }
        if device.status != "revoked" && device.revoked_at.is_some() {
            return Err(StoreError::Invalid(
                "Hosted active device has a revocation time.".into(),
            ));
        }
        let existing_owner = conn
            .query_row(
                "SELECT internal_user_id FROM fable_device_mirror WHERE device_id=?1;",
                [&device.device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing_owner
            .as_deref()
            .is_some_and(|owner| owner != internal_user_id)
        {
            return Err(StoreError::Invalid(
                "A hosted account device is already bound to another internal user.".into(),
            ));
        }
        conn.execute(
            "INSERT INTO fable_device_mirror
               (device_id, internal_user_id, status, revision, kind, label, registered_at, last_seen_at, revoked_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(device_id) DO UPDATE SET
               status=excluded.status, kind=excluded.kind, label=excluded.label, registered_at=excluded.registered_at,
               last_seen_at=excluded.last_seen_at, revoked_at=excluded.revoked_at,
               updated_at=excluded.updated_at;",
            rusqlite::params![device.device_id, internal_user_id, device.status, device.kind, device.label, device.registered_at, device.last_seen_at, device.revoked_at, observed_at],
        )?;
    }
    // The account-scoped hosted list is authoritative. Missing local entries
    // are fail-closed rather than treated as active offline authority.
    let mut stmt = conn.prepare(
        "SELECT device_id FROM fable_device_mirror WHERE internal_user_id=?1 AND status <> 'revoked';",
    )?;
    let existing = stmt
        .query_map([internal_user_id.as_str()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for device_id in existing
        .into_iter()
        .filter(|device_id| !seen.contains(device_id))
    {
        conn.execute(
            "UPDATE fable_device_mirror
             SET status='revoked', revoked_at=COALESCE(NULLIF(revoked_at, ''), ?1), updated_at=?1
             WHERE device_id=?2;",
            rusqlite::params![observed_at, device_id],
        )?;
    }
    Ok(())
}

pub fn list_account_device_summaries_for_current_user(
    conn: &Connection,
) -> Result<Option<Vec<AccountDeviceSummary>>> {
    let Some(internal_user_id) = current_internal_user_id(conn)? else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT device_id, kind, label, status, registered_at, last_seen_at, revoked_at
         FROM fable_device_mirror WHERE internal_user_id=?1 ORDER BY device_id;",
    )?;
    let rows = stmt.query_map([internal_user_id], |row| {
        Ok(AccountDeviceSummary {
            device_id: row.get(0)?,
            kind: row.get(1)?,
            label: row.get(2)?,
            status: row.get(3)?,
            registered_at: row.get(4)?,
            last_seen_at: row.get(5)?,
            revoked_at: row.get(6)?,
        })
    })?;
    Ok(Some(rows.collect::<rusqlite::Result<Vec<_>>>()?))
}

pub fn select_active_workspace_for_current_user(
    conn: &Connection,
    fable_workspace_id: &str,
    selected_at: &str,
) -> Result<ActiveWorkspaceSelection> {
    let internal_user_id = current_internal_user_id(conn)?.ok_or_else(|| {
        StoreError::Invalid(
            "A hosted Mivlet account is required to select a hosted workspace.".into(),
        )
    })?;
    select_active_workspace(conn, &internal_user_id, fable_workspace_id, selected_at)
}

pub fn resolve_active_workspace_for_current_user(
    conn: &Connection,
) -> Result<Option<ActiveWorkspaceSelection>> {
    current_internal_user_id(conn)?
        .map(|internal_user_id| resolve_active_workspace(conn, &internal_user_id))
        .transpose()
}

pub fn selected_active_workspace_for_current_user(
    conn: &Connection,
) -> Result<Option<ActiveWorkspaceSelection>> {
    let Some(internal_user_id) = current_internal_user_id(conn)? else {
        return Ok(None);
    };
    selected_active_workspace(conn, &internal_user_id)
}

pub fn unbound_workspace_selection() -> ActiveWorkspaceSelection {
    ActiveWorkspaceSelection {
        local_workspace_id: String::new(),
        fable_workspace_id: None,
        name: "No workspace selected".into(),
        source: "unbound".into(),
    }
}

/// Resolves the active workspace only when an authenticated internal user and
/// an explicit hosted selection are currently bound. It deliberately fails
/// closed after sign-out or before selection.
pub fn require_active_workspace_context_for_current_user(
    conn: &Connection,
) -> Result<AuthorizedWorkspaceContext> {
    let internal_user_id = current_internal_user_id(conn)?
        .ok_or_else(|| StoreError::Invalid("Sign in to access workspace data.".into()))?;
    let active_workspace = resolve_active_workspace(conn, &internal_user_id)?;
    let member_id = match active_workspace.fable_workspace_id.as_deref() {
        Some(fable_workspace_id) => Some(
            selectable_summary(conn, &internal_user_id, fable_workspace_id)?
                .ok_or_else(|| {
                    StoreError::Invalid("The active workspace is unavailable for this user.".into())
                })?
                .member_id,
        ),
        None => None,
    };
    Ok(AuthorizedWorkspaceContext {
        active_workspace,
        internal_user_id,
        member_id,
    })
}

pub fn require_active_workspace_for_current_user(
    conn: &Connection,
) -> Result<ActiveWorkspaceSelection> {
    require_active_workspace_context_for_current_user(conn).map(|context| context.active_workspace)
}

pub fn resolve_active_workspace(
    conn: &Connection,
    internal_user_id: &str,
) -> Result<ActiveWorkspaceSelection> {
    selected_active_workspace(conn, internal_user_id)?.ok_or_else(|| {
        StoreError::Invalid("Select an available workspace before accessing workspace data.".into())
    })
}

fn selected_active_workspace(
    conn: &Connection,
    internal_user_id: &str,
) -> Result<Option<ActiveWorkspaceSelection>> {
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    let selected = conn
        .query_row(
            "SELECT fable_workspace_id FROM active_workspace_selection WHERE internal_user_id=?1;",
            [internal_user_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(fable_workspace_id) = selected {
        let summary = selectable_summary(conn, &internal_user_id, &fable_workspace_id)?
            .ok_or_else(|| {
                StoreError::Invalid(
                    "The remembered hosted workspace is no longer available for this user.".into(),
                )
            })?;
        return Ok(Some(ActiveWorkspaceSelection {
            local_workspace_id: summary.local_workspace_id,
            fable_workspace_id: Some(summary.fable_workspace_id),
            name: summary.name,
            source: "hosted".into(),
        }));
    }

    Ok(None)
}

pub(crate) fn current_internal_user_id(conn: &Connection) -> Result<Option<String>> {
    conn.query_row(
        "SELECT u.internal_user_id
         FROM current_internal_user AS current
         JOIN fable_internal_user_mirror AS u ON u.internal_user_id=current.internal_user_id
         WHERE current.singleton=1 AND u.status='active';",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn summary_for_user(
    conn: &Connection,
    internal_user_id: &str,
    fable_workspace_id: &str,
) -> Result<Option<WorkspaceDirectorySummary>> {
    conn.query_row(
        "SELECT w.fable_workspace_id, w.local_workspace_id, local.name,
                w.status, w.revision, w.policy_revision, m.member_id, m.role, m.status,
                m.revision, MAX(w.updated_at, m.updated_at)
         FROM fable_membership_mirror AS m
         JOIN fable_workspace_mirror AS w ON w.fable_workspace_id=m.fable_workspace_id
         JOIN workspace AS local ON local.id=w.local_workspace_id
         WHERE m.internal_user_id=?1 AND m.fable_workspace_id=?2;",
        rusqlite::params![internal_user_id, fable_workspace_id],
        read_summary,
    )
    .optional()
    .map_err(Into::into)
}

fn selectable_summary(
    conn: &Connection,
    internal_user_id: &str,
    fable_workspace_id: &str,
) -> Result<Option<WorkspaceDirectorySummary>> {
    conn.query_row(
        "SELECT w.fable_workspace_id, w.local_workspace_id, local.name,
                w.status, w.revision, w.policy_revision, m.member_id, m.role, m.status,
                m.revision, MAX(w.updated_at, m.updated_at)
         FROM fable_membership_mirror AS m
         JOIN fable_workspace_mirror AS w ON w.fable_workspace_id=m.fable_workspace_id
         JOIN workspace AS local ON local.id=w.local_workspace_id
         JOIN fable_internal_user_mirror AS u ON u.internal_user_id=m.internal_user_id
         WHERE m.internal_user_id=?1 AND m.fable_workspace_id=?2
           AND u.status='active' AND w.status='active' AND m.status='active';",
        rusqlite::params![internal_user_id, fable_workspace_id],
        read_summary,
    )
    .optional()
    .map_err(Into::into)
}

fn existing_membership_for_user(
    conn: &Connection,
    fable_workspace_id: &str,
    internal_user_id: &str,
) -> Result<Option<ExistingMembershipMirror>> {
    conn.query_row(
        "SELECT member_id, internal_user_id, role, status, revision
         FROM fable_membership_mirror
         WHERE fable_workspace_id=?1 AND internal_user_id=?2;",
        rusqlite::params![fable_workspace_id, internal_user_id],
        read_existing_membership,
    )
    .optional()
    .map_err(Into::into)
}

fn existing_membership_by_id(
    conn: &Connection,
    fable_workspace_id: &str,
    member_id: &str,
) -> Result<Option<ExistingMembershipMirror>> {
    conn.query_row(
        "SELECT member_id, internal_user_id, role, status, revision
         FROM fable_membership_mirror
         WHERE fable_workspace_id=?1 AND member_id=?2;",
        rusqlite::params![fable_workspace_id, member_id],
        read_existing_membership,
    )
    .optional()
    .map_err(Into::into)
}

fn existing_local_workspace_id(
    conn: &Connection,
    fable_workspace_id: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT local_workspace_id FROM fable_workspace_mirror WHERE fable_workspace_id=?1;",
        [fable_workspace_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn ensure_local_workspace_is_available(
    conn: &Connection,
    local_workspace_id: &str,
    fable_workspace_id: &str,
) -> Result<()> {
    let existing_fable_workspace = conn
        .query_row(
            "SELECT fable_workspace_id FROM fable_workspace_mirror WHERE local_workspace_id=?1;",
            [local_workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing_fable_workspace
        .as_deref()
        .is_some_and(|existing| existing != fable_workspace_id)
    {
        return Err(StoreError::Invalid(
            "The local hosted workspace directory id is already bound to another workspace.".into(),
        ));
    }
    if existing_fable_workspace.is_none() && workspace::get(conn, local_workspace_id)?.is_some() {
        return Err(StoreError::Invalid(
            "The local hosted workspace directory id is already in use.".into(),
        ));
    }
    Ok(())
}

fn hosted_local_workspace_id(fable_workspace_id: &str) -> String {
    let digest = Sha256::digest(fable_workspace_id.as_bytes());
    format!("hosted-{}", hex::encode(&digest[..20]))
}

fn validate_input(input: &WorkspaceDirectoryUpsert) -> Result<()> {
    normalize_id(&input.internal_user_id, "Internal user")?;
    normalize_id(&input.fable_workspace_id, "Hosted workspace")?;
    normalize_id(&input.member_id, "Member")?;
    if input.name.trim().is_empty() || input.name.chars().count() > 200 {
        return Err(StoreError::Invalid("Workspace name is invalid.".into()));
    }
    if !WORKSPACE_STATUSES.contains(&input.workspace_status.as_str()) {
        return Err(StoreError::Invalid(
            "Hosted workspace status is not recognized.".into(),
        ));
    }
    if !MEMBERSHIP_STATUSES.contains(&input.membership_status.as_str()) {
        return Err(StoreError::Invalid(
            "Hosted membership status is not recognized.".into(),
        ));
    }
    if !ROLES.contains(&input.role.as_str()) {
        return Err(StoreError::Invalid(
            "Hosted workspace role is not recognized.".into(),
        ));
    }
    if input.workspace_revision < 0 || input.policy_revision < 0 || input.membership_revision < 0 {
        return Err(StoreError::Invalid(
            "Hosted workspace revisions cannot be negative.".into(),
        ));
    }
    if input.updated_at.trim().is_empty() {
        return Err(StoreError::Invalid(
            "Hosted workspace update time is required.".into(),
        ));
    }
    Ok(())
}

fn read_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceDirectorySummary> {
    Ok(WorkspaceDirectorySummary {
        fable_workspace_id: row.get(0)?,
        local_workspace_id: row.get(1)?,
        name: row.get(2)?,
        workspace_status: row.get(3)?,
        workspace_revision: row.get(4)?,
        policy_revision: row.get(5)?,
        member_id: row.get(6)?,
        role: row.get(7)?,
        membership_status: row.get(8)?,
        membership_revision: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn read_existing_membership(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExistingMembershipMirror> {
    Ok(ExistingMembershipMirror {
        member_id: row.get(0)?,
        internal_user_id: row.get(1)?,
        role: row.get(2)?,
        status: row.get(3)?,
        revision: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use tempfile::TempDir;

    fn vault() -> Vault {
        Vault::new(&MasterKey::generate().unwrap()).unwrap()
    }

    fn summary(user: &str, workspace: &str, name: &str) -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: user.into(),
            fable_workspace_id: workspace.into(),
            name: name.into(),
            workspace_status: "active".into(),
            workspace_revision: 3,
            policy_revision: 2,
            member_id: format!("member-{user}-{workspace}"),
            role: "editor".into(),
            membership_status: "active".into(),
            membership_revision: 4,
            updated_at: "2026-07-10T12:00:00Z".into(),
        }
    }

    #[test]
    fn directory_isolated_by_internal_user_and_selection_rejects_unowned_workspaces() {
        let store = Store::open_in_memory(vault()).unwrap();
        let alpha = summary("user-alpha", "workspace-alpha", "Alpha");
        let beta = summary("user-beta", "workspace-beta", "Beta");
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &alpha)?;
                upsert_authoritative_summary(conn, &beta)?;
                Ok(())
            })
            .unwrap();

        let alpha_workspaces = store
            .with_conn(|conn| list_authoritative_summaries(conn, "user-alpha"))
            .unwrap();
        assert_eq!(alpha_workspaces.len(), 1);
        assert_eq!(alpha_workspaces[0].fable_workspace_id, "workspace-alpha");
        assert!(store
            .transaction(|conn| {
                select_active_workspace(conn, "user-alpha", "workspace-beta", "now").map(|_| ())
            })
            .is_err());

        let selected = store
            .transaction(|conn| {
                select_active_workspace(conn, "user-alpha", "workspace-alpha", "now")
            })
            .unwrap();
        assert_eq!(selected.source, "hosted");
        assert_eq!(
            store
                .with_conn(|conn| resolve_active_workspace(conn, "user-alpha"))
                .unwrap(),
            selected
        );
    }

    #[test]
    fn missing_selection_and_inactive_targets_fail_closed() {
        let store = Store::open_in_memory(vault()).unwrap();
        assert!(store
            .with_conn(|conn| resolve_active_workspace(conn, "user-alpha"))
            .is_err());
        let mut inactive = summary("user-alpha", "workspace-alpha", "Alpha");
        inactive.membership_status = "suspended".into();
        store
            .transaction(|conn| upsert_authoritative_summary(conn, &inactive).map(|_| ()))
            .unwrap();
        assert!(store
            .transaction(|conn| select_active_workspace(
                conn,
                "user-alpha",
                "workspace-alpha",
                "now"
            )
            .map(|_| ()))
            .is_err());
    }

    #[test]
    fn active_selection_survives_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("workspace.db");
        let vault = vault();
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            let input = summary("user-alpha", "workspace-alpha", "Alpha");
            store
                .transaction(|conn| {
                    upsert_authoritative_summary(conn, &input)?;
                    select_active_workspace(conn, "user-alpha", "workspace-alpha", "now")
                        .map(|_| ())
                })
                .unwrap();
        }
        let store = Store::open(&path, vault).unwrap();
        assert_eq!(
            store
                .with_conn(|conn| resolve_active_workspace(conn, "user-alpha"))
                .unwrap()
                .fable_workspace_id
                .as_deref(),
            Some("workspace-alpha")
        );
    }

    #[test]
    fn stale_or_equal_conflicting_authoritative_summaries_cannot_change_scope() {
        let store = Store::open_in_memory(vault()).unwrap();
        let original = summary("user-alpha", "workspace-alpha", "Alpha");
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &original)?;
                select_active_workspace(conn, "user-alpha", "workspace-alpha", "now").map(|_| ())
            })
            .unwrap();

        // Exact retries are idempotent.
        store
            .transaction(|conn| upsert_authoritative_summary(conn, &original).map(|_| ()))
            .unwrap();

        let mut stale_workspace = original.clone();
        stale_workspace.name = "Stale rename".into();
        stale_workspace.workspace_status = "deleted".into();
        stale_workspace.workspace_revision -= 1;
        assert!(store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &stale_workspace).map(|_| ())
            })
            .is_err());

        let mut stale_membership = original.clone();
        stale_membership.membership_status = "suspended".into();
        stale_membership.membership_revision -= 1;
        assert!(store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &stale_membership).map(|_| ())
            })
            .is_err());

        let mut conflicting_workspace = original.clone();
        conflicting_workspace.name = "Conflicting rename".into();
        assert!(store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &conflicting_workspace).map(|_| ())
            })
            .is_err());

        let mut conflicting_membership = original.clone();
        conflicting_membership.role = "viewer".into();
        assert!(store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &conflicting_membership).map(|_| ())
            })
            .is_err());

        let summary = store
            .with_conn(|conn| list_authoritative_summaries(conn, "user-alpha"))
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(summary.name, "Alpha");
        assert_eq!(summary.workspace_status, "active");
        assert_eq!(summary.role, "editor");
        assert_eq!(summary.membership_status, "active");
        assert_eq!(
            store
                .with_conn(|conn| resolve_active_workspace(conn, "user-alpha"))
                .unwrap()
                .source,
            "hosted"
        );
    }

    #[test]
    fn workspace_and_policy_revisions_can_advance_without_revising_membership() {
        let store = Store::open_in_memory(vault()).unwrap();
        let original = summary("user-alpha", "workspace-alpha", "Alpha");
        store
            .transaction(|conn| upsert_authoritative_summary(conn, &original).map(|_| ()))
            .unwrap();

        let mut workspace_changed = original.clone();
        workspace_changed.workspace_revision += 1;
        workspace_changed.updated_at = "2026-07-10T12:01:00Z".into();
        store
            .transaction(|conn| upsert_authoritative_summary(conn, &workspace_changed).map(|_| ()))
            .unwrap();

        let mut policy_changed = workspace_changed.clone();
        policy_changed.policy_revision += 1;
        policy_changed.updated_at = "2026-07-10T12:02:00Z".into();
        store
            .transaction(|conn| upsert_authoritative_summary(conn, &policy_changed).map(|_| ()))
            .unwrap();

        let current = store
            .with_conn(|conn| list_authoritative_summaries(conn, "user-alpha"))
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(
            current.workspace_revision,
            workspace_changed.workspace_revision
        );
        assert_eq!(current.policy_revision, policy_changed.policy_revision);
        assert_eq!(current.membership_revision, original.membership_revision);
    }

    #[test]
    fn current_account_binding_is_rust_owned_and_requires_an_active_mirrored_user() {
        let store = Store::open_in_memory(vault()).unwrap();
        assert!(store
            .transaction(|conn| set_current_internal_user(conn, "user-alpha", "now"))
            .is_err());
        let input = summary("user-alpha", "workspace-alpha", "Alpha");
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &input)?;
                set_current_internal_user(conn, "user-alpha", "now")
            })
            .unwrap();
        assert!(store
            .with_conn(selected_active_workspace_for_current_user)
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .transaction(|conn| {
                    select_active_workspace_for_current_user(conn, "workspace-alpha", "now")
                })
                .unwrap()
                .source,
            "hosted"
        );
        store
            .transaction(|conn| clear_current_internal_user(conn))
            .unwrap();
        assert!(store
            .with_conn(resolve_active_workspace_for_current_user)
            .unwrap()
            .is_none());
        store
            .transaction(|conn| set_current_internal_user(conn, "user-alpha", "later"))
            .unwrap();
        assert_eq!(
            store
                .with_conn(resolve_active_workspace_for_current_user)
                .unwrap()
                .unwrap()
                .fable_workspace_id
                .as_deref(),
            Some("workspace-alpha")
        );
    }

    #[test]
    fn workspace_data_authorization_fails_closed_after_sign_out_and_preserves_identity() {
        let store = Store::open_in_memory(vault()).unwrap();
        let alpha = summary("user-alpha", "workspace-alpha", "Alpha");
        let beta = summary("user-beta", "workspace-beta", "Beta");
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &alpha)?;
                upsert_authoritative_summary(conn, &beta)?;
                set_current_internal_user(conn, "user-alpha", "now")?;
                select_active_workspace_for_current_user(conn, "workspace-alpha", "now")?;
                Ok(())
            })
            .unwrap();

        let context = store
            .with_conn(require_active_workspace_context_for_current_user)
            .unwrap();
        assert_eq!(context.internal_user_id, "user-alpha");
        assert_eq!(context.member_id.as_deref(), Some(alpha.member_id.as_str()));
        assert_eq!(
            context.active_workspace.fable_workspace_id.as_deref(),
            Some("workspace-alpha")
        );

        store
            .transaction(|tx| clear_current_internal_user(tx))
            .unwrap();
        let error = store
            .with_conn(require_active_workspace_for_current_user)
            .unwrap_err();
        assert!(error.to_string().contains("Sign in"));

        store
            .transaction(|conn| set_current_internal_user(conn, "user-beta", "later"))
            .unwrap();
        let beta_error = store
            .with_conn(require_active_workspace_context_for_current_user)
            .unwrap_err();
        assert!(beta_error
            .to_string()
            .contains("Select an available workspace"));
    }

    #[test]
    fn absent_hosted_inventory_removes_membership_clears_selection_and_rejects_reselect() {
        let store = Store::open_in_memory(vault()).unwrap();
        let alpha = summary("user-alpha", "workspace-alpha", "Alpha");
        let beta = summary("user-alpha", "workspace-beta", "Beta");
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &alpha)?;
                upsert_authoritative_summary(conn, &beta)?;
                set_current_internal_user(conn, "user-alpha", "now")?;
                select_active_workspace_for_current_user(conn, "workspace-beta", "now")?;
                reconcile_active_workspace_inventory(
                    conn,
                    "user-alpha",
                    &["workspace-alpha".into()],
                    "later",
                )
            })
            .unwrap();

        let visible = store
            .with_conn(|conn| list_authoritative_summaries(conn, "user-alpha"))
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].fable_workspace_id, "workspace-alpha");
        assert!(store
            .with_conn(selected_active_workspace_for_current_user)
            .unwrap()
            .is_none());
        assert!(store
            .with_conn(require_active_workspace_for_current_user)
            .is_err());
        assert!(store
            .transaction(|conn| {
                select_active_workspace_for_current_user(conn, "workspace-beta", "later")
                    .map(|_| ())
            })
            .is_err());
        assert_eq!(
            store
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT status FROM fable_membership_mirror
                         WHERE internal_user_id='user-alpha' AND fable_workspace_id='workspace-beta';",
                        [],
                        |row| row.get::<_, String>(0),
                    )?)
                })
                .unwrap(),
            "removed"
        );
    }

    #[test]
    fn account_device_mirror_rejects_cross_user_rebinding() {
        let store = Store::open_in_memory(vault()).unwrap();
        let alpha = summary("user-alpha", "workspace-alpha", "Alpha");
        let beta = summary("user-beta", "workspace-beta", "Beta");
        let device = AccountDeviceMirrorUpsert {
            device_id: "device-shared".into(),
            kind: "desktop".into(),
            label: "Desk".into(),
            status: "active".into(),
            registered_at: "2026-07-10T12:00:00Z".into(),
            last_seen_at: None,
            revoked_at: None,
        };
        store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &alpha)?;
                upsert_authoritative_summary(conn, &beta)?;
                upsert_account_device_summaries(
                    conn,
                    "user-alpha",
                    std::slice::from_ref(&device),
                    "now",
                )
            })
            .unwrap();
        assert!(store
            .transaction(|conn| {
                upsert_account_device_summaries(conn, "user-beta", &[device], "later")
            })
            .is_err());
        assert_eq!(
            store
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT internal_user_id FROM fable_device_mirror WHERE device_id='device-shared';",
                        [],
                        |row| row.get::<_, String>(0),
                    )?)
                })
                .unwrap(),
            "user-alpha"
        );
    }
}
