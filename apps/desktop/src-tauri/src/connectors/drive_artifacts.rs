//! Native-custody Drive uploads through the existing exact connector approval.
use crate::{
    authorized_scope::{self, AuthorizedCommandScope, ScopeAccess},
    local_computer::{
        artifacts::{self, VerifiedUploadArtifact},
        authority::OperationTicket,
        LocalComputerState,
    },
    models::{ConnectorActionRequest, ConnectorActionResult, ConnectorCommandError},
};
use serde::Deserialize;
use std::{collections::BTreeMap, future::Future, time::Duration};

pub(super) const ACTION: &str = "google-drive.upload-artifact";
const DRIVE: &str = "google-drive";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactSource {
    pub agent_id: String,
    pub generation: u64,
}

fn failure(message: &str) -> ConnectorCommandError {
    super::command_error("conflict", DRIVE, message, false)
}
fn field<'a>(
    payload: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, ConnectorCommandError> {
    payload.get(key).map(String::as_str).ok_or_else(|| {
        failure("This upload is missing its native source binding. Prepare it again.")
    })
}

fn validate_destination(payload: &BTreeMap<String, String>) -> Result<(), ConnectorCommandError> {
    let id = field(payload, "destinationFolderId")?;
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
    {
        return Err(failure(
            "Choose an exact Drive folder ID, or root for My Drive.",
        ));
    }
    Ok(())
}

