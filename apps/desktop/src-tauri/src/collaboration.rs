//! Account-private teammates and durable coordination. Membership and
//! contributions never grant provider, connector, file or computer authority.
mod capture_summary;
mod chats;
mod commands;
mod context;
pub(crate) mod models;
mod schedules;
mod work;
pub(crate) use schedules::{bind_schedule, finish_schedule, validate_schedule_project};
#[cfg(test)]
mod tests;

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::models::MivletAgentProfile;
use crate::store::repos::{collaboration as repo, collaboration::Kind, local_project, thread};
use crate::store::{Store, StoreError};
use chrono::{SecondsFormat, Utc};
use models::*;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use tauri::Manager;

type Result<T> = crate::store::Result<T>;

/// Project edits share the same transaction as their context invalidation.
pub(crate) fn project_changed(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project: &str,
    time: &str,
    archived: bool,
) -> Result<()> {
    let Some(mut team) = repo::get::<Team>(conn, store, &scope.private, Kind::Team, project)?
    else {
        return Ok(());
    };
    let ctx = Context {
        conn,
        store,
        scope,
        profiles: &[],
        time,
    };
    team.revision += 1;
    ctx.team(&team)?;
    for mut work in ctx.all_work()? {
        if work.project_id.as_deref() == Some(project) && work.status.active() {
            work.generation += 1;
            work.status = if archived {
                WorkStatus::Cancelled
            } else {
                WorkStatus::AwaitingUser
            };
            work.reason = Some(if archived { "This project was archived." } else { "Project instructions or files changed. Review the current context and reconcile prior effects before continuing." }.into());
            work.updated_at = time.into();
            ctx.work(&work)?;
        }
    }
    if let Some(project_row) = local_project::get_project(conn, store, &scope.private, project)? {
        if let Some(mut room) = repo::get::<Conversation>(
            conn,
            store,
            &scope.private,
            Kind::Conversation,
            &project_row.thread_id,
        )? {
            if let Some(name) = project_row
                .payload
                .get("name")
                .and_then(|value| value.as_str())
            {
                room.title = name.into();
            }
            room.updated_at = time.into();
            ctx.conversation(&room)?;
        }
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::Invalid(message.into())
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn bounded(value: &str, max: usize, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(invalid(&format!("{label} must be 1-{max} characters.")));
    }
    Ok(value.into())
}
fn id(value: &str) -> Result<()> {
    bounded(value, 128, "ID")?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(invalid("Invalid coordination ID."));
    }
    Ok(())
}
fn profile<'a>(
    profiles: &'a [MivletAgentProfile],
    agent_id: &str,
) -> Result<&'a MivletAgentProfile> {
    profiles
        .iter()
        .find(|p| p.id == agent_id)
        .ok_or_else(|| invalid("This agent profile is unavailable. Choose an existing teammate."))
}
fn participants(
    profiles: &[MivletAgentProfile],
    ids: &[String],
    facilitator: Option<&str>,
) -> Result<Vec<Participant>> {
    if ids.is_empty()
        || ids.len() > 8
        || facilitator.is_some_and(|lead| !ids.iter().any(|id| id == lead))
    {
        return Err(invalid(
            "Choose one to eight participants. A coordinator, when designated, must be one of them.",
        ));
    }
    let mut seen = HashSet::new();
    ids.iter()
        .map(|agent_id| {
            if !seen.insert(agent_id) {
                return Err(invalid("Each participant can be included only once."));
            }
            let p = profile(profiles, agent_id)?;
            Ok(Participant {
                agent_id: p.id.clone(),
                name: p.name.clone(),
            })
        })
        .collect()
}

