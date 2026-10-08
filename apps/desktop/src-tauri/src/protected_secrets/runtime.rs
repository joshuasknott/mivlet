use super::*;
use crate::{
    account_session::AccountDispatchFence,
    local_computer::{authority::OperationTicket, LocalComputerState},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

fn boot() -> Result<&'static str, Failure> {
    static BOOT: OnceLock<Result<String, Failure>> = OnceLock::new();
    BOOT.get_or_init(|| opaque("boot:"))
        .as_ref()
        .map(String::as_str)
        .map_err(|e| *e)
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
struct NativeFence {
    ticket: OperationTicket,
    account: AccountDispatchFence,
    expires: i64,
}
impl Fence for NativeFence {
    fn check(&self) -> Result<(), Failure> {
        if now() >= self.expires {
            return Err(Failure::Expired);
        }
        crate::account_session::ensure_current().map_err(|_| Failure::Stopped)?;
        crate::execution_control::ensure_active_execution_allowed()
            .map_err(|_| Failure::Stopped)?;
        self.ticket.check().map_err(|_| Failure::Stopped)
    }
    fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
        // Store preparation and execution-pause checks already completed.
        // Do not call check(): its preflight reads the same Store connection.
        // Match native input dispatch order: generation first, then the
        // nonblocking identity fence. Never wait for Stop while holding identity.
        self.ticket
            .with_current(|| {
                self.account.with_current(|| {
                    Ok(if now() >= self.expires {
                        Err(Failure::Expired)
                    } else {
                        operation()
                    })
                })
            })
            .map_err(|_| Failure::Stopped)?
    }
}