pub(super) fn prepare(
    computers: &LocalComputerState,
    workspace: &str,
    source: Option<ArtifactSource>,
    mut payload: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, ConnectorCommandError> {
    if payload.len() != 2
        || !payload.contains_key("artifactId")
        || !payload.contains_key("destinationFolderId")
    {
        return Err(failure("Supply only artifactId and destinationFolderId. Mivlet resolves the deliverable bytes and filename."));
    }
    validate_destination(&payload)?;
    let source = source.ok_or_else(|| {
        failure("A saved agent's current computer is required for a deliverable upload.")
    })?;
    computers
        .validate_target(workspace, &source.agent_id)
        .map_err(|e| failure(&e))?;
    let ticket = computers
        .begin_agent_operation(workspace, &source.agent_id, source.generation)
        .map_err(|e| failure(&e))?;
    let upload = artifacts::verified_upload_artifact(
        computers,
        workspace,
        &source.agent_id,
        source.generation,
        field(&payload, "artifactId")?,
    )
    .map_err(|e| failure(&e))?;
    let scope = authorized_scope::command_scope(Some(workspace.into()), None, ScopeAccess::Write)
        .map_err(|e| failure(&e))?;
    let store = crate::store::try_global()
        .ok_or_else(|| failure("The encrypted account store is unavailable."))?;
    let connection = super::selected_connection_evidence(store, &scope, DRIVE)?;
    for (key, value) in [
        ("sourceWorkspaceId", workspace.into()),
        ("sourceAgentId", source.agent_id),
        ("sourceGeneration", source.generation.to_string()),
        ("filename", upload.file_name),
        ("mimeType", upload.mime_type),
        ("sha256", upload.sha256),
        ("sizeBytes", upload.bytes.len().to_string()),
        ("sourceConnectionId", connection.connection_id),
        ("sourceConnectionRevision", connection.revision.to_string()),
    ] {
        payload.insert(key.into(), value);
    }
    ticket.finish(Ok(payload)).map_err(|e| failure(&e))
}

pub(super) struct Upload {
    ticket: OperationTicket,
    scope: AuthorizedCommandScope,
    payload: BTreeMap<String, String>,
    artifact: VerifiedUploadArtifact,
}
impl Upload {
    pub(super) fn admit(
        computers: &LocalComputerState,
        workspace: &str,
        action: &ConnectorActionRequest,
    ) -> Result<Self, ConnectorCommandError> {
        let payload = &action.payload;
        if action.connector_id != DRIVE || action.action != ACTION || payload.len() != 11 {
            return Err(failure("The prepared upload is invalid."));
        }
        verify_workspace(payload, workspace)?;
        validate_destination(payload)?;
        let agent = field(payload, "sourceAgentId")?;
        let generation = field(payload, "sourceGeneration")?
            .parse::<u64>()
            .map_err(|_| failure("The upload generation is invalid."))?;
        computers
            .validate_target(workspace, agent)
            .map_err(|e| failure(&e))?;
        let ticket = computers
            .begin_agent_operation(workspace, agent, generation)
            .map_err(|e| failure(&e))?;
        let artifact = artifacts::verified_upload_artifact(
            computers,
            workspace,
            agent,
            generation,
            field(payload, "artifactId")?,
        )
        .map_err(|e| failure(&e))?;
        verify_bytes(payload, &artifact)?;
        let scope =
            authorized_scope::command_scope(Some(workspace.into()), None, ScopeAccess::Write)
                .map_err(|e| failure(&e))?;
        let upload = Self {
            ticket,
            scope,
            payload: payload.clone(),
            artifact,
        };
        upload.require_current()?;
        Ok(upload)
    }
    fn require_current(&self) -> Result<(), ConnectorCommandError> {
        self.ticket.check().map_err(|e| failure(&e))?;
        crate::execution_control::ensure_active_execution_allowed().map_err(|e| failure(&e))?;
        let current = authorized_scope::command_scope(
            Some(self.scope.data.workspace_id().into()),
            None,
            ScopeAccess::Write,
        )
        .map_err(|e| failure(&e))?;
        if current != self.scope {
            return Err(failure(
                "The workspace account changed. Prepare the upload again.",
            ));
        }
        let store = crate::store::try_global()
            .ok_or_else(|| failure("The encrypted account store is unavailable."))?;
        let connection = super::selected_connection_evidence(store, &current, DRIVE)?;
        verify_connection(
            &self.payload,
            &connection.connection_id,
            connection.revision,
        )
    }
    pub(super) async fn execute(
        self,
        app: &tauri::AppHandle,
        action: &ConnectorActionRequest,
        expected_connection: &str,
    ) -> Result<ConnectorActionResult, ConnectorCommandError> {
        if expected_connection != field(&self.payload, "sourceConnectionId")? {
            return Err(failure("The approved Drive account changed."));
        }
        self.require_current()?;
        let provider = crate::google::upload_artifact(
            app,
            action,
            expected_connection,
            &self.artifact,
            || self.require_current(),
        );
        guard_future(provider, || self.require_current()).await
    }
}

fn verify_bytes(
    payload: &BTreeMap<String, String>,
    artifact: &VerifiedUploadArtifact,
) -> Result<(), ConnectorCommandError> {
    if field(payload, "sha256")? != artifact.sha256
        || field(payload, "filename")? != artifact.file_name
        || field(payload, "mimeType")? != artifact.mime_type
        || field(payload, "sizeBytes")? != artifact.bytes.len().to_string()
    {
        return Err(failure(
            "The approved deliverable changed. Prepare the upload again.",
        ));
    }
    Ok(())
}
fn verify_connection(
    payload: &BTreeMap<String, String>,
    id: &str,
    revision: i64,
) -> Result<(), ConnectorCommandError> {
    if field(payload, "sourceConnectionId")? != id
        || field(payload, "sourceConnectionRevision")? != revision.to_string()
    {
        return Err(failure(
            "The Drive connection changed. Prepare the upload again.",
        ));
    }
    Ok(())
}

fn verify_workspace(
    payload: &BTreeMap<String, String>,
    workspace: &str,
) -> Result<(), ConnectorCommandError> {
    if field(payload, "sourceWorkspaceId")? != workspace {
        return Err(failure("This upload belongs to another workspace."));
    }
    Ok(())
}

async fn guard_future<T>(
    future: impl Future<Output = Result<T, ConnectorCommandError>>,
    require_current: impl Fn() -> Result<(), ConnectorCommandError>,
) -> Result<T, ConnectorCommandError> {
    require_current()?;
    tokio::pin!(future);
    let mut poll = tokio::time::interval(Duration::from_millis(20));
    loop {
        tokio::select! { biased;
            _ = poll.tick() => {
                if require_current().is_err() { return Err(failure("Upload stopped or authority changed. Verify Drive before retrying; no automatic retry occurred.")); }
            }
            result = &mut future => {
                if require_current().is_err() { return Err(failure("Upload authority changed. Verify Drive before retrying; no automatic retry occurred.")); }
                return result;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    #[test]
    fn binds_exact_bytes_name_mime_and_connection_revision() {
        let artifact = VerifiedUploadArtifact {
            bytes: vec![0, 255, 42],
            file_name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            sha256: "digest".into(),
        };
        let payload = BTreeMap::from([
            ("sourceWorkspaceId".into(), "workspace".into()),
            ("sha256".into(), "digest".into()),
            ("filename".into(), "report.pdf".into()),
            ("mimeType".into(), "application/pdf".into()),
            ("sizeBytes".into(), "3".into()),
            ("sourceConnectionId".into(), "selected".into()),
            ("sourceConnectionRevision".into(), "4".into()),
        ]);
        verify_bytes(&payload, &artifact).unwrap();
        verify_connection(&payload, "selected", 4).unwrap();
        for field in ["sha256", "filename", "mimeType", "sizeBytes"] {
            let mut changed = payload.clone();
            changed.insert(field.into(), "changed".into());
            assert!(verify_bytes(&changed, &artifact).is_err());
        }
        assert!(verify_connection(&payload, "other", 4).is_err());
        assert!(verify_connection(&payload, "selected", 5).is_err());
        verify_workspace(&payload, "workspace").unwrap();
        assert!(verify_workspace(&payload, "other-workspace").is_err());
        assert!(validate_destination(&BTreeMap::from([(
            "destinationFolderId".into(),
            "https://evil.test".into()
        )]))
        .is_err());
    }
    #[tokio::test]
    async fn revoked_upload_drops_the_provider_future_without_retry() {
        let current = Arc::new(AtomicBool::new(true));
        let flag = current.clone();
        let started = Arc::new(AtomicBool::new(false));
        let probe = started.clone();
        let task = tokio::spawn(async move {
            guard_future(
                async {
                    probe.store(true, Ordering::Release);
                    std::future::pending::<Result<(), ConnectorCommandError>>().await
                },
                || {
                    if flag.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(failure("revoked"))
                    }
                },
            )
            .await
        });
        while !started.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        current.store(false, Ordering::Release);
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.message.contains("Verify Drive before retrying"));
        assert!(!error.retryable);
        let never = Arc::new(AtomicBool::new(false));
        let probe = never.clone();
        assert!(guard_future(
            async {
                probe.store(true, Ordering::Release);
                Ok(())
            },
            || Err(failure("revoked"))
        )
        .await
        .is_err());
        assert!(!never.load(Ordering::Acquire));
    }
}