struct Context<'a> {
    conn: &'a Connection,
    store: &'a Store,
    scope: &'a AuthorizedCommandScope,
    profiles: &'a [MivletAgentProfile],
    time: &'a str,
}
impl Context<'_> {
    fn put<T: Serialize>(
        &self,
        kind: Kind,
        key: &str,
        conversation: Option<&str>,
        project: Option<&str>,
        value: &T,
    ) -> Result<()> {
        repo::put(
            self.conn,
            self.store,
            &self.scope.private,
            kind,
            key,
            conversation,
            project,
            value,
        )
    }
    fn conversation(&self, room: &Conversation) -> Result<()> {
        self.put(
            Kind::Conversation,
            &room.id,
            Some(&room.id),
            room.project_id.as_deref(),
            room,
        )
    }
    fn work(&self, item: &Work) -> Result<()> {
        self.put(
            Kind::Work,
            &item.id,
            Some(&item.conversation_id),
            item.project_id.as_deref(),
            item,
        )
    }
    fn team(&self, team: &Team) -> Result<()> {
        self.put(
            Kind::Team,
            &team.project_id,
            None,
            Some(&team.project_id),
            team,
        )
    }
    fn fact(&self, fact: &Fact) -> Result<()> {
        self.put(
            Kind::Fact,
            &fact.id,
            Some(&fact.conversation_id),
            Some(&fact.project_id),
            fact,
        )
    }
    fn room(&self, key: &str) -> Result<Conversation> {
        repo::get(
            self.conn,
            self.store,
            &self.scope.private,
            Kind::Conversation,
            key,
        )?
        .ok_or_else(|| invalid("This conversation is unavailable."))
    }
    fn item(&self, key: &str) -> Result<Work> {
        repo::get(self.conn, self.store, &self.scope.private, Kind::Work, key)?
            .ok_or_else(|| invalid("This work item is unavailable."))
    }
    fn project_team(&self, key: &str) -> Result<Team> {
        let project = local_project::get_project(self.conn, self.store, &self.scope.private, key)?
            .ok_or_else(|| invalid("This project is unavailable."))?;
        if project.lifecycle != "active" {
            return Err(invalid("This project is archived."));
        }
        repo::get(self.conn, self.store, &self.scope.private, Kind::Team, key)?
            .ok_or_else(|| invalid("Reload this project's participants."))
    }
    fn all_work(&self) -> Result<Vec<Work>> {
        repo::list(self.conn, self.store, &self.scope.private, Kind::Work)
    }
    fn snapshot(&self) -> Result<Snapshot> {
        Ok(Snapshot {
            conversations: repo::list(
                self.conn,
                self.store,
                &self.scope.private,
                Kind::Conversation,
            )?,
            authors: repo::list(self.conn, self.store, &self.scope.private, Kind::Author)?,
            teams: repo::list(self.conn, self.store, &self.scope.private, Kind::Team)?,
            work: self.all_work()?,
            facts: repo::list(self.conn, self.store, &self.scope.private, Kind::Fact)?,
            layout: repo::get(
                self.conn,
                self.store,
                &self.scope.private,
                Kind::Layout,
                "workspace",
            )?,
        })
    }
    fn create_room(
        &self,
        key: &str,
        title: &str,
        kind: &str,
        members: Vec<Participant>,
        facilitator: Option<String>,
        project: Option<String>,
    ) -> Result<Conversation> {
        id(key)?;
        let title = bounded(title, 120, "Conversation title")?;
        if !["direct", "group"].contains(&kind) || kind == "direct" && members.len() != 1 {
            return Err(invalid("A direct conversation needs exactly one teammate."));
        }
        if kind == "group" && project.is_none() {
            return Err(invalid(
                "Create a project to work with more than one teammate. Standalone groups are retired.",
            ));
        }
        if let Some(project) = &project {
            let team = self.project_team(project)?;
            if members
                .iter()
                .any(|member| !team.participant_ids.contains(&member.agent_id))
            {
                return Err(invalid("Choose participants from this project's team."));
            }
        }
        thread::create(
            self.conn,
            self.store,
            &self.scope.data,
            key,
            None,
            &title,
            self.time,
            &serde_json::json!({"authorityScope":{"authority":"local","visibility":"member-private","ownerMemberId":self.scope.private.owner_member_id()}}),
        )?;
        self.conn.execute("UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3 AND owner_member_id IS NULL", rusqlite::params![self.scope.private.owner_member_id(), self.scope.data.workspace_id(), key])?;
        let room = Conversation {
            chat: project
                .as_ref()
                .map(|project_id| ChatBinding {
                    role: "side".into(),
                    owner_kind: "project".into(),
                    owner_id: project_id.clone(),
                })
                .or_else(|| {
                    (kind == "direct").then(|| ChatBinding {
                        role: "side".into(),
                        owner_kind: "agent".into(),
                        owner_id: members[0].agent_id.clone(),
                    })
                }),
            id: key.into(),
            workspace_id: self.scope.data.workspace_id().into(),
            kind: kind.into(),
            title,
            project_id: project,
            facilitator_id: facilitator,
            participants: members,
            revision: 1,
            generation: 1,
            archived: false,
            created_at: self.time.into(),
            updated_at: self.time.into(),
        };
        self.conversation(&room)?;
        Ok(room)
    }
}

