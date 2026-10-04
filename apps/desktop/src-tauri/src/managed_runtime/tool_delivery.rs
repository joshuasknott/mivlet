//! A consumed SDK reply never holds run/bridge locks while waiting on stdin.
//! Stop closes the supervised process tree independently of a blocked writer.
use super::{
    active_runs, shared_tool_response, terminate_claude_turn, write_json, ManagedToolResponse,
    ToolBridge,
};
use serde_json::Value;
use std::{
    process::ChildStdin,
    sync::{Arc, Mutex},
    time::Duration,
};

const MAX_WIRE_BYTES: usize = 2 * 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const FAILED: &str = "The tool response was not confirmed. No action or response was replayed; this provider turn stopped. Review its current outcome before starting another request.";

pub(super) struct Delivery {
    request: String,
    response: Value,
    stdin: Arc<Mutex<ChildStdin>>,
    bridge: Arc<Mutex<ToolBridge>>,
    child: Arc<Mutex<crate::provider_process::SupervisedChild>>,
}

pub(super) fn prepare(owner: &str, request: ManagedToolResponse) -> Result<Delivery, String> {
    let (stdin, bridge, child) = {
        let runs = active_runs()
            .lock()
            .map_err(|_| "The provider tool turn is unavailable.")?;
        let run = runs
            .get(&request.request_id)
            .ok_or("The provider tool turn has ended.")?;
        if run.owner != owner || run.provider_id != "claude" {
            return Err("The Mivlet tool response belongs to another provider turn.".into());
        }
        (
            run.stdin
                .clone()
                .ok_or("The provider tool transport has closed.")?,
            run.tool_bridge.clone(),
            run.child.clone(),
        )
    };
    let response = bridge
        .lock()
        .map_err(|_| "Mivlet tool responses are unavailable.")?
        .respond(
            &request.tool_request_id,
            &request.call_id,
            request.ok,
            &request.output,
        )?;
    let delivery = Delivery {
        request: request.tool_request_id.clone(),
        response: shared_tool_response(&request.tool_request_id, response),
        stdin,
        bridge,
        child,
    };
    // Bound the actual encoded SDK frame, including JSON escaping and wrappers.
    if delivery.response.to_string().len() > MAX_WIRE_BYTES {
        delivery.stop();
        return Err("The encoded tool response exceeds the SDK transport limit. This turn stopped without replay.".into());
    }
    Ok(delivery)
}

impl Delivery {
    fn current(&self, check_account: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        check_account()?;
        if self
            .bridge
            .lock()
            .map_err(|_| FAILED)?
            .delivering(&self.request)
        {
            Ok(())
        } else {
            Err(FAILED.into())
        }
    }
    fn stop(&self) {
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.stop();
        }
        let _ = terminate_claude_turn(&self.child);
    }
    pub(super) async fn send(
        self,
        check_account: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        if self.current(&check_account).is_err() {
            self.stop();
            return Err(FAILED.into());
        }
        let input = self.stdin.clone();
        let response = self.response.clone();
        let mut writer =
            tauri::async_runtime::spawn_blocking(move || write_json(&input, "claude", &response));
        let deadline = tokio::time::Instant::now() + WRITE_TIMEOUT;
        let mut interval = tokio::time::interval(Duration::from_millis(20));
        let result = loop {
            tokio::select! {
                result = &mut writer => break result.map_err(|_| FAILED.to_string()).and_then(|result| result),
                _ = interval.tick() => {
                    if tokio::time::Instant::now() >= deadline || self.current(&check_account).is_err() {
                        self.stop();
                        // Killing the tree releases its pipe, independently of the stdin lock.
                        let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
                        return Err(FAILED.into());
                    }
                }
            }
        };
        if result.is_err() || self.current(&check_account).is_err() {
            self.stop();
            return Err(FAILED.into());
        }
        self.bridge
            .lock()
            .map_err(|_| FAILED)?
            .finish_response(&self.request);
        Ok(())
    }
}

impl Drop for Delivery {
    fn drop(&mut self) {
        // An abandoned async command must not leave its detached pipe writer
        // delivering a consumed reply after its caller has gone away.
        let unfinished = self
            .bridge
            .lock()
            .map(|bridge| bridge.delivering(&self.request))
            .unwrap_or(true);
        if unfinished {
            self.stop();
        }
    }
}

#[cfg(test)]
#[path = "tool_delivery_tests.rs"]
mod tests;
