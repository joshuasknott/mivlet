//! A task remembers the selected native copy; later selection is never consent
//! to move queued or interrupted work to another repository.
use super::{copy_manager, load, lock, Repository};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryWorkBinding {
    pub version: u8,
    pub repository_id: String,
    pub branch: String,
    pub base_commit: String,
    pub captured_at: String,
}

#[derive(Clone)]
pub(crate) struct TaskRepository {
    pub(crate) binding: RepositoryWorkBinding,
    account: String,
    workspace: String,
    agent: String,
    restore_intent: bool,
}
impl TaskRepository {
    /// Native saga intent supplies the immutable binding after matching its
    /// exact consumed request. This constructor grants no operation permission.
    pub(crate) fn for_restore(
        binding: RepositoryWorkBinding,
        workspace: &str,
        agent: &str,
    ) -> Result<Self, String> {
        if !binding.valid() {
            return Err("The saved task repository binding needs review.".into());
        }
        Ok(Self {
            binding,
            account: crate::account_session::binding()?.into(),
            workspace: workspace.into(),
            agent: agent.into(),
            restore_intent: true,
        })
    }
    pub(crate) fn requires_restore_intent(&self) -> bool {
        self.restore_intent
    }
    pub(super) fn load(&self, directory: &Path) -> Result<Repository, String> {
        let repo = copy_manager::owned_repository_in_account(
            directory,
            &self.binding.repository_id,
            &self.account,
            &self.workspace,
            &self.agent,
        )?;
        self.binding.check(&repo)?;
        Ok(repo)
    }

    #[cfg(test)]
    pub(super) fn for_test(
        binding: RepositoryWorkBinding,
        account: &str,
        workspace: &str,
        agent: &str,
    ) -> Self {
        Self {
            binding,
            account: account.into(),
            workspace: workspace.into(),
            agent: agent.into(),
            restore_intent: false,
        }
    }
}

impl RepositoryWorkBinding {
    fn from_repository(repo: &Repository, captured_at: &str) -> Result<Self, String> {
        let binding = Self {
            version: 1,
            repository_id: repo.id.clone(),
            branch: repo.branch.clone(),
            base_commit: repo.base.clone(),
            captured_at: captured_at.into(),
        };
        binding.check(repo)?;
        Ok(binding)
    }

