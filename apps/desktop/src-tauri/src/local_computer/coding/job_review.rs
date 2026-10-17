//! Exact-job read-only review of the retained task copy. No selection, recovery,
//! command replay or import is performed by this user-only viewer.
use super::*;
use crate::local_computer::command_jobs::ScopeJobs;
use std::{
    process::Command,
    time::{Duration, Instant},
};

const MAX_FILES: usize = 200;
const MAX_NAMES: usize = 64 * 1024;
const MAX_NODES: usize = 2048;
const MAX_TEXT: usize = 64 * 1024;
// Native fixed pathspecs only. Case-insensitive exclusions cover the protected
// names and whole matching directories, including their deleted/base content.
const PUBLIC_PATHS: &[&str] = &[
    ":/",
    ":(top,icase,exclude,glob)**/.env",
    ":(top,icase,exclude,glob)**/.env.*",
    ":(top,icase,exclude,glob)**/*.pem",
    ":(top,icase,exclude,glob)**/*.key",
    ":(top,icase,exclude,glob)**/.env/**",
    ":(top,icase,exclude,glob)**/.env.*/**",
    ":(top,icase,exclude,glob)**/*.pem/**",
    ":(top,icase,exclude,glob)**/*.key/**",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewRequest {
    pub workspace_id: String,
    pub agent_id: String,
    pub expected_generation: u64,
    pub job_id: String,
    pub job_generation: u64,
}
impl ReviewRequest {
    fn validate(&self) -> Result<(), String> {
        if self.job_id.len() != 48
            || !self.job_id.bytes().all(|b| b.is_ascii_hexdigit())
            || self.job_generation == 0
            || self.expected_generation == 0
        {
            return Err("Refresh the exact command job before reviewing its repository.".into());
        }
        Ok(())
    }
}

fn files(
    root: &Path,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(Vec<String>, bool, bool), String> {
    let root = crate::paths::strict_canonicalize(root)
        .map_err(|_| "The task repository path failed validation.")?;
    let mut stack = vec![(root.clone(), 0usize)];
    let mut paths = Vec::new();
    let mut bytes = 0usize;
    let mut nodes = 0usize;
    let mut truncated = false;
    let mut complete = true;
    'walk: while let Some((directory, depth)) = stack.pop() {
        check()?;
        for entry in fs::read_dir(directory).map_err(|_| "Task files are unavailable.")? {
            check()?;
            nodes += 1;
            if nodes > MAX_NODES {
                truncated = true;
                complete = false;
                break 'walk;
            }
            let entry = entry.map_err(|_| "A task file is unavailable.")?;
            let path = entry.path();
            let canonical = crate::paths::strict_canonicalize(&path)
                .map_err(|_| "Linked or replaced task files cannot be reviewed.")?;
            if !canonical.starts_with(&root) {
                return Err("A task file escaped its retained copy.".into());
            }
            let relative = canonical
                .strip_prefix(&root)
                .map_err(|_| "Invalid task file.")?
                .to_str()
                .ok_or("Task file names must be valid Unicode.")?
                .replace('\\', "/");
            if super::safe_path(&relative.to_ascii_lowercase()).is_err() {
                if relative
                    .split('/')
                    .any(|part| part.eq_ignore_ascii_case(".git"))
                {
                    return Err("Git custody is not available to task file review.".into());
                }
                truncated = true;
                complete = false;
                continue;
            }
            let metadata = fs::symlink_metadata(&canonical).map_err(|_| "A task file changed.")?;
            if metadata.is_dir() {
                if depth < 32 {
                    stack.push((canonical, depth + 1));
                } else {
                    truncated = true;
                    complete = false;
                }
            } else if metadata.is_file() {
                if paths.len() == MAX_FILES || bytes.saturating_add(relative.len()) > MAX_NAMES {
                    truncated = true;
                    continue;
                }
                let safe = crate::secret_redaction::redact_secret_text_or_omit(&relative);
                if safe != relative {
                    truncated = true;
                    complete = false;
                    continue;
                }
                bytes += safe.len();
                paths.push(safe);
            } else {
                return Err("Only regular task files can be reviewed.".into());
            }
        }
    }
    paths.sort();
    Ok((paths, truncated, complete))
}

fn bounded_text(mut value: String) -> (String, bool) {
    let truncated = value.len() > MAX_TEXT;
    if truncated {
        let mut end = MAX_TEXT;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    (value, truncated)
}

fn public_base_names(output: &str) -> bool {
    if output.is_empty() {
        return true;
    }
    output.ends_with('\0')
        && output.split_terminator('\0').all(|name| {
            !name.is_empty()
                && !name.contains('\u{fffd}')
                && !name.chars().any(char::is_control)
                && super::safe_path(&name.to_ascii_lowercase()).is_ok()
                && mivlet_windows_executor::repository_files::relative(name).is_ok()
        })
}

fn review_changes(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    deadline: Instant,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let run = |command: Command| -> Result<process::CommandResult, String> {
        check()?;
        let seconds = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or("Repository review expired. Refresh to try again.")?
            .as_secs()
            .max(1);
        let result = process::run(command, ticket, seconds)?;
        check()?;
        if result.interrupted || result.exit_code != Some(0) {
            return Err(
                "Repository review was interrupted. No command was replayed or files changed."
                    .into(),
            );
        }
        Ok(result)
    };
    // Inspect names only before any content staging. Protected deleted/renamed
    // base content must not reappear under a public path through rename/copy
    // detection or a changed current filename. Uncertainty stays unavailable.
    for revision in [repo.base.as_str(), "HEAD"] {
        let mut names = git::repo_git(directory, repo)?;
        names.args(["ls-tree", "-r", "--name-only", "-z", revision, "--"]);
        let names = run(names)?;
        if names.truncated || names.redacted || !public_base_names(&names.output) {
            return Ok(Value::Null);
        }
    }
    // Same derived scratch tree as Library review, with a shared overall
    // deadline. The real index, worktree, selection and recovery ledger stay put.
    let scratch = tempfile::tempdir_in(directory.join(&repo.id))
        .map_err(|_| "The native review index is unavailable.")?;
    let index = scratch.path().join("index");
    let mut truncated = false;
    let index_command = |args: &[&str]| -> Result<String, String> {
        let mut command = git::repo_git(directory, repo)?;
        command
            .env("GIT_INDEX_FILE", git::git_path(&index))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(args);
        let result = run(command)?;
        if result.truncated {
            return Err("The review index exceeded its output bound.".into());
        }
        Ok(result.output.trim().into())
    };
    index_command(&["read-tree", "HEAD"])?;
    let mut add = vec!["add", "-A", "--"];
    add.extend_from_slice(PUBLIC_PATHS);
    index_command(&add)?;
    let tree = index_command(&["write-tree"])?;
    if !matches!(tree.len(), 40 | 64) || !tree.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("The native review tree is unavailable.".into());
    }
    let mut head_command = git::repo_git(directory, repo)?;
    head_command.args(["rev-parse", "--verify", "HEAD"]);
    let head = run(head_command)?;
    if head.truncated {
        return Err("The repository revision is unavailable.".into());
    }
    let mut diff_command = git::repo_git(directory, repo)?;
    diff_command.args([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        &repo.base,
        &tree,
        "--",
    ]);
    diff_command.args(PUBLIC_PATHS);
    let diff = run(diff_command)?;
    truncated |= diff.truncated;
    let (diff, clipped_diff) = bounded_text(diff.output);
    let mut names_command = git::repo_git(directory, repo)?;
    names_command.args([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        &repo.base,
        &tree,
        "--",
    ]);
    names_command.args(PUBLIC_PATHS);
    let names = run(names_command)?;
    truncated |= names.truncated;
    let (names, clipped_names) = bounded_text(names.output);
    Ok(
        json!({"head":head.output.trim(),"diffId":tree,"diff":diff,"files":names,
        "truncated":truncated || clipped_diff || clipped_names}),
    )
}

#[allow(clippy::too_many_arguments)]
fn inspect_in(
    directory: &Path,
    jobs: &ScopeJobs,
    target: &ReviewRequest,
    account: &str,
    ticket: &OperationTicket,
    deadline: Instant,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    target.validate()?;
    check()?;
    if ticket.generation != target.expected_generation {
        return Err("The repository viewer authority changed. Refresh before reviewing.".into());
    }
    let binding = jobs.repository_binding(&target.job_id, target.job_generation)?;
    let repo = copy_manager::owned_repository_in_account(
        directory,
        &binding.repository_id,
        account,
        &target.workspace_id,
        &target.agent_id,
    )?;
    binding.check(&repo)?;
    let mutex = lock(directory)?;
    let guard = mutex.try_lock();
    let lease = guard
        .as_ref()
        .ok()
        .map(|_| mivlet_windows_executor::repository_files::lease(directory));
    let busy = guard.is_err() || lease.as_ref().is_some_and(Result::is_err);
    let recovery_required = repo.operation != "idle"
        || directory.join(&repo.id).join("native-import.json").exists()
        || (!busy && pull_requests::has_pending(directory, &repo)?);
    let (files, truncated, changes) = if busy || recovery_required {
        (Vec::new(), false, Value::Null)
    } else {
        let (files, truncated, complete) = files(&checkout(directory, &repo)?, check)?;
        // Do not ask Git to read paths beyond the native validated tree bound.
        let changes = if complete {
            review_changes(directory, &repo, ticket, deadline, check)?
        } else {
            Value::Null
        };
        (
            files,
            truncated || changes.is_null() || changes["truncated"] == true,
            changes,
        )
    };
    check()?;
    if jobs.repository_binding(&target.job_id, target.job_generation)? != binding {
        return Err("The exact command repository changed during review.".into());
    }
    let current = copy_manager::owned_repository_in_account(
        directory,
        &binding.repository_id,
        account,
        &target.workspace_id,
        &target.agent_id,
    )?;
    binding.check(&current)?;
    Ok(
        json!({"jobId":target.job_id,"jobGeneration":target.job_generation,"repository":repo,
        "changes":changes,"files":files,"truncated":truncated,"busy":busy,"recoveryRequired":recovery_required}),
    )
}

pub(crate) async fn receive_review(
    state: Arc<LocalComputerState>,
    target: ReviewRequest,
) -> Result<Value, String> {
    target.validate()?;
    let account = crate::account_session::binding()?.to_owned();
    let fence = crate::account_session::AccountDispatchFence::capture()?;
    state.validate_target(&target.workspace_id, &target.agent_id)?;
    let ticket = state
        .authority_for(&target.workspace_id, &target.agent_id)?
        .begin_viewer(target.expected_generation)?;
    let directory = state
        .scope(&target.workspace_id, &target.agent_id)?
        .directory
        .join("coding");
    let jobs = state.command_jobs(&target.workspace_id, &target.agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        let check = || {
            ticket.check()?;
            if Instant::now() >= deadline {
                return Err("Repository review expired. Refresh to try again.".into());
            }
            fence.with_current(|| Ok(()))
        };
        let result = inspect_in(
            &directory, &jobs, &target, &account, &ticket, deadline, &check,
        );
        fence.with_current(|| ticket.finish(result))
    })
    .await
    .map_err(|_| "The repository review did not complete. Refresh to try again.".to_owned())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_command_repository(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: String,
    job_generation: u64,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Repository review belongs to the main window.".into());
    }
    let target = ReviewRequest {
        workspace_id,
        agent_id,
        expected_generation,
        job_id,
        job_generation,
    };
    target.validate()?;
    let handoff = crate::background_worker::commands::foreground_fence("command-jobs")?;
    if crate::background_worker::commands::should_route("command-jobs")? {
        drop(handoff);
        return crate::background_worker::commands::review_repository(target).await;
    }
    let _handoff = handoff;
    receive_review(state.inner().clone(), target).await
}

#[cfg(test)]
#[path = "job_review_tests.rs"]
mod tests;
