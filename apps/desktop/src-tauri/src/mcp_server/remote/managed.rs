//! Closed managed transport adapter. No native HTML, PKCE, code, bearer token,
//! arbitrary route or response header leaves this boundary.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub version: u8,
    pub kind: String,
    pub connection_id: String,
    pub epoch: String,
    pub revision: u64,
    pub sequence: u64,
    pub request_id: String,
    pub operation: String,
    pub browser_session: Option<String>,
    pub body: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    version: u8,
    kind: &'static str,
    connection_id: String,
    epoch: String,
    revision: u64,
    sequence: u64,
    request_id: String,
    status: u16,
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<Cookie>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clear_session: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cookie {
    value: String,
    expires_in: i64,
}

const DATA_BYTES: usize = 60 * 1024;
fn bounded_data(mut data: Value) -> Option<Value> {
    let fits = |data: &Value| serde_json::to_vec(data).is_ok_and(|bytes| bytes.len() <= DATA_BYTES);
    if fits(&data) {
        return Some(data);
    }
    // Preserve complete entries and their native provenance. A large history
    // must not terminate the healthy connection or cancel unrelated Work.
    for key in ["work", "outputs"] {
        while data
            .get(key)
            .is_some_and(|value| value.as_array().is_some_and(|items| !items.is_empty()))
        {
            let count = {
                let items = data.get_mut(key)?.as_array_mut()?;
                items.pop();
                items.len()
            };
            data["truncated"] = json!(true);
            data["returnedCount"] = json!(count);
            if fits(&data) {
                return Some(data);
            }
        }
    }
    None
}

