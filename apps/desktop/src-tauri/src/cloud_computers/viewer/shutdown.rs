use std::{future::Future, time::Duration};

use super::{active_viewer, close_child, close_for_lifecycle};

const SHUTDOWN_REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The account is already closing and its main WebView has been destroyed.
/// Retain the outgoing viewer's native key until one bounded revoke attempt
/// completes. A timeout is uncertainty, never proof of remote termination.
pub(crate) async fn close_for_process(window: &tauri::WebviewWindow) -> Result<(), String> {
    bounded_close(
        || {
            let fence_result = active_viewer()
                .lock()
                .map_err(|_| "The native Instabox viewer is unavailable.".to_string())
                .and_then(|mut active| {
                    if let Some(active) = active.as_mut() {
                        active.fence.fence_native_close()?;
                    }
                    Ok(())
                });
            let child_result = close_child(window);
            fence_result.and(child_result)
        },
        async { close_for_lifecycle(window).await.map(|_| ()) },
        SHUTDOWN_REVOKE_TIMEOUT,
    )
    .await
}

async fn bounded_close(
    close_local: impl FnOnce() -> Result<(), String>,
    revoke_remote: impl Future<Output = Result<(), String>>,
    timeout: Duration,
) -> Result<(), String> {
    let local_result = close_local();
    // Remote cleanup is still useful if native child closure failed. Starting
    // it only after the local fence also covers a stalled serialization lock.
    tokio::time::timeout(timeout, revoke_remote)
        .await
        .map_err(|_| {
            "Instabox stream revocation was not confirmed before shutdown; the remote stream may remain active."
                .to_string()
        })??;
    local_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn local_close_precedes_any_remote_cleanup() {
        let closed = AtomicBool::new(false);
        let fence = std::sync::Mutex::new(
            super::super::ViewerFence::new(super::super::next_viewer_generation().unwrap())
                .unwrap(),
        );
        bounded_close(
            || {
                fence.lock().unwrap().fence_native_close()?;
                closed.store(true, Ordering::SeqCst);
                Ok(())
            },
            async {
                assert!(closed.load(Ordering::SeqCst));
                let mut fence = fence.lock().unwrap();
                let generation = fence.snapshot().generation;
                // This is the second fence taken by close_for_lifecycle once
                // it owns the serialization lock. It must reach revocation.
                fence.fence_native_close()?;
                assert_eq!(fence.snapshot().generation, generation);
                fence.acknowledge_revoke();
                assert_eq!(
                    fence.snapshot().revoke,
                    super::super::RevokeState::Acknowledged
                );
                Ok(())
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stalled_remote_cleanup_cannot_hold_shutdown_indefinitely() {
        let closed = AtomicBool::new(false);
        let result = bounded_close(
            || {
                closed.store(true, Ordering::SeqCst);
                Ok(())
            },
            std::future::pending(),
            Duration::from_millis(1),
        )
        .await;
        assert!(closed.load(Ordering::SeqCst));
        assert!(result.unwrap_err().contains("not confirmed"));
    }

    #[tokio::test]
    async fn local_failure_still_attempts_revoke_and_remains_visible() {
        let revoked = AtomicBool::new(false);
        let result = bounded_close(
            || Err("child closure failed".into()),
            async {
                revoked.store(true, Ordering::SeqCst);
                Ok(())
            },
            Duration::from_secs(1),
        )
        .await;
        assert!(revoked.load(Ordering::SeqCst));
        assert_eq!(result.unwrap_err(), "child closure failed");
    }

    #[tokio::test]
    async fn remote_failure_is_not_reported_as_success() {
        let result = bounded_close(
            || Ok(()),
            async { Err("revocation rejected".into()) },
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(result.unwrap_err(), "revocation rejected");
    }
}