    pub(super) fn valid(&self) -> bool {
        fn hex(value: &str, size: usize) -> bool {
            value.len() == size && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        self.version == 1
            && hex(&self.repository_id, 48)
            && (hex(&self.base_commit, 40) || hex(&self.base_commit, 64))
            && !self.branch.is_empty()
            && self.branch.len() <= 256
            && !self.branch.chars().any(char::is_control)
            && chrono::DateTime::parse_from_rfc3339(&self.captured_at).is_ok()
    }

    pub(super) fn check(&self, repo: &Repository) -> Result<(), String> {
        if !self.valid()
            || self.repository_id != repo.id
            || self.branch != repo.branch
            || self.base_commit != repo.base
        {
            return Err("This task belongs to a different repository copy. Select its original copy or start a fresh task with the intended repository.".into());
        }
        Ok(())
    }
}

/// Called while admission owns the canonical Work connection. It uses the same
/// nonblocking lock when available, and only reads atomic metadata if a command
/// owns it. Queueing a conversation never needs to interrupt a persistent job.
pub(crate) fn capture_work_repository(
    workspace: &str,
    agent: &str,
    captured_at: &str,
) -> Result<Option<RepositoryWorkBinding>, String> {
    #[cfg(test)]
    if crate::account_session::binding().is_err() {
        return Ok(None);
    }
    let root = crate::account_session::root()?.join("local-computers");
    let scope = super::super::computer_scope(&root, workspace, agent)?;
    capture_in(
        &scope.directory.join("coding"),
        workspace,
        agent,
        captured_at,
    )
}

fn capture_in(
    directory: &Path,
    workspace: &str,
    agent: &str,
    captured_at: &str,
) -> Result<Option<RepositoryWorkBinding>, String> {
    if !directory.exists() {
        return Ok(None);
    }
    let mutex = lock(directory)?;
    let _guard = mutex.try_lock().ok();
    let Some(repo) = load(directory)? else {
        return Ok(None);
    };
    let owned = copy_manager::owned_repository(directory, &repo.id, workspace, agent)?;
    if repo.id != owned.id || repo.branch != owned.branch || repo.base != owned.base {
        return Err("Repository selection and retained copy disagree. Inspect the repository before starting work.".into());
    }
    if load(directory)?.is_none_or(|selected| {
        selected.id != repo.id || selected.branch != repo.branch || selected.base != repo.base
    }) {
        return Err("The selected repository changed while this task was being prepared. Send the request again after selection finishes.".into());
    }
    RepositoryWorkBinding::from_repository(&owned, captured_at).map(Some)
}

/// Returns the exact binding of the unique current assignment. Library actions
/// outside an executing assignment retain their existing user-only flow.
pub(super) fn executing_binding(
    workspace: &str,
    agent: &str,
) -> Result<Option<TaskRepository>, String> {
    let account = crate::account_session::binding()?;
    let store = crate::store::try_global().ok_or("The native Work store is unavailable.")?;
    store
        .with_conn(|conn| {
            let scope = crate::authorized_scope::resolve(
                conn,
                Some(workspace),
                None,
                crate::authorized_scope::ScopeAccess::Read,
            )?;
            let work: Vec<crate::collaboration::models::Work> =
                crate::store::repos::collaboration::list(
                    conn,
                    store,
                    &scope.private,
                    crate::store::repos::collaboration::Kind::Work,
                )?;
            current_binding(
                work.iter()
                    .filter(|item| item.agent_id == agent && item.status.executing())
                    .map(|item| item.repository_binding.as_ref()),
            )
            .map_err(crate::store::StoreError::Invalid)
        })
        .map(|binding| {
            binding.map(|binding| TaskRepository {
                binding,
                account: account.into(),
                workspace: workspace.into(),
                agent: agent.into(),
                restore_intent: false,
            })
        })
        .map_err(|error| error.to_string())
}

fn current_binding<'a>(
    mut executing: impl Iterator<Item = Option<&'a RepositoryWorkBinding>>,
) -> Result<Option<RepositoryWorkBinding>, String> {
    let Some(binding) = executing.next() else {
        return Ok(None);
    };
    if executing.next().is_some() {
        return Err("More than one current task could own this repository operation. Stop or finish the other task before continuing.".into());
    }
    binding.cloned().map(Some).ok_or_else(|| {
        "This task has no saved repository selection. Attach the intended repository, then start a fresh task; the previous task was not moved to a new copy.".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> Repository {
        Repository {
            id: "a".repeat(48),
            name: "Task project".into(),
            branch: "mivlet/task".into(),
            base: "b".repeat(40),
            base_branch: "main".into(),
            remote: None,
            operation: "idle".into(),
            last_result: None,
            last_command: None,
            command_diff_id: None,
            publication: None,
        }
    }

    #[test]
    fn missing_storage_capture_neither_creates_files_nor_adopts_another_scope() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing");
        assert_eq!(
            capture_in(&missing, "workspace", "agent", "2026-10-17T12:00:00Z").unwrap(),
            None
        );
        assert!(!missing.exists());
    }

    #[test]
    fn task_identity_survives_edits_but_rejects_copy_branch_and_base_changes() {
        let mut repo = repository();
        let binding =
            RepositoryWorkBinding::from_repository(&repo, "2026-10-17T12:00:00Z").unwrap();
        repo.operation = "command running".into();
        repo.command_diff_id = Some("new-tree".into());
        binding.check(&repo).unwrap();
        for field in ["id", "branch", "base"] {
            let mut changed = repo.clone();
            match field {
                "id" => changed.id = "c".repeat(48),
                "branch" => changed.branch = "mivlet/other".into(),
                _ => changed.base = "d".repeat(40),
            }
            assert!(binding.check(&changed).is_err(), "{field}");
        }
    }

    #[test]
    fn missing_or_ambiguous_task_binding_never_adopts_current_selection() {
        let binding =
            RepositoryWorkBinding::from_repository(&repository(), "2026-10-17T12:00:00Z").unwrap();
        assert_eq!(current_binding(std::iter::empty()).unwrap(), None);
        assert!(current_binding([None].into_iter()).is_err());
        assert!(current_binding([Some(&binding), Some(&binding)].into_iter()).is_err());
        assert_eq!(
            current_binding([Some(&binding)].into_iter()).unwrap(),
            Some(binding)
        );
    }

    #[test]
    fn malformed_or_future_bindings_fail_closed() {
        let repo = repository();
        let binding =
            RepositoryWorkBinding::from_repository(&repo, "2026-10-17T12:00:00Z").unwrap();
        for (version, time) in [(2, binding.captured_at.as_str()), (1, "later")] {
            let mut invalid = binding.clone();
            invalid.version = version;
            invalid.captured_at = time.into();
            assert!(invalid.check(&repo).is_err());
        }
        assert!(
            serde_json::from_value::<RepositoryWorkBinding>(serde_json::json!({
                "version": 1, "repositoryId": binding.repository_id, "branch": binding.branch,
                "baseCommit": binding.base_commit, "capturedAt": binding.captured_at,
                "hostPath": "C:\\unrelated"
            }))
            .is_err()
        );
    }
}
