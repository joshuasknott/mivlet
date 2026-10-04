// Closing a session cancels native waits and discards unsent queued frames.

#[derive(Clone)]
struct SessionStop(tokio::sync::watch::Sender<bool>);

impl SessionStop {
    fn new() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }

    fn close(&self) {
        self.0.send_replace(true);
    }

    fn check(&self) -> Result<(), String> {
        if *self.0.borrow() {
            Err(
                "This MCP session was closed. External effects already accepted cannot be undone."
                    .into(),
            )
        } else {
            Ok(())
        }
    }

    async fn run<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut receiver = self.0.subscribe();
        self.check()?;
        tokio::select! {
            biased;
            _ = receiver.changed() => Err("This MCP session was closed. External effects already accepted cannot be undone.".into()),
            result = operation => { self.check()?; result }
        }
    }
}

fn require_remote_dispatch(session: &McpRemoteSession) -> Result<(), String> {
    session.stop.check()?;
    let scope = crate::authorized_scope::command_scope(
        Some(session.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    require_remote_session_owner(session, &scope)?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is not initialized.")?;
    store
        .with_conn(|tx| {
            let configuration = crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &session.configuration_reference,
            )?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("This MCP server is unavailable.".into())
            })?;
            if configuration.metadata.disabled
                || configuration.metadata.transport != "streamable-http"
                || configuration
                    .endpoint
                    .as_deref()
                    .and_then(|value| Url::parse(value).ok())
                    .as_ref()
                    != Some(&session.endpoint)
            {
                return Err(crate::store::StoreError::Invalid(
                    "This MCP server changed; reconnect before continuing.".into(),
                ));
            }
            let details = crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &session.configuration_reference,
            )?;
            if details.connection_id != session.connection_id
                || details.connection_revision != session.connection_revision
            {
                return Err(crate::store::StoreError::Invalid(
                    "This MCP Connection changed; reconnect before continuing.".into(),
                ));
            }
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    session.stop.check()
}

fn require_remote_response(session: &McpRemoteSession) -> Result<(), String> {
    require_remote_dispatch(session).map_err(|_| {
        "The MCP account or Connection changed after dispatch. The external operation may have completed; reconcile before any new attempt.".into()
    })
}

fn require_stdio_dispatch(session_id: &str, queued: &QueuedMcpFrame) -> Result<(), String> {
    let (workspace, owner, connection_id, revision, stop) = {
        let map = process_map()
            .lock()
            .map_err(|_| "Mivlet could not access MCP sessions.")?;
        let session = map
            .get(session_id)
            .ok_or("This local MCP session is closed.")?;
        (
            session.workspace_id.clone(),
            session.owner_subject.clone(),
            session.connection_id.clone(),
            session.connection_revision,
            session.stop.clone(),
        )
    };
    stop.check()?;
    if queued.connection_id != connection_id || queued.connection_revision != revision {
        return Err("The queued MCP Connection changed before dispatch.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(workspace.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    if scope.private.owner_subject() != owner {
        return Err("The MCP account changed.".into());
    }
    let value: Value =
        serde_json::from_str(&queued.frame).map_err(|_| "The MCP frame is invalid.")?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "tools/call" || method == "resources/read" {
        crate::execution_control::ensure_active_execution_allowed()?;
        let params = value
            .get("params")
            .ok_or("The MCP tool parameters are unavailable.")?;
        let proposal = McpToolProposal {
            operation: if method == "resources/read" {
                McpOperation::Resource
            } else {
                McpOperation::Tool
            },
            workspace_id: workspace,
            session_id: session_id.into(),
            tool_name: if method == "resources/read" {
                method.into()
            } else {
                params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("The MCP tool is unavailable.")?
                    .into()
            },
            arguments: if method == "resources/read" {
                params.clone()
            } else {
                params
                    .get("arguments")
                    .cloned()
                    .ok_or("The MCP tool arguments are unavailable.")?
            },
        };
        let current = validate_tool_proposal(&proposal)?;
        if current.connection_id != connection_id || current.connection_revision != revision {
            return Err("The MCP Connection changed before dispatch.".into());
        }
    }
    stop.check()
}

pub(crate) async fn shutdown_all() {
    let processes = process_map()
        .lock()
        .map(|mut map| {
            map.drain()
                .map(|(id, child)| {
                    child.stop.close();
                    (id, child)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let remote_ids = remote_sessions()
        .lock()
        .map(|mut sessions| {
            sessions
                .drain()
                .map(|(id, session)| {
                    session.stop.close();
                    id
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for id in remote_ids {
        drain_session_audits(&id);
    }
    for (id, mut process) in processes {
        drain_session_audits(&id);
        process.stdin.take();
        let _ = process.child.kill().await;
    }
    if let Ok(mut permits) = tool_permits().lock() {
        permits.clear();
    }
    if let Ok(mut proofs) = discovery_proofs().lock() {
        proofs.clear();
    }
    if let Ok(mut audits) = pending_audits().lock() {
        audits.clear();
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn close_cancels_a_pending_native_wait_and_cannot_be_reopened() {
        let stop = SessionStop::new();
        let pending = stop.run(std::future::pending::<Result<(), String>>());
        tokio::pin!(pending);
        assert!(timeout(Duration::from_millis(5), &mut pending)
            .await
            .is_err());
        stop.clone().close();
        assert!(timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .is_err());
        assert!(stop.run(async { Ok(()) }).await.is_err());
    }

    #[tokio::test]
    async fn close_discards_a_result_even_when_the_operation_finishes_at_the_same_time() {
        let stop = SessionStop::new();
        let result = stop
            .run(async {
                stop.close();
                Ok("late external response")
            })
            .await;
        assert!(result.is_err());
        let current = SessionStop::new();
        assert_eq!(
            current.run(async { Ok("current response") }).await.unwrap(),
            "current response"
        );
    }

    #[tokio::test]
    async fn close_aborts_a_blocked_pipe_and_prevents_the_next_queued_write() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let stop = SessionStop::new();
        let (mut writer, mut reader) = tokio::io::duplex(1);
        let pending = stop.run(async {
            writer
                .write_all(b"waiting frame")
                .await
                .map_err(|e| e.to_string())
        });
        tokio::pin!(pending);
        assert!(timeout(Duration::from_millis(5), &mut pending)
            .await
            .is_err());
        stop.close();
        assert!(timeout(Duration::from_secs(1), &mut pending)
            .await
            .unwrap()
            .is_err());
        let mut queued = Vec::new();
        assert!(stop
            .run(async {
                queued.extend_from_slice(b"queued frame");
                Ok(())
            })
            .await
            .is_err());
        assert!(queued.is_empty());
        let mut bytes = [0; 32];
        assert_eq!(reader.read(&mut bytes).await.unwrap(), 1);
    }
}