fn scope(workspace: &str, agent: &str, generation: u64) -> Result<Scope, String> {
    let authorized = crate::authorized_scope::command_scope(
        Some(workspace.into()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    Ok(Scope {
        account: authorized.internal_user_id,
        workspace: authorized.data.workspace_id().into(),
        agent: agent.into(),
        generation,
    })
}
fn service(store: &Store) -> Result<Service<'_, custody::NativeCustody>, Failure> {
    Ok(Service {
        store,
        custody: &custody::NativeCustody,
        boot: boot()?,
    })
}
fn decode<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|_| Failure::Invalid.to_string())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyInput {
    key_id: String,
    target_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyInput {
    key_id: String,
    target_id: String,
    body: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

/// Called only after execute_tool_call consumed the exact native approval.
pub(crate) fn execute(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    request: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    let scope = scope(workspace, agent, generation)?;
    let store = crate::store::try_global().ok_or("Protected request storage is unavailable.")?;
    let service = service(store).map_err(|e| e.to_string())?;
    // Protected capture needs generation/Stop, not a Computer Use plugin grant.
    let ticket = computers
        .authority_for(workspace, agent)?
        .begin_viewer(generation)?;
    let fence = NativeFence {
        ticket,
        account: AccountDispatchFence::capture()?,
        expires: now() + TTL_MS,
    };
    fence.check().map_err(|e| e.to_string())?;
    let result = match tool {
        "request-secret" => {
            let input: RequestInput = decode(arguments)?;
            input.validate().map_err(|e| e.to_string())?;
            computers.with_protected_input(workspace, agent, generation, request, || {
                let record = service
                    .begin(&scope, request, input.clone(), now(), &fence)
                    .map_err(|e| e.to_string())?;
                let answer = capture::prompt(&input, &|| {
                    fence.check().is_ok() && now() < record.expires_at
                });
                match answer {
                    Ok(value) => service
                        .answer(&record, value, now(), &fence)
                        .and_then(|public| {
                            serde_json::to_value(public).map_err(|_| Failure::History)
                        }),
                    Err(error) => {
                        let _custody = CUSTODY_LOCK
                            .lock()
                            .map_err(|_| Failure::Custody.to_string())?;
                        let status = if now() >= record.expires_at {
                            Status::Expired
                        } else if fence.check().is_err() {
                            Status::Stopped
                        } else {
                            Status::Failed
                        };
                        service
                            .close(&record.id, status)
                            .map_err(|e| e.to_string())?;
                        Err(if status == Status::Expired {
                            Failure::Expired
                        } else {
                            error
                        })
                    }
                }
                .map_err(|e| e.to_string())
            })?
        }
        "secret-request-status" => {
            let _: Empty = decode(arguments)?;
            serde_json::to_value(service.history(&scope).map_err(|e| e.to_string())?)
                .map_err(|_| Failure::History.to_string())?
        }
        "webhook-signing-install" => {
            let input: webhook::InstallInput = decode(arguments)?;
            serde_json::to_value(
                service
                    .install(&scope, input, now(), &fence)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|_| Failure::History.to_string())?
        }
        "webhook-signing-status" | "webhook-signing-remove" => {
            let input: KeyInput = decode(arguments)?;
            let status = if tool == "webhook-signing-remove" {
                service.revoke_key(&scope, &input.key_id, &input.target_id, &fence)
            } else {
                service.key_status(&scope, &input.key_id, &input.target_id)
            };
            let status = status.map_err(|e| e.to_string())?;
            if tool == "webhook-signing-remove" {
                crate::local_schedules::events::pause_revoked_key(
                    workspace,
                    agent,
                    &input.key_id,
                    &input.target_id,
                )?;
            }
            serde_json::to_value(status).map_err(|_| Failure::History.to_string())?
        }
        "webhook-signing-verify" => {
            let input: VerifyInput = decode(arguments)?;
            let verified = verify_webhook_signature(
                workspace,
                agent,
                &input.key_id,
                &input.target_id,
                input.body.as_bytes(),
                &input.signature,
            )?;
            json!({ "verified": verified, "workDispatched": false })
        }
        _ => return Err(Failure::Invalid.to_string()),
    };
    fence.check().map_err(|e| e.to_string())?;
    Ok(result)
}

/// Native event-ingress integration point. Authenticate the event separately,
/// deduplicate it, then use the existing Work authority; this API never queues.
pub(crate) fn verify_webhook_signature(
    workspace: &str,
    agent: &str,
    key_id: &str,
    target_id: &str,
    body: &[u8],
    signature: &str,
) -> Result<bool, String> {
    let scope = scope(workspace, agent, 0)?;
    let store = crate::store::try_global().ok_or("Protected request storage is unavailable.")?;
    let fence = AccountDispatchFence::capture()?;
    let result = service(store)
        .and_then(|s| s.verify(&scope, key_id, target_id, body, signature))
        .map_err(|e| e.to_string())?;
    fence.with_current(|| Ok(result))
}

/// Native-only event text scrubber; the renderer cannot call it or obtain a key.
pub(crate) fn redact_event_texts(
    workspace: &str,
    agent: &str,
    key_id: &str,
    target_id: &str,
    texts: &[String],
) -> Result<Vec<String>, String> {
    let scope = scope(workspace, agent, 0)?;
    let store = crate::store::try_global().ok_or("Protected request storage is unavailable.")?;
    let fence = AccountDispatchFence::capture()?;
    let result = service(store)
        .and_then(|service| service.redact_event_texts(&scope, key_id, target_id, texts))
        .map_err(|error| error.to_string())?;
    fence.with_current(|| Ok(result))
}

pub(crate) fn start_maintenance(computers: Arc<LocalComputerState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let computers = computers.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(store) = crate::store::try_global() {
                    if let Ok(service) = service(store) {
                        // Failures retain cleanup tombstones. Retry without
                        // logging platform error text or credential identifiers.
                        let _ = service.sweep(now(), |scope| {
                            crate::account_session::ensure_current().is_ok()
                                && computers
                                    .validate_viewer_generation(
                                        &scope.workspace,
                                        &scope.agent,
                                        scope.generation,
                                    )
                                    .is_ok()
                        });
                    }
                }
            })
            .await;
            if crate::account_session::is_restarting() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}