pub(crate) fn native_profiles(
    app: tauri::AppHandle,
    workspace: &str,
) -> std::result::Result<Vec<MivletAgentProfile>, String> {
    Ok(
        crate::snapshot::load_runtime_snapshot(app, Some(workspace.into()), None)?
            .map(|s| s.agents)
            .unwrap_or_default(),
    )
}
fn main_window(window: &tauri::WebviewWindow) -> std::result::Result<(), String> {
    if window.label() != "main" {
        return Err("Manage conversations from the Mivlet window.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn collaboration_load(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: LoadRequest,
) -> std::result::Result<Snapshot, String> {
    main_window(&window)?;
    let profiles = native_profiles(app, &request.workspace_id)?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            let time = now();
            let ctx = Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: &time,
            };
            adopt_existing(&ctx)?;
            work::reconcile_profiles(&ctx)?;
            ctx.snapshot()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn collaboration_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> std::result::Result<Snapshot, String> {
    main_window(&window)?;
    let profiles = native_profiles(app.clone(), &request.workspace_id)?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is unavailable.")?;
    let computers = app
        .try_state::<std::sync::Arc<crate::local_computer::LocalComputerState>>()
        .map(|state| state.inner().clone());
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            let time = now();
            let ctx = Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: &time,
            };
            // Staged inputs are native facts: verify them against the exact
            // agent workspace before the dispatch binding can proceed.
            if let Command::BindWork {
                id,
                attachments: Some(refs),
                ..
            } = &request.command
            {
                let item = repo::get::<Work>(conn, store, &scope.private, Kind::Work, id)?
                    .ok_or_else(|| invalid("The assignment is unavailable."))?;
                work::verify_attachment_files(
                    computers.as_deref(),
                    scope.data.workspace_id(),
                    &item.agent_id,
                    refs,
                )?;
            }
            commands::apply(&ctx, request.command)?;
            ctx.snapshot()
        })
        .map_err(|e| e.to_string())
}

/// Native adoption is idempotent and never rewrites a historical message or file.
fn adopt_existing(ctx: &Context<'_>) -> Result<()> {
    let projects =
        local_project::list_projects(ctx.conn, ctx.store, &ctx.scope.private, true, 128)?;
    for project in &projects {
        if repo::get::<Team>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Team,
            &project.id,
        )?
        .is_none()
        {
            ctx.team(&Team {
                project_id: project.id.clone(),
                lead_agent_id: None,
                participant_ids: ctx.profiles.iter().map(|p| p.id.clone()).collect(),
                revision: 1,
            })?;
        }
        for old in local_project::list_run_authors(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            &project.id,
            4096,
        )? {
            if repo::get::<Author>(
                ctx.conn,
                ctx.store,
                &ctx.scope.private,
                Kind::Author,
                &old.run_id,
            )?
            .is_none()
            {
                let author = Author {
                    run_id: old.run_id,
                    conversation_id: old.thread_id,
                    agent_id: old.agent_id,
                    name: old.payload["agentName"]
                        .as_str()
                        .unwrap_or("Unavailable teammate")
                        .into(),
                    work_id: None,
                    generation: 0,
                };
                ctx.put(
                    Kind::Author,
                    &author.run_id,
                    Some(&author.conversation_id),
                    Some(&project.id),
                    &author,
                )?;
            }
        }
    }
    for thread in thread::list(ctx.conn, ctx.store, &ctx.scope.data)? {
        if repo::get::<Conversation>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Conversation,
            &thread.id,
        )?
        .is_some()
        {
            continue;
        }
        let project = projects.iter().find(|p| p.thread_id == thread.id);
        let linked: Vec<_> = ctx
            .profiles
            .iter()
            .filter(|p| {
                p.thread_id.as_deref() == Some(&thread.id) || p.thread_ids.contains(&thread.id)
            })
            .collect();
        let members: Vec<Participant> = if project.is_some() {
            ctx.profiles
                .iter()
                .map(|p| Participant {
                    agent_id: p.id.clone(),
                    name: p.name.clone(),
                })
                .collect()
        } else if linked.len() == 1 {
            linked
                .iter()
                .map(|p| Participant {
                    agent_id: p.id.clone(),
                    name: p.name.clone(),
                })
                .collect()
        } else {
            vec![]
        };
        // Only positively owned legacy threads are adopted. They remain in the
        // ordinary conversation store if ownership cannot be established.
        let owned: bool = ctx.conn.query_row(
            "SELECT owner_member_id IS ?1 FROM thread WHERE workspace_id=?2 AND id=?3",
            rusqlite::params![
                ctx.scope.private.owner_member_id(),
                ctx.scope.data.workspace_id(),
                thread.id
            ],
            |row| row.get(0),
        )?;
        if !owned {
            continue;
        }
        // A single positive profile link establishes Side Chat ownership. Zero
        // or multiple links stay unclassified: ambiguous legacy chats are never
        // guessed to be an Agent's main Chat.
        let room = Conversation {
            chat: project
                .map(|p| ChatBinding {
                    role: "main".into(),
                    owner_kind: "project".into(),
                    owner_id: p.id.clone(),
                })
                .or_else(|| {
                    (linked.len() == 1).then(|| ChatBinding {
                        role: "side".into(),
                        owner_kind: "agent".into(),
                        owner_id: linked[0].id.clone(),
                    })
                }),
            id: thread.id,
            workspace_id: ctx.scope.data.workspace_id().into(),
            kind: if project.is_some() { "group" } else { "direct" }.into(),
            title: thread.title,
            project_id: project.map(|p| p.id.clone()),
            // Adoption never invents a coordinator. A project's submitter
            // chooses a current participant; a direct Chat has exactly one.
            facilitator_id: project
                .is_none()
                .then(|| members.first().map(|p| p.agent_id.clone()))
                .flatten(),
            participants: members,
            revision: 1,
            generation: 1,
            archived: false,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
        };
        ctx.conversation(&room)?;
        if project.is_none() && room.participants.len() == 1 {
            let mut runs = ctx
                .conn
                .prepare("SELECT id FROM run WHERE workspace_id=?1 AND thread_id=?2")?;
            let ids = runs
                .query_map(
                    rusqlite::params![ctx.scope.data.workspace_id(), room.id],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for run in ids {
                let author = Author {
                    run_id: run.clone(),
                    conversation_id: room.id.clone(),
                    agent_id: room.participants[0].agent_id.clone(),
                    name: room.participants[0].name.clone(),
                    work_id: None,
                    generation: 0,
                };
                ctx.put(Kind::Author, &run, Some(&room.id), None, &author)?;
            }
        }
    }
    Ok(())
}

