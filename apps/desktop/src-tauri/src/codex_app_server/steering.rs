//! Provider-specific live input and bounded cancellation. Work remains canonical.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SteeringDelivery {
    Accepted,
    Rejected,
    Uncertain,
}
impl SteeringDelivery {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Uncertain => "uncertain",
        }
    }
}

fn steering_reply_accepted(value: &Value, expected: &str) -> bool {
    value.get("method").is_none()
        && value.get("error").is_none()
        && value.pointer("/result/turnId").and_then(Value::as_str) == Some(expected)
}

pub(super) fn observe_route(request_id: &str, value: &Value) {
    let Ok(mut runs) = active_runs().lock() else {
        return;
    };
    let Some(run) = runs.get_mut(request_id) else {
        return;
    };
    if let Some(id) = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|_| value.get("method").is_none())
    {
        if let Some((expected, sender)) = run.steering.remove(id) {
            let _ = sender.send(steering_reply_accepted(value, &expected));
        }
    }
    if is_rpc_response(value, 2) {
        run.thread_id = value
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .map(Into::into);
    }
    match value.get("method").and_then(Value::as_str) {
        Some("turn/started") => {
            run.turn_id = value
                .pointer("/params/turn/id")
                .and_then(Value::as_str)
                .map(Into::into)
        }
        Some("turn/completed") => run.turn_id = None,
        _ => {}
    }
}

/// Official turn/steer protocol: exact active thread and expectedTurnId come
/// only from this adapter's observed events. No renderer-supplied provider IDs.
/// An acknowledgement confirms acceptance, not that earlier actions were undone.
pub(crate) fn steer_active_turn(attempt: &str, event: &str, text: &str) -> SteeringDelivery {
    if crate::execution_control::ensure_active_execution_allowed().is_err() {
        return SteeringDelivery::Rejected;
    }
    let Ok(fence) = crate::account_session::AccountDispatchFence::capture() else {
        return SteeringDelivery::Rejected;
    };
    let rpc = format!("mivlet-steer:{event}");
    let (send, receive) = mpsc::channel();
    let prepared = fence.with_current(|| {
        let mut runs = active_runs().lock().map_err(|_| "Codex state is unavailable.")?;
        let (request_id, run) = runs.iter_mut().find(|(_, run)| run.run_id.as_deref() == Some(attempt)).ok_or("The exact Codex attempt is no longer active.")?;
        let thread = run.thread_id.clone().ok_or("The Codex thread has not started.")?;
        let turn = run.turn_id.clone().ok_or("The Codex turn has already ended or has not started.")?;
        if run.steering.len() >= 16 || *run.image_delivery_stopped.lock().map_err(|_| "Codex was stopped.")? {
            return Err("Codex steering is unavailable.".into());
        }
        run.steering.insert(rpc.clone(), (turn.clone(), send));
        Ok((request_id.to_string(), run.stdin.clone(), run.image_delivery_stopped.clone(), json!({"id":rpc,"method":"turn/steer","params":{"threadId":thread,"expectedTurnId":turn,"input":[{"type":"text","text":text.trim()}]}})))
    });
    let Ok((request_id, writer, stopped, payload)) = prepared else {
        return SteeringDelivery::Rejected;
    };
    // A stalled provider pipe must not retain the global run registry lock:
    // Stop/shutdown can always remove the run and terminate its child.
    let kill_request = request_id.clone();
    let write = bounded_write(
        move || {
            if *stopped
                .lock()
                .map_err(|_| "Codex stop state is unavailable.")?
            {
                return Err("Codex was stopped.".into());
            }
            write_json_line(&writer, &payload)
        },
        Duration::from_secs(3),
        || {
            let _ = shutdown_codex_app_server_turn(kill_request);
        },
    );
    if !write {
        // Before registration, nothing was sent. A registered write failure may
        // have delivered a prefix, so it must never be retried automatically.
        if let Ok(mut runs) = active_runs().lock() {
            if let Some(run) = runs
                .values_mut()
                .find(|run| run.run_id.as_deref() == Some(attempt))
            {
                run.steering.remove(&rpc);
            }
        }
        return SteeringDelivery::Uncertain;
    }
    let delivery = match receive.recv_timeout(Duration::from_secs(3)) {
        Ok(true) => SteeringDelivery::Accepted,
        Ok(false) => SteeringDelivery::Rejected,
        Err(_) => SteeringDelivery::Uncertain,
    };
    if delivery == SteeringDelivery::Uncertain {
        let _ = shutdown_codex_app_server_turn(request_id);
    }
    if let Ok(mut runs) = active_runs().lock() {
        if let Some(run) = runs
            .values_mut()
            .find(|run| run.run_id.as_deref() == Some(attempt))
        {
            run.steering.remove(&rpc);
        }
    }
    delivery
}

/// A pipe may stop draining. Its writer owns neither identity nor registry
/// locks, and timeout terminates the exact supervised child to release it.
fn bounded_write(
    write: impl FnOnce() -> Result<(), String> + Send + 'static,
    timeout: Duration,
    kill: impl FnOnce(),
) -> bool {
    let (send, receive) = mpsc::channel();
    let started = thread::Builder::new()
        .name("mivlet-codex-guidance".into())
        .spawn(move || {
            let _ = send.send(write());
        });
    if started.is_err() {
        kill();
        return false;
    }
    if matches!(receive.recv_timeout(timeout), Ok(Ok(()))) {
        true
    } else {
        kill();
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stalled_provider_write_cannot_prevent_independent_kill() {
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;
        let writer = Arc::new(Mutex::new(()));
        let (release, blocked) = mpsc::channel();
        let (exited, finished) = mpsc::channel();
        let (entered, started) = mpsc::channel();
        let owned_writer = writer.clone();
        let result = super::bounded_write(
            move || {
                let _pipe = owned_writer.lock().unwrap();
                entered.send(()).unwrap();
                let _ = blocked.recv();
                let _ = exited.send(());
                Ok(())
            },
            Duration::from_millis(20),
            || {
                // Simulate exact child termination while its stdin is still held.
                started.recv_timeout(Duration::from_secs(1)).unwrap();
                assert!(writer.try_lock().is_err());
                release.send(()).unwrap();
            },
        );
        assert!(!result);
        finished.recv_timeout(Duration::from_secs(1)).unwrap();
    }
    #[test]
    fn steering_receipts_accept_only_the_exact_turn_response() {
        use serde_json::json;
        assert!(super::steering_reply_accepted(
            &json!({"result":{"turnId":"active-turn"}}),
            "active-turn"
        ));
        assert!(!super::steering_reply_accepted(
            &json!({"result":{"turnId":"newer-turn"}}),
            "active-turn"
        ));
        assert!(!super::steering_reply_accepted(
            &json!({"error":{"code":-32601},"result":{"turnId":"active-turn"}}),
            "active-turn"
        ));
        assert!(!super::steering_reply_accepted(
            &json!({"method":"item/tool/call","result":{"turnId":"active-turn"}}),
            "active-turn"
        ));
        assert!(!super::steering_reply_accepted(
            &json!({"result":{}}),
            "active-turn"
        ));
    }
}
