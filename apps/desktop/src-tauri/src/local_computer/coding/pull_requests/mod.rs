//! PR reads and approved mutations share the managed repository lock and permits.
mod api;
mod mutations;
mod review_state;
#[cfg(test)]
mod tests;
pub(crate) mod watch;
use super::{git, process, OperationTicket, Repository};
use api::Api;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::Arc,
};
use tauri::State;

fn one() -> u64 {
    1
}
fn page_size() -> u64 {
    20
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub repository_id: String,
    #[serde(default)]
    pub number: u64,
    pub action: String,
    #[serde(default)]
    pub remote: String,
    #[serde(default)]
    pub expected_head: String,
    #[serde(default)]
    pub base_sha: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub head_branch: String,
    #[serde(default)]
    pub next_head: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
    #[serde(default)]
    pub review_id: u64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub viewed: bool,
    #[serde(default)]
    pub work_id: String,
    #[serde(default)]
    pub work_generation: u32,
    #[serde(default)]
    pub watch_id: String,
    #[serde(default = "one")]
    pub page: u64,
    #[serde(default = "page_size")]
    pub page_size: u64,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewComment {
    pub path: String,
    pub line: u32,
    pub side: String,
    pub body: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Saved {
    #[serde(default)]
    reviews: BTreeMap<u64, review_state::ReviewState>,
    pending: Option<mutations::Pending>,
    watch: Option<watch::Watch>,
}
fn load(directory: &Path, repo: &Repository) -> Result<Saved, String> {
    let path = directory.join(&repo.id).join("pull-requests.json");
    if !path.exists() {
        return Ok(Saved::default());
    }
    crate::paths::strict_canonicalize(&path).map_err(|_| "PR state path failed validation.")?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "PR state is unavailable.")?
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read PR state.")?;
    if bytes.len() > 512 * 1024 {
        return Err("PR state exceeds its limit.".into());
    }
    let mut saved: Saved = serde_json::from_slice(&bytes)
        .map_err(|_| "PR state requires recovery; no action was replayed.")?;
    if let Some(watch) = &mut saved.watch {
        if watch::stopped(directory, repo, &watch.id) {
            watch.active = false;
            watch.reason = Some("Stopped by the user.".into());
        }
    }
    Ok(saved)
}
pub(super) fn has_pending(directory: &Path, repo: &Repository) -> Result<bool, String> {
    Ok(load(directory, repo)?.pending.is_some())
}
pub(super) fn published_candidates(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<Vec<Value>, String> {
    let api = api::GitHub::connect(directory, ticket)?;
    let slug = api::slug(repo)?;
    let owner = slug.split('/').next().ok_or("Invalid GitHub owner.")?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("state", "all")
        .append_pair("head", &format!("{owner}:{}", repo.branch))
        .finish();
    let rows = api::all(&api, &format!("/repos/{slug}/pulls?{query}"), None)?;
    rows.iter().map(|pr| {
        if pr["head"]["repo"]["full_name"] != slug || pr["base"]["repo"]["full_name"] != slug || pr["head"]["ref"] != repo.branch {
            return Err("GitHub returned a different source repository for publication recovery.".into());
        }
        Ok(json!({"url":pr["html_url"], "headRefOid":pr["head"]["sha"], "baseRefName":pr["base"]["ref"]}))
    }).collect()
}
fn save(directory: &Path, repo: &Repository, value: &Saved) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Invalid PR state.")?;
    if bytes.len() > 512 * 1024 {
        return Err("PR state is full. Remove old drafts or viewed marks.".into());
    }
    let parent = directory.join(&repo.id);
    let mut file =
        tempfile::NamedTempFile::new_in(&parent).map_err(|_| "PR storage is unavailable.")?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot save PR state.")?;
    file.persist(parent.join("pull-requests.json"))
        .map_err(|_| "Cannot commit PR state.")?;
    Ok(())
}
pub(super) fn execute(
    directory: &Path,
    ticket: &OperationTicket,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    let input: Request = serde_json::from_value(arguments).map_err(|_| "Invalid PR arguments.")?;
    let lock = super::lock(directory)?;
    let _guard = if tool == "repository-pr-action" {
        lock.try_lock()
            .map_err(|_| "Repository operation in progress. Wait or Stop it.")?
    } else {
        review_lock(&lock, ticket)?
    };
    let mut repo = super::load(directory)?.ok_or("Attach a repository first.")?;
    if repo.id != input.repository_id {
        return Err("Repository selection changed. Refresh first.".into());
    }
    ticket.check()?;
    let mut saved = load(directory, &repo)?;
    if tool == "repository-pr-local" && matches!(input.action.as_str(), "state" | "discard") {
        if input.number == 0 {
            return Err("Choose a PR.".into());
        }
        if input.action == "discard" {
            saved.reviews.remove(&input.number);
            ticket.with_current(|| save(directory, &repo, &saved))?;
        }
        return Ok(json!({"review": saved.reviews.get(&input.number), "pending": saved.pending, "watch": saved.watch}).to_string());
    }
    let api = api::GitHub::connect(directory, ticket)?;
    let result = match tool {
        "repository-pr-read" => api::read(&api, &repo, &input)?,
        "repository-pr-action" => {
            mutations::execute(directory, &mut repo, &mut saved, &input, ticket, &api)?
        }
        "repository-pr-local" => {
            let value = review_state::apply(&api, &repo, &mut saved, &input)?;
            ticket.with_current(|| save(directory, &repo, &saved))?;
            value
        }
        _ => return Err("Unknown PR tool.".into()),
    };
    ticket.check()?;
    Ok(crate::secret_redaction::redact_secret_text_or_omit(
        &result.to_string(),
    ))
}

fn review_lock<'a>(
    lock: &'a std::sync::Mutex<()>,
    ticket: &OperationTicket,
) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    // The review screen requests independent projections concurrently. Serialize
    // their native reads instead of reporting a false failure on first open.
    let start = std::time::Instant::now();
    loop {
        ticket.check()?;
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("Repository lock is unavailable.".into())
            }
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if start.elapsed() >= std::time::Duration::from_secs(60) {
            return Err("Repository remained busy. Refresh the review after the current operation finishes.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Read-only UI transport. Remote mutations have no direct renderer command.
#[tauri::command]
pub async fn coding_pr_read(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<super::LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    request: Request,
) -> Result<Value, String> {
    ui_call(
        window,
        state,
        workspace_id,
        agent_id,
        expected_generation,
        request,
        "repository-pr-read",
    )
    .await
}
#[tauri::command]
pub async fn coding_pr_local(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<super::LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    request: Request,
) -> Result<Value, String> {
    ui_call(
        window,
        state,
        workspace_id,
        agent_id,
        expected_generation,
        request,
        "repository-pr-local",
    )
    .await
}
async fn ui_call(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<super::LocalComputerState>>,
    workspace: String,
    agent: String,
    generation: u64,
    request: Request,
    tool: &'static str,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("PR review belongs to the main window.".into());
    }
    let ticket = state.begin_agent_operation(&workspace, &agent, generation)?;
    let directory = super::directory(&state, &workspace, &agent)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = execute(
            &directory,
            &ticket,
            tool,
            serde_json::to_value(request).map_err(|_| "Invalid PR request.")?,
        );
        ticket.finish(result.and_then(|text| {
            serde_json::from_str(&text).map_err(|_| "Invalid PR response.".into())
        }))
    })
    .await
    .map_err(|_| "PR operation stopped.".to_string())?
}
