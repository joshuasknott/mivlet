//! User-only retained-copy lifecycle. Never accepts host paths or model actions.
use super::{git, load, lock, save, LocalComputerState, OperationTicket, Repository};
use crate::collaboration::models::{Work, WorkStatus};
use crate::store::repos::collaboration::{self, Kind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::State;
pub(crate) mod account;
mod filesystem;
use filesystem::{remove_tree, scan_tree};

const LIMIT: u64 = 512 * 1024;
const MAX_ENTRIES: usize = 200_000;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(120);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    account: String,
    workspace: String,
    agent: String,
    // Native-only; never returned to React or included in model context.
    source: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupIntent {
    owner: Owner,
    repository: Repository,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyScope {
    pub workspace_id: String,
    pub agent_id: String,
    pub expected_generation: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyAction {
    pub target: CopyScope,
    pub repository_id: String,
    pub preview_token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedWork {
    id: String,
    status: WorkStatus,
}

#[derive(Clone, Default)]
struct Evidence {
    work: Vec<LinkedWork>,
    unresolved: bool,
    jobs: Vec<LinkedJob>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedJob {
    id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEntry {
    id: String,
    name: String,
    account_id: String,
    ownership_verified: bool,
    workspace_id: String,
    agent_id: String,
    source_repository: Option<String>,
    managed_path: String,
    branch: Option<String>,
    head: Option<String>,
    selected: bool,
    dirty: Option<bool>,
    size_bytes: Option<u64>,
    // Domain projections are deliberately conservative where identity is absent.
    linked_work: Vec<LinkedWork>,
    live_jobs: Vec<LinkedJob>,
    jobs_status: String,
    checkpoints_status: String,
    blockers: Vec<String>,
    cleanup_pending: bool,
    #[serde(skip)]
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyInventory {
    copies: Vec<CopyEntry>,
    busy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    copy: CopyEntry,
    preview_token: Option<String>,
    expires_in_seconds: u64,
}

struct Permit {
    directory: PathBuf,
    account: String,
    target: CopyScope,
    id: String,
    fingerprint: String,
    created: Instant,
}
fn permits() -> &'static Mutex<HashMap<String, Permit>> {
    static PERMITS: OnceLock<Mutex<HashMap<String, Permit>>> = OnceLock::new();
    PERMITS.get_or_init(Mutex::default)
}
fn valid_id(id: &str) -> bool {
    id.len() == 48 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T, String> {
    crate::paths::strict_canonicalize(path).map_err(|_| "Copy record failed path validation.")?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Copy record is unavailable.")?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Copy record is unreadable.")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Copy record exceeds its limit.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Copy record needs recovery.".into())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Copy storage is unavailable.")?;
    crate::paths::strict_canonicalize(parent)
        .map_err(|_| "Copy storage failed path validation.")?;
    if path.exists() {
        crate::paths::strict_canonicalize(path)
            .map_err(|_| "Copy record failed path validation.")?;
    }
    let bytes = serde_json::to_vec(value).map_err(|_| "Copy record is invalid.")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Copy record exceeds its limit.".into());
    }
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Copy record is unavailable.")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Copy record could not be saved.")?;
    file.persist(path)
        .map_err(|_| "Copy record could not be saved.")?;
    Ok(())
}

pub(super) fn save_copy(directory: &Path, repo: &Repository) -> Result<(), String> {
    if !valid_id(&repo.id) {
        return Err("Invalid copy identity.".into());
    }
    write_json(&directory.join(&repo.id).join("repository.json"), repo)
}
pub(super) fn register(
    directory: &Path,
    repo: &Repository,
    workspace: &str,
    agent: &str,
    source: &Path,
) -> Result<(), String> {
    let source = crate::paths::strict_canonicalize(source)
        .map_err(|_| "Source repository failed validation.")?;
    register_owner(directory, repo, &owner(workspace, agent)?, Some(source))
}
fn owner(workspace: &str, agent: &str) -> Result<Owner, String> {
    Ok(Owner {
        account: crate::account_session::binding()?.into(),
        workspace: workspace.into(),
        agent: agent.into(),
        source: None,
    })
}
fn register_owner(
    directory: &Path,
    repo: &Repository,
    owner: &Owner,
    source: Option<PathBuf>,
) -> Result<(), String> {
    if !valid_id(&repo.id) {
        return Err("Invalid copy identity.".into());
    }
    let path = directory.join(&repo.id);
    crate::paths::strict_canonicalize(&path).map_err(|_| "Copy failed path validation.")?;
    write_json(
        &path.join("ownership.json"),
        &Owner {
            source,
            ..owner.clone()
        },
    )?;
    save_copy(directory, repo)
}
fn same_owner(left: &Owner, right: &Owner) -> bool {
    left.account == right.account && left.workspace == right.workspace && left.agent == right.agent
}

// Scope-less Work records cannot identify an older copy: protect all copies of
// that agent until unfinished work has been reviewed, including blocked work.
fn with_evidence<T>(
    target: &CopyScope,
    action: impl FnOnce(Evidence) -> Result<T, String>,
) -> Result<T, String> {
    let store = crate::store::try_global().ok_or("The native Work store is unavailable.")?;
    store
        .with_conn(|conn| {
            let evidence = collect_evidence(conn, store, target)?;
            // Holding the canonical store connection serializes Work admission with
            // the final deletion/selection check; no competing Work queue exists.
            action(evidence).map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

fn collect_evidence(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    target: &CopyScope,
) -> crate::store::Result<Evidence> {
    let scope = crate::authorized_scope::resolve(
        conn,
        Some(&target.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let work: Vec<Work> = collaboration::list(conn, store, &scope.private, Kind::Work)?;
    let work: Vec<_> = work
        .into_iter()
        .filter(|item| item.agent_id == target.agent_id)
        .collect();
    Ok(Evidence {
        unresolved: work.iter().any(|item| {
            !matches!(
                item.status,
                WorkStatus::Completed | WorkStatus::Failed | WorkStatus::Cancelled
            )
        }),
        work: work
            .into_iter()
            .map(|item| LinkedWork {
                id: item.id,
                status: item.status,
            })
            .collect(),
        jobs: execution_evidence(conn, store, &scope.data)?,
    })
}

fn read_evidence(target: &CopyScope) -> Result<Evidence, String> {
    let store = crate::store::try_global().ok_or("The native Work store is unavailable.")?;
    store
        .with_conn(|conn| collect_evidence(conn, store, target))
        .map_err(|error| error.to_string())
}

fn execution_evidence(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
) -> crate::store::Result<Vec<LinkedJob>> {
    use crate::store::repos::execution_attempt;
    let ids = execution_attempt::list_by_status_scoped(
        conn,
        scope,
        &[
            "queued",
            "streaming",
            "awaiting-approval",
            "retrying",
            "interrupted",
        ],
    )?;
    if ids.len() > 4096 {
        return Err(crate::store::StoreError::Invalid(
            "Execution inventory exceeds its limit.".into(),
        ));
    }
    let mut jobs = Vec::new();
    for id in ids {
        let row = execution_attempt::get_scoped(conn, store, scope, &id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Execution evidence changed.".into())
        })?;
        if row.status != "interrupted" || row.recoverable {
            jobs.push(LinkedJob {
                id,
                status: row.status,
            });
        }
    }
    Ok(jobs)
}

// Hash names, types and bytes, including ignored files and Git metadata. The
// logical byte count is not filesystem allocation, compression or deduplication.
#[cfg(test)]
fn scan(root: &Path, ticket: &OperationTicket) -> Result<(u64, String), String> {
    scan_tree(root, ticket, true)
}
fn inspect(
    directory: &Path,
    id: &str,
    owner: &Owner,
    evidence: &Evidence,
    busy: bool,
    hash_contents: bool,
    ticket: &OperationTicket,
) -> CopyEntry {
    let pending =
        !directory.join(id).exists() && directory.join(format!("cleanup-{id}.json")).exists();
    let root = directory.join(if pending {
        format!("deleting-{id}")
    } else {
        id.into()
    });
    let selected = load(directory)
        .ok()
        .flatten()
        .is_some_and(|repo| repo.id == id);
    let mut entry = CopyEntry {
        id: id.into(),
        name: "Unregistered repository copy".into(),
        account_id: owner.account.clone(),
        ownership_verified: false,
        workspace_id: owner.workspace.clone(),
        agent_id: owner.agent.clone(),
        source_repository: None,
        managed_path: format!(
            "local-computers/{}/coding/{}/checkout",
            directory
                .parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown-scope".into()),
            if pending {
                format!("deleting-{id}")
            } else {
                id.into()
            }
        ),
        branch: None,
        head: None,
        selected,
        dirty: None,
        size_bytes: None,
        linked_work: evidence.work.clone(),
        live_jobs: evidence.jobs.clone(),
        jobs_status: if busy {
            "repository operation active"
        } else {
            "no operation holds the repository lock; detached jobs not supported by this baseline"
        }
        .into(),
        checkpoints_status: "checkpoint service not installed; unknown copy metadata is protected"
            .into(),
        blockers: Vec::new(),
        cleanup_pending: pending,
        fingerprint: String::new(),
    };
    let result = (|| {
        if directory.join(id).exists() && directory.join(format!("deleting-{id}")).exists() {
            return Err(
                "Conflicting retained and cleanup copies require recovery; retain both.".into(),
            );
        }
        load(directory)?; // A damaged selection record must never become permission to delete.
        let intent = if pending {
            Some(read_json::<CleanupIntent>(
                &directory.join(format!("cleanup-{id}.json")),
            )?)
        } else {
            None
        };
        let actual: Owner = if let Some(intent) = &intent {
            intent.owner.clone()
        } else {
            read_json(&root.join("ownership.json"))?
        };
        if !same_owner(&actual, owner) {
            return Err("Copy ownership is unclear or belongs to another scope.".into());
        }
        entry.ownership_verified = true;
        let repo: Repository = if let Some(intent) = &intent {
            intent.repository.clone()
        } else {
            read_json(&root.join("repository.json"))?
        };
        if repo.id != id {
            return Err("Copy identity does not match its record.".into());
        }
        entry.name = repo.name.clone();
        entry.source_repository = Some(repo.remote.clone().unwrap_or_else(|| repo.name.clone()));
        entry.branch = Some(repo.branch.clone());
        if selected
            && !pending
            && load(directory)?.is_none_or(|current| {
                serde_json::to_value(current).ok() != serde_json::to_value(&repo).ok()
            })
        {
            return Err(
                "Selected and retained records disagree; inspect repository status before cleanup."
                    .into(),
            );
        }
        if busy {
            return Err("A repository operation is active. Wait or Stop it before cleanup.".into());
        }
        if evidence.unresolved {
            entry
                .blockers
                .push("Unfinished Work belongs to this agent; finish or cancel it first.".into());
        }
        if !evidence.jobs.is_empty() {
            entry.blockers.push("Active or recoverable provider execution exists in this workspace; exact copy attribution is unavailable.".into());
            entry.jobs_status = "provider execution or recovery active; detached jobs not supported by this baseline".into();
        }
        if repo.operation != "idle" {
            entry
                .blockers
                .push(format!("Recovery required: {}", repo.operation));
        }
        if repo.publication.is_some() {
            entry.blockers.push(
                "Published copy: pull request terminal-state evidence is unavailable; retain it."
                    .into(),
            );
        }
        let allowed = ["checkout", "git", "repository.json", "ownership.json"];
        if root.exists()
            && fs::read_dir(&root)
                .map_err(|_| "Copy storage is unreadable.")?
                .any(|item| {
                    item.map_or(true, |entry| {
                        !allowed.iter().any(|name| entry.file_name() == *name)
                    })
                })
        {
            entry
                .blockers
                .push("Checkpoint, import, job or unknown metadata protects this copy.".into());
        }
        if let Some(source) = &actual.source {
            if source.starts_with(&root) || root.starts_with(source) {
                return Err("Original repository overlaps this copy; cleanup is protected.".into());
            }
        }
        if !pending {
            let branch = git::run(
                directory,
                &repo,
                &["symbolic-ref", "--short", "HEAD"],
                ticket,
            )?;
            if branch != repo.branch {
                entry.blockers.push(
                    "Managed branch changed outside its saved record; inspect before cleanup."
                        .into(),
                );
            }
            entry.branch = Some(branch);
            let status = git::run(
                directory,
                &repo,
                &[
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                    "--ignored=matching",
                ],
                ticket,
            )?;
            entry.dirty = Some(!status.is_empty());
            if !status.is_empty() {
                entry
                    .blockers
                    .push("Uncommitted, untracked or ignored files must be preserved.".into());
            }
            let head = git::run(directory, &repo, &["rev-parse", "HEAD"], ticket)?;
            if head != repo.base {
                entry.blockers.push("Copy has commits beyond its imported HEAD; publication/checkpoint retention must be resolved first.".into());
            }
            entry.head = Some(head);
        }
        let (size, fingerprint) = if pending && !root.exists() {
            (0, "cleanup-files-removed".into())
        } else {
            scan_tree(&root, ticket, hash_contents)?
        };
        entry.size_bytes = Some(size);
        entry.fingerprint = format!(
            "{}:{}",
            fingerprint,
            hex::encode(Sha256::digest(
                serde_json::to_vec(&intent).map_err(|_| "Invalid cleanup intent.")?
            ))
        );
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        entry.blockers.push(error);
    }
    if entry.size_bytes.is_none() && !busy {
        if let Ok((size, _)) = scan_tree(&root, ticket, false) {
            entry.size_bytes = Some(size);
        }
    }
    entry
}

fn inventory(
    directory: &Path,
    owner: &Owner,
    evidence: &Evidence,
    ticket: &OperationTicket,
) -> Result<CopyInventory, String> {
    inventory_in(directory, owner, evidence, ticket, true)
}
fn inventory_in(
    directory: &Path,
    owner: &Owner,
    evidence: &Evidence,
    ticket: &OperationTicket,
    register_legacy: bool,
) -> Result<CopyInventory, String> {
    let mutex = lock(directory)?;
    let guard = mutex.try_lock();
    let busy = guard.is_err();
    if !busy && register_legacy {
        // Only a currently selected legacy record has verifiable scope. Older
        // directories stay visible and protected rather than guessing ownership.
        if let Some(repo) = load(directory)? {
            if !directory.join(&repo.id).join("ownership.json").exists() {
                ticket.with_current(|| register_owner(directory, &repo, owner, None))?;
            }
        }
    }
    let mut ids = Vec::new();
    for child in fs::read_dir(directory).map_err(|_| "Copy inventory is unavailable.")? {
        let child = child.map_err(|_| "Copy inventory is unreadable.")?;
        let name = child.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_prefix("deleting-")
            .or_else(|| {
                name.strip_prefix("cleanup-")
                    .and_then(|value| value.strip_suffix(".json"))
            })
            .unwrap_or(&name);
        if valid_id(id) {
            ids.push(id.to_owned());
        }
        if ids.len() > 1000 {
            return Err("Copy inventory exceeds its limit.".into());
        }
    }
    ids.sort();
    ids.dedup();
    Ok(CopyInventory {
        copies: ids
            .iter()
            .map(|id| inspect(directory, id, owner, evidence, busy, false, ticket))
            .collect(),
        busy,
    })
}

fn preview(
    directory: &Path,
    id: &str,
    owner: &Owner,
    target: &CopyScope,
    evidence: &Evidence,
    ticket: &OperationTicket,
) -> Result<CleanupPreview, String> {
    if !valid_id(id) {
        return Err("Invalid copy identity.".into());
    }
    let mutex = lock(directory)?;
    let _guard = mutex
        .try_lock()
        .map_err(|_| "A repository operation is active.")?;
    let copy = inspect(directory, id, owner, evidence, false, true, ticket);
    let token = if copy.blockers.is_empty() {
        let token = super::super::desktop_tools::opaque_id()?;
        let mut permits = permits()
            .lock()
            .map_err(|_| "Cleanup previews are unavailable.")?;
        permits.retain(|_, permit| permit.created.elapsed() < PREVIEW_LIFETIME);
        if permits.len() >= 64 {
            return Err("Too many pending cleanup previews. Wait for them to expire.".into());
        }
        permits.insert(
            token.clone(),
            Permit {
                directory: directory.into(),
                account: owner.account.clone(),
                target: target.clone(),
                id: id.into(),
                fingerprint: copy.fingerprint.clone(),
                created: Instant::now(),
            },
        );
        Some(token)
    } else {
        None
    };
    Ok(CleanupPreview {
        copy,
        preview_token: token,
        expires_in_seconds: PREVIEW_LIFETIME.as_secs(),
    })
}

fn delete(
    directory: &Path,
    owner: &Owner,
    action: &CopyAction,
    evidence: &Evidence,
    ticket: &OperationTicket,
) -> Result<(), String> {
    let _directory_pin = filesystem::pin(directory, false)?;
    let token = action
        .preview_token
        .as_deref()
        .ok_or("Inspect an exact cleanup preview first.")?;
    let permit = permits()
        .lock()
        .map_err(|_| "Cleanup previews are unavailable.")?
        .remove(token)
        .ok_or("Cleanup preview expired or was already consumed.")?;
    if permit.created.elapsed() >= PREVIEW_LIFETIME
        || permit.directory != directory
        || permit.account != owner.account
        || permit.id != action.repository_id
        || permit.target.workspace_id != action.target.workspace_id
        || permit.target.agent_id != action.target.agent_id
        || permit.target.expected_generation != action.target.expected_generation
    {
        return Err("Cleanup preview does not match this account, copy or generation.".into());
    }
    let mutex = lock(directory)?;
    let _guard = mutex
        .try_lock()
        .map_err(|_| "A repository operation became active. Inspect again.")?;
    let copy = inspect(
        directory,
        &action.repository_id,
        owner,
        evidence,
        false,
        true,
        ticket,
    );
    if permit.created.elapsed() >= PREVIEW_LIFETIME
        || !copy.blockers.is_empty()
        || copy.fingerprint != permit.fingerprint
    {
        return Err("Copy changed or became protected after preview. Inspect again.".into());
    }
    let root = directory.join(&action.repository_id);
    let tombstone = directory.join(format!("deleting-{}", action.repository_id));
    let receipt = directory.join(format!("cleanup-{}.json", action.repository_id));
    ticket.with_current(|| {
        if !copy.cleanup_pending {
            let repository = read_json(&root.join("repository.json"))?;
            write_json(
                &receipt,
                &CleanupIntent {
                    owner: read_json(&root.join("ownership.json"))?,
                    repository,
                },
            )?;
            fs::rename(&root, &tombstone)
                .map_err(|_| "Copy could not enter cleanup; nothing was removed.")?;
        }
        if copy.selected {
            fs::remove_file(directory.join("repository.json"))
                .map_err(|_| "Selection needs cleanup recovery.")?;
        }
        Ok(())
    })?;
    let tombstone_pin = if tombstone.exists() {
        Some(filesystem::pin(&tombstone, false)?)
    } else {
        None
    };
    if tombstone.exists() {
        let (_, fingerprint) = scan_tree(&tombstone, ticket, true)?;
        if Some(fingerprint.as_str()) != copy.fingerprint.split_once(':').map(|(tree, _)| tree) {
            return Err(
                "Copy changed while entering cleanup. Retained cleanup requires a fresh review."
                    .into(),
            );
        }
    }
    // Preserve records until all other content is removed so interrupted cleanup
    // remains discoverable and can receive a fresh explicit preview on restart.
    if tombstone.exists() {
        for child in fs::read_dir(&tombstone).map_err(|_| "Cleanup needs recovery.")? {
            let child = child.map_err(|_| "Cleanup needs recovery.")?;
            if child.file_name() == "repository.json" || child.file_name() == "ownership.json" {
                continue;
            }
            remove_tree(&child.path(), ticket)?;
        }
    }
    ticket.with_current(|| {
        if tombstone.exists() {
            for name in ["repository.json", "ownership.json"] {
                let record = tombstone.join(name);
                if record.exists() {
                    crate::paths::strict_canonicalize(&record)
                        .map_err(|_| "Cleanup record failed validation.")?;
                    fs::remove_file(record).map_err(|_| "Cleanup needs recovery.")?;
                }
            }
            drop(tombstone_pin);
            fs::remove_dir(&tombstone).map_err(|_| "Cleanup needs recovery.")?;
        }
        fs::remove_file(&receipt).map_err(|_| "Cleanup receipt needs recovery.")?;
        Ok(())
    })
}

fn select(
    directory: &Path,
    id: &str,
    owner: &Owner,
    evidence: &Evidence,
    ticket: &OperationTicket,
) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid copy identity.".into());
    }
    let mutex = lock(directory)?;
    let _guard = mutex
        .try_lock()
        .map_err(|_| "Stop the repository operation before selecting another copy.")?;
    if evidence.unresolved || !evidence.jobs.is_empty() {
        return Err("Finish or cancel this agent's unfinished Work before changing copies.".into());
    }
    if let Some(current) = load(directory)? {
        if current.operation != "idle"
            || directory
                .join(&current.id)
                .join("native-import.json")
                .exists()
        {
            return Err("Recover the selected copy before switching repositories.".into());
        }
    }
    let root = directory.join(id);
    let actual: Owner = read_json(&root.join("ownership.json"))?;
    if !same_owner(&actual, owner) {
        return Err("Copy ownership does not match this scope.".into());
    }
    let repo: Repository = read_json(&root.join("repository.json"))?;
    if repo.id != id || repo.operation != "idle" {
        return Err("Copy identity or recovery state prevents selection.".into());
    }
    super::checkout(directory, &repo)?;
    ticket.with_current(|| save(directory, &repo))
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Copy management belongs to the main Mivlet window.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn coding_copy_inventory(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    target: CopyScope,
) -> Result<CopyInventory, String> {
    main_window(&window)?;
    let ticket = state.begin_agent_operation(
        &target.workspace_id,
        &target.agent_id,
        target.expected_generation,
    )?;
    let directory = super::directory(&state, &target.workspace_id, &target.agent_id)?;
    let owner = owner(&target.workspace_id, &target.agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = read_evidence(&target)
            .and_then(|evidence| inventory(&directory, &owner, &evidence, &ticket));
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Copy inventory stopped.".to_string())?
}

#[tauri::command]
pub async fn coding_copy_preview(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    action: CopyAction,
) -> Result<CleanupPreview, String> {
    main_window(&window)?;
    let ticket = state.begin_agent_operation(
        &action.target.workspace_id,
        &action.target.agent_id,
        action.target.expected_generation,
    )?;
    let directory = super::directory(&state, &action.target.workspace_id, &action.target.agent_id)?;
    let owner = owner(&action.target.workspace_id, &action.target.agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = read_evidence(&action.target).and_then(|evidence| {
            preview(
                &directory,
                &action.repository_id,
                &owner,
                &action.target,
                &evidence,
                &ticket,
            )
        });
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Cleanup preview stopped.".to_string())?
}

#[tauri::command]
pub async fn coding_copy_delete(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    action: CopyAction,
) -> Result<(), String> {
    main_window(&window)?;
    let ticket = state.begin_agent_operation(
        &action.target.workspace_id,
        &action.target.agent_id,
        action.target.expected_generation,
    )?;
    let directory = super::directory(&state, &action.target.workspace_id, &action.target.agent_id)?;
    let owner = owner(&action.target.workspace_id, &action.target.agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_evidence(&action.target, |evidence| {
            delete(&directory, &owner, &action, &evidence, &ticket)
        });
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Cleanup stopped. Inspect retained cleanup before retrying.".to_string())?
}

#[tauri::command]
pub async fn coding_copy_select(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    action: CopyAction,
) -> Result<(), String> {
    main_window(&window)?;
    let ticket = state.begin_agent_operation(
        &action.target.workspace_id,
        &action.target.agent_id,
        action.target.expected_generation,
    )?;
    let directory = super::directory(&state, &action.target.workspace_id, &action.target.agent_id)?;
    let owner = owner(&action.target.workspace_id, &action.target.agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_evidence(&action.target, |evidence| {
            select(
                &directory,
                &action.repository_id,
                &owner,
                &evidence,
                &ticket,
            )
        });
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Copy selection stopped.".to_string())?
}

#[cfg(test)]
mod tests;