/// Called once at native startup, never when a view mounts. Recovery grants no
/// execution authority and never starts a provider or replays an approval.
pub(crate) fn recover(store: &Store) -> Result<()> {
    store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
        let time = now();
        let ctx = Context { conn, store, scope: &scope, profiles: &[], time: &time };
        for mut item in ctx.all_work()? {
            if item.status.active() {
                item.status = WorkStatus::AwaitingUser;
                item.generation += 1;
                item.updated_at = time.clone();
                item.reason = Some("The app stopped during this work. Inspect saved results and reconcile any external actions before continuing. Nothing was replayed.".into());
                ctx.work(&item)?;
            }
        }
        Ok(())
    })
}

/// Remount recovery for executing Work that lost its renderer owner.
/// Does not grant execution authority or replay an attempt.
pub(crate) fn fence_orphaned_executing_work(
    conn: &Connection,
    store: &Store,
    time: &str,
) -> Result<()> {
    let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
    let ctx = Context {
        conn,
        store,
        scope: &scope,
        profiles: &[],
        time,
    };
    for mut item in ctx.all_work()? {
        if item.status.executing() {
            item.status = WorkStatus::AwaitingUser;
            item.generation += 1;
            item.current_run_id = None;
            item.reason = Some(
                "This assignment lost its execution owner. Inspect saved results and reconcile any external actions before continuing. Nothing was replayed."
                    .into(),
            );
            item.updated_at = time.into();
            ctx.work(&item)?;
        }
    }
    work::wake_waiters(&ctx)
}

pub(crate) fn suspend_account(
    conn: &Connection,
    store: &Store,
    user: &str,
    member: &str,
) -> Result<()> {
    let data = crate::store::repos::scope::DataScope::legacy_default();
    let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
        data.clone(),
        user,
        Some(member),
    )?;
    let scope = AuthorizedCommandScope {
        data,
        private,
        internal_user_id: user.into(),
        member_id: Some(member.into()),
    };
    let time = now();
    let ctx = Context {
        conn,
        store,
        scope: &scope,
        profiles: &[],
        time: &time,
    };
    for mut item in ctx.all_work()? {
        if item.status.active() {
            item.status = WorkStatus::AwaitingUser;
            item.generation += 1;
            item.current_run_id = None;
            item.reason = Some("Account session ended. Inspect saved results and reconcile uncertain external effects before continuing. Nothing was replayed.".into());
            item.updated_at = time.clone();
            ctx.work(&item)?;
        }
    }
    Ok(())
}

/// Canonical messages and journal writes must still belong to a live assignment.
/// Legacy runs have no work binding and keep their existing behavior.
pub(crate) fn ensure_run_current(
    conn: &Connection,
    store: &Store,
    run: Option<&str>,
) -> Result<()> {
    let Some(run) = run else {
        return Ok(());
    };
    let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
    let author: Option<Author> = repo::get(conn, store, &scope.private, Kind::Author, run)?;
    let Some(author) = author else {
        return Ok(());
    };
    let Some(key) = &author.work_id else {
        return Ok(());
    };
    let item: Work = repo::get(conn, store, &scope.private, Kind::Work, key)?
        .ok_or_else(|| invalid("This assignment is no longer available."))?;
    if item.generation != author.generation
        || !item.status.executing()
        || item.current_run_id.as_deref() != Some(run)
    {
        return Err(invalid(
            "A stopped or superseded assignment cannot write a late result.",
        ));
    }
    Ok(())
}
