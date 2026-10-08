//! Separate bounded channel: a long command never prevents Status or Stop.
use super::{commands::Action, windows, PROTOCOL};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{os::windows::io::AsRawHandle, path::Path, sync::Arc, time::Duration};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer};
use windows_sys::Win32::Foundation::HANDLE;

const REQUEST_LIMIT: usize = 128 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;
const CONNECTIONS: usize = 8;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    account: String,
    generation: u64,
    action: Action,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Response {
    protocol: u32,
    result: Result<Value, String>,
}
fn name(root: &Path) -> String {
    format!("{}-commands", windows::pipe_name(root))
}
pub(super) fn server(root: &Path, first: bool) -> Result<NamedPipeServer, String> {
    // Small kernel buffers; the bounded framing code controls allocation.
    windows::server_named(&name(root), first, CONNECTIONS + 1, 4096)
}

fn generation() -> Result<u64, String> {
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    super::persistence::generation(store)
}
fn validate(request: &Request, account: &str, generation: u64) -> Result<(), String> {
    if request.protocol != PROTOCOL
        || request.account != account
        || request.generation != generation
    {
        return Err("Background account or generation changed.".into());
    }
    Ok(())
}

pub(super) async fn request(action: Action) -> Result<Value, String> {
    let mut pipe = ClientOptions::new()
        .open(name(crate::account_session::root()?))
        .map_err(|_| {
            "Background command owner is unavailable; inspect saved jobs before retrying."
        })?;
    let _peer = windows::peer(pipe.as_raw_handle() as HANDLE, false)?;
    let request = Request {
        protocol: PROTOCOL,
        account: crate::account_session::binding()?.into(),
        generation: generation()?,
        action,
    };
    tokio::time::timeout(
        Duration::from_secs(3),
        windows::write_frame(&mut pipe, &request, REQUEST_LIMIT),
    )
    .await
    .map_err(|_| {
        "Background admission was not acknowledged. Inspect saved jobs; do not replay it."
    })??;
    // Existing native tool limits still bound execution. Dropping this view or
    // its pipe never cancels an already approved native job.
    let response: Response = tokio::time::timeout(
        Duration::from_secs(1900),
        windows::read_frame(&mut pipe, RESPONSE_LIMIT),
    )
    .await
    .map_err(|_| "Background receipt timed out. Inspect saved jobs before retrying.")??;
    if response.protocol != PROTOCOL {
        return Err("Reconnect after updating Mivlet.".into());
    }
    response.result
}

pub(super) async fn serve(app: tauri::AppHandle, mut pipe: NamedPipeServer) {
    let permits = Arc::new(tokio::sync::Semaphore::new(CONNECTIONS));
    let tools = Arc::new(tokio::sync::Semaphore::new(4));
    while !super::stopping() {
        match tokio::time::timeout(Duration::from_millis(250), pipe.connect()).await {
            Err(_) => continue,
            Ok(Err(_)) => {
                super::stop();
                break;
            }
            Ok(Ok(())) => {}
        }
        let permit = match permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                drop(pipe);
                pipe = match crate::account_session::root().and_then(|root| server(root, false)) {
                    Ok(next) => next,
                    Err(_) => {
                        super::stop();
                        break;
                    }
                };
                continue;
            }
        };
        let next = match crate::account_session::root().and_then(|root| server(root, false)) {
            Ok(next) => next,
            Err(_) => {
                super::stop();
                break;
            }
        };
        let connected = std::mem::replace(&mut pipe, next);
        let app = app.clone();
        let tools = tools.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let mut pipe = connected;
            let request = tokio::time::timeout(Duration::from_secs(3), async {
                let _peer = windows::peer(pipe.as_raw_handle() as HANDLE, true)?;
                let request: Request = windows::read_frame(&mut pipe, REQUEST_LIMIT).await?;
                crate::account_session::ensure_current()?;
                validate(&request, crate::account_session::binding()?, generation()?)?;
                Ok::<_, String>(request)
            })
            .await;
            let result = match request {
                Ok(Ok(request)) => {
                    let tool_permit = if matches!(&request.action, Action::Tool { .. }) {
                        Some(tools.try_acquire_owned())
                    } else {
                        None
                    };
                    if tool_permit.as_ref().is_some_and(Result::is_err) {
                        Err("Background command capacity is full. Inspect current jobs before retrying.".into())
                    } else {
                        let _tool_permit = tool_permit;
                        super::commands::dispatch(&app, request.action).await
                    }
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err("Background command admission expired.".into()),
            };
            let response = Response {
                protocol: PROTOCOL,
                result: result
                    .map_err(|error| crate::secret_redaction::redact_secret_text_or_omit(&error)),
            };
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                windows::write_frame(&mut pipe, &response, RESPONSE_LIMIT),
            )
            .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    #[test]
    fn command_envelope_rejects_other_accounts_generations_and_versions() {
        let mut request = Request {
            protocol: PROTOCOL,
            account: "fixture-account".into(),
            generation: 7,
            action: Action::Scope {
                workspace: "workspace".into(),
                agent: "agent".into(),
            },
        };
        assert!(validate(&request, "fixture-account", 7).is_ok());
        assert!(validate(&request, "other-account", 7).is_err());
        assert!(validate(&request, "fixture-account", 8).is_err());
        request.protocol += 1;
        assert!(validate(&request, "fixture-account", 7).is_err());
    }
    #[tokio::test]
    async fn command_frame_checks_its_own_bound_before_allocating_a_body() {
        let (mut sender, mut receiver) = tokio::io::duplex(16);
        sender.write_u32_le(REQUEST_LIMIT as u32 + 1).await.unwrap();
        assert!(
            windows::read_frame::<_, Request>(&mut receiver, REQUEST_LIMIT)
                .await
                .is_err()
        );
    }
}
