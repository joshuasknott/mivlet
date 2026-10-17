use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Entry {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub version: u8,
    pub snapshot_id: String,
    pub repository_id: String,
    pub branch: String,
    pub base_commit: String,
    pub input_tree_id: String,
    pub manifest_sha256: String,
    pub files: Vec<Entry>,
    pub writable_paths: Vec<String>,
    pub total_bytes: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputManifest {
    pub version: u8,
    pub snapshot_id: String,
    pub input_manifest_sha256: String,
    pub output_manifest_sha256: String,
    pub files: Vec<Entry>,
    pub deleted_paths: Vec<String>,
    pub total_bytes: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskIdentity {
    pub local_workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub work_generation: u32,
    pub task_id: String,
    pub run_id: String,
}
impl TaskIdentity {
    pub(crate) fn from_binding(
        local_workspace: &str,
        binding: &crate::hosted_tasks::models::Binding,
    ) -> Result<Self, String> {
        let identity = Self {
            local_workspace_id: local_workspace.into(),
            agent_id: binding.agent_id.clone(),
            work_id: binding.work_id.clone(),
            work_generation: binding.work_generation,
            task_id: binding.task_id.clone(),
            run_id: binding.run_id.clone(),
        };
        identity.validate()?;
        Ok(identity)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        for value in [
            &self.local_workspace_id,
            &self.agent_id,
            &self.work_id,
            &self.task_id,
            &self.run_id,
        ] {
            crate::hosted_tasks::valid_id(value)?;
        }
        if self.work_generation == 0 {
            return Err("The coding task generation is invalid.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub version: u8,
    pub snapshot: Snapshot,
    pub task: TaskIdentity,
    pub account: String,
    pub scope_id: String,
    pub repository: super::super::RepositoryWorkBinding,
    pub full_tree_id: String,
    pub head: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub expected_generation: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportReceipt {
    pub snapshot_id: String,
    pub repository_id: String,
    pub output_manifest_sha256: String,
    pub output_tree_id: String,
    pub before_import_checkpoint_id: String,
    pub verification_invalidated: bool,
}
impl ImportReceipt {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !hex(&self.snapshot_id, 48)
            || !hex(&self.repository_id, 48)
            || !hex(&self.output_manifest_sha256, 64)
            || !hex(&self.output_tree_id, 64)
            || !hex(&self.before_import_checkpoint_id, 48)
            || !self.verification_invalidated
        {
            return Err("The native file import receipt failed validation.".into());
        }
        Ok(())
    }
}