fn headers(engine: &Engine, session: Option<&str>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    if let Some(value) = session {
        if value.len() != 43
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(invalid("Connect this browser again."));
        }
        headers.insert(
            header::COOKIE,
            format!("{}={value}", cookie_name(engine))
                .parse()
                .map_err(|_| invalid("Invalid browser session."))?,
        );
    }
    Ok(headers)
}
pub(crate) fn execute(engine: &Engine, request: Request) -> Reply {
    let mut reply = Reply {
        version: 1,
        kind: "reply",
        connection_id: request.connection_id,
        epoch: request.epoch,
        revision: request.revision,
        sequence: request.sequence,
        request_id: request.request_id,
        status: 200,
        data: json!({}),
        session: None,
        clear_session: None,
    };
    let result = (|| -> Result<Value> {
        let headers = headers(engine, request.browser_session.as_deref())?;
        match request.operation.as_str() {
            "begin" => {
                if request.body != json!({}) {
                    return Err(invalid("Invalid connection request."));
                }
                let (id, ticket) = session::begin(engine, &headers)?;
                let oauth::Wait::Pending(consent) = oauth::wait(engine, &ticket)? else {
                    return Err(invalid("This browser connection request changed."));
                };
                reply.session = Some(Cookie {
                    value: id,
                    expires_in: 300,
                });
                // This is the desktop's public request/pairing code, never an
                // OAuth authorization code, state, ticket or bearer.
                Ok(json!({"pending":true,"pairingCode":consent.id}))
            }
            "consent" => {
                if request.body != json!({}) {
                    return Err(invalid("Invalid consent request."));
                }
                match session::managed_finish(engine, &headers)? {
                    None => Ok(json!({"pending":true})),
                    Some((id, seconds)) => {
                        reply.session = Some(Cookie {
                            value: id,
                            expires_in: seconds,
                        });
                        Ok(json!({"connected":true}))
                    }
                }
            }
            "session" => {
                let (token, grant) = session::authenticated(engine, &headers)?;
                let agents = tools::invoke(
                    engine,
                    &token,
                    "mivlet_agents",
                    json!({"workspaceId":grant.workspace_id}),
                )?;
                Ok(
                    json!({"workspaceId":grant.workspace_id,"access":grant.access,"expiresAt":grant.expires_at,"agents":agents["agents"]}),
                )
            }
            "call" => {
                let body: Call = serde_json::from_value(request.body)
                    .map_err(|_| invalid("Invalid task request."))?;
                invoke_call(engine, &headers, body)
            }
            "push-status" => push::status_value(engine, &headers),
            "push-subscribe" => {
                let mut headers = headers;
                headers.insert(
                    header::CONTENT_TYPE,
                    "application/json".parse().expect("fixed MIME"),
                );
                let body = serde_json::to_vec(&request.body)
                    .map_err(|_| invalid("Invalid notification request."))?;
                push::subscribe_value(engine, &headers, &body)?;
                Ok(json!({"updated":true}))
            }
            "disconnect" => {
                if let Ok(id) = cookie(engine, &headers) {
                    push::remove(engine, &hash(&id));
                    if let Ok(mut sessions) = engine.remote.lock() {
                        sessions.remove(&hash(&id));
                    }
                }
                reply.clear_session = Some(true);
                Ok(json!({"disconnected":true}))
            }
            _ => Err(invalid("This action is unavailable from the phone view.")),
        }
    })();
    match result {
        Ok(value) => match bounded_data(value) {
            Some(value) => reply.data = value,
            None => {
                reply.status = 503;
                reply.data = json!({"error":"This saved result is too large for the phone view. Open Mivlet on your computer to review it."});
            }
        },
        Err(_) => {
            // SQL/internal errors and authorization material are never reflected.
            reply.status = if matches!(request.operation.as_str(), "session" | "consent") {
                401
            } else {
                400
            };
            reply.data = json!({"error":"This request is unavailable. Refresh or reconnect this browser in Mivlet Settings."});
        }
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(operation: &str, session: Option<String>, body: Value) -> Request {
        Request {
            version: 1,
            kind: "request".into(),
            connection_id: "a".repeat(64),
            epoch: "b".repeat(32),
            revision: 1,
            sequence: 1,
            request_id: "request-test".into(),
            operation: operation.into(),
            browser_session: session,
            body,
        }
    }
    #[test]
    fn managed_consent_keeps_authorization_codes_and_tokens_native() {
        let engine = crate::mcp_server::tests::engine("https://phone.example");
        let begin = execute(&engine, request("begin", None, json!({})));
        assert_eq!(begin.status, 200);
        assert_eq!(begin.data["pending"], true);
        let opaque = begin.session.unwrap().value;
        let pending = engine.oauth.lock().unwrap().pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(begin.data["pairingCode"], pending[0].id);
        assert_eq!(begin.data.as_object().unwrap().len(), 2);
        let waiting = execute(&engine, request("consent", Some(opaque.clone()), json!({})));
        assert_eq!(waiting.data, json!({"pending":true}));
        oauth::decide(
            &engine,
            super::super::super::models::Decision {
                request_id: pending[0].id.clone(),
                approve: true,
                workspace_id: "default".into(),
                agent_ids: vec!["agent-one".into()],
                work_ids: vec![],
                access: super::super::super::models::Access::ReadOnly,
                lifetime_hours: 1,
            },
        )
        .unwrap();
        let approved = execute(&engine, request("consent", Some(opaque.clone()), json!({})));
        assert_eq!(approved.status, 200);
        assert_eq!(approved.data, json!({"connected":true}));
        let fresh = approved.session.unwrap().value;
        assert_ne!(fresh, opaque);
        assert_eq!(
            execute(&engine, request("session", Some(opaque), json!({}))).status,
            401
        );
        let current = execute(&engine, request("session", Some(fresh.clone()), json!({})));
        assert_eq!(current.data["agents"].as_array().unwrap().len(), 1);
        let serialized = serde_json::to_string(&current).unwrap();
        assert!(!serialized.contains("PRIVATE_INSTRUCTIONS_CANARY"));
        assert!(!serialized.contains("access_token"));
        let denied = execute(
            &engine,
            request(
                "call",
                Some(fresh),
                json!({"name":"mivlet_agents","arguments":{}}),
            ),
        );
        assert_eq!(denied.status, 400);
    }

    #[test]
    fn managed_calls_preserve_native_idempotency_push_and_grant_revocation() {
        let engine = crate::mcp_server::tests::engine("https://phone.example");
        let begin = execute(&engine, request("begin", None, json!({})));
        let opaque = begin.session.unwrap().value;
        let pending = engine.oauth.lock().unwrap().pending();
        oauth::decide(
            &engine,
            super::super::super::models::Decision {
                request_id: pending[0].id.clone(),
                approve: true,
                workspace_id: "default".into(),
                agent_ids: vec!["agent-one".into()],
                work_ids: vec![],
                access: super::super::super::models::Access::RequestTasks,
                lifetime_hours: 1,
            },
        )
        .unwrap();
        let fresh = execute(&engine, request("consent", Some(opaque), json!({})))
            .session
            .unwrap()
            .value;
        let body = json!({"name":"mivlet_request_task","arguments":{"workspaceId":"default","agentId":"agent-one","requestId":"managed-original-write","text":"Review this request"}});
        let first = execute(&engine, request("call", Some(fresh.clone()), body.clone()));
        assert_eq!(first.status, 200);
        assert_eq!(
            execute(&engine, request("call", Some(fresh.clone()), body)).data,
            first.data
        );
        let push = execute(
            &engine,
            request("push-status", Some(fresh.clone()), json!({})),
        );
        assert_eq!(push.status, 200);
        assert!(push.data["publicKey"]
            .as_str()
            .is_some_and(|key| key.len() == 87));
        assert_eq!(
            execute(
                &engine,
                request(
                    "push-subscribe",
                    Some(fresh.clone()),
                    json!({"endpoint":"https://127.0.0.1/private"})
                )
            )
            .status,
            400
        );
        engine
            .transaction(|conn, scope, saved| {
                for grant in &mut saved.grants {
                    grant.revoked = true;
                }
                saved.tokens.clear();
                crate::collaboration::external::stop_grant(conn, engine.store, scope, None)
            })
            .unwrap();
        assert_eq!(
            execute(&engine, request("session", Some(fresh.clone()), json!({}))).status,
            401
        );
        assert_eq!(
            execute(&engine, request("push-status", Some(fresh), json!({}))).status,
            400
        );
    }

    #[test]
    fn long_shared_history_and_unicode_results_stay_bounded_without_failing_transport() {
        let request = "🦔".repeat(2000);
        let history = json!({"work":(0..64).map(|index| json!({"id":format!("work-{index}"),"request":request,"status":"running","generation":1})).collect::<Vec<_>>(),"truncated":false});
        let projected = bounded_data(history).expect("large history is a successful bounded read");
        assert!(serde_json::to_vec(&projected).unwrap().len() <= DATA_BYTES);
        assert_eq!(projected["truncated"], true);
        let items = projected["work"].as_array().unwrap();
        assert!(!items.is_empty() && items.len() < 64);
        assert_eq!(items[0]["request"], request);
        let text = "🦔".repeat(6000);
        let outputs = bounded_data(json!({"outputs":(0..4).map(|index| json!({"id":format!("output-{index}"),"text":text})).collect::<Vec<_>>()})).unwrap();
        assert_eq!(outputs["truncated"], true);
        assert_eq!(outputs["outputs"][0]["text"], text);
        assert!(serde_json::to_vec(&outputs).unwrap().len() <= DATA_BYTES);
    }
}
