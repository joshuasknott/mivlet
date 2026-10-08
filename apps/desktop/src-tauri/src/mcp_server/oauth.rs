use super::{invalid, models::*, random, Engine, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use url::Url;

#[derive(Clone)]
struct Client {
    id: String,
    name: String,
    redirects: Vec<String>,
    expires: i64,
}
struct Pending {
    view: ConsentRequest,
    client_id: String,
    state: String,
    challenge: String,
    decision: Option<Option<String>>,
}
struct Code {
    client_id: String,
    redirect: String,
    challenge: String,
    grant: String,
    expires: i64,
}
#[derive(Default)]
pub(super) struct State {
    clients: Vec<Client>,
    pending: HashMap<String, Pending>,
    codes: HashMap<String, Code>,
}
impl State {
    fn prune(&mut self) {
        let now = chrono::Utc::now().timestamp();
        self.clients.retain(|c| c.expires > now);
        self.pending.retain(|_, p| p.view.expires_at > now);
        self.codes.retain(|_, c| c.expires > now);
    }
    pub fn pending(&mut self) -> Vec<ConsentRequest> {
        self.prune();
        self.pending
            .values()
            .filter(|p| p.decision.is_none())
            .map(|p| p.view.clone())
            .collect()
    }
}

#[derive(Deserialize)]
pub(super) struct Registration {
    client_name: String,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}

pub(super) fn redirect(value: &str) -> Result<Url> {
    if value.len() > 2048 {
        return Err(invalid("Invalid redirect URI."));
    }
    let url = Url::parse(value).map_err(|_| invalid("Invalid redirect URI."))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url
            .query_pairs()
            .any(|(key, _)| ["code", "state", "error", "iss"].contains(&key.as_ref()))
    {
        return Err(invalid(
            "Use an exact HTTPS or loopback HTTP callback without credentials or a fragment.",
        ));
    }
    Ok(url)
}

pub(super) fn register(engine: &Engine, registration: Registration) -> Result<serde_json::Value> {
    let name = registration.client_name.trim();
    if name.is_empty()
        || name.chars().count() > 80
        || name.chars().any(char::is_control)
        || registration.redirect_uris.is_empty()
        || registration.redirect_uris.len() > 4
        || registration
            .token_endpoint_auth_method
            .as_deref()
            .is_some_and(|m| m != "none")
        || registration
            .grant_types
            .as_ref()
            .is_some_and(|v| v != &["authorization_code"])
        || registration
            .response_types
            .as_ref()
            .is_some_and(|v| v != &["code"])
    {
        return Err(invalid(
            "Use a named public client with authorization_code, code, and PKCE S256.",
        ));
    }
    for uri in &registration.redirect_uris {
        redirect(uri)?;
    }
    let mut state = engine
        .oauth
        .lock()
        .map_err(|_| invalid("Sign-in unavailable."))?;
    state.prune();
    if state.clients.len() >= 64 {
        return Err(invalid("Too many client registrations. Try again later."));
    }
    let id = random()?;
    state.clients.push(Client {
        id: id.clone(),
        name: name.into(),
        redirects: registration.redirect_uris.clone(),
        expires: chrono::Utc::now().timestamp() + 3600,
    });
    Ok(
        serde_json::json!({"client_id":id,"client_name":name,"redirect_uris":registration.redirect_uris,
        "token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}),
    )
}

fn field<'a>(params: &'a HashMap<String, String>, name: &str) -> Result<&'a str> {
    params
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| invalid("Missing OAuth parameter."))
}

pub(super) fn authorize(engine: &Engine, params: HashMap<String, String>) -> Result<String> {
    let client_id = field(&params, "client_id")?;
    let redirect_uri = field(&params, "redirect_uri")?;
    let challenge = field(&params, "code_challenge")?;
    let supplied_state = field(&params, "state")?;
    if field(&params, "response_type")? != "code"
        || field(&params, "code_challenge_method")? != "S256"
        || field(&params, "resource")? != engine.resource()
        || challenge.len() != 43
        || URL_SAFE_NO_PAD
            .decode(challenge)
            .map_or(true, |b| b.len() != 32)
        || supplied_state.is_empty()
        || supplied_state.len() > 512
    {
        return Err(invalid(
            "Invalid OAuth resource, state or PKCE S256 challenge.",
        ));
    }
    let scopes = params
        .get("scope")
        .map(String::as_str)
        .unwrap_or("mivlet:read");
    if scopes
        .split_whitespace()
        .any(|s| s != "mivlet:read" && s != "mivlet:tasks")
    {
        return Err(invalid(
            "Unsupported scope. Use mivlet:read and optionally mivlet:tasks.",
        ));
    }
    let access = if scopes.split_whitespace().any(|s| s == "mivlet:tasks") {
        Access::RequestTasks
    } else {
        Access::ReadOnly
    };
    let mut state = engine
        .oauth
        .lock()
        .map_err(|_| invalid("Sign-in unavailable."))?;
    state.prune();
    let client = state
        .clients
        .iter()
        .find(|c| c.id == client_id)
        .cloned()
        .or_else(|| {
            engine
                .transaction(|_, _, saved| {
                    Ok(saved
                        .grants
                        .iter()
                        .find(|g| g.client_id == client_id)
                        .map(|g| Client {
                            id: g.client_id.clone(),
                            name: g.client_name.clone(),
                            redirects: vec![g.redirect_uri.clone()],
                            expires: 0,
                        }))
                })
                .ok()
                .flatten()
        })
        .ok_or_else(|| invalid("Register this client again before signing in."))?;
    // Exact matching also for loopback ports: clients register their actual callback.
    if !client.redirects.iter().any(|r| r == redirect_uri) {
        return Err(invalid("Unregistered callback. No redirect was performed."));
    }
    redirect(redirect_uri)?;
    if state.pending.len() >= 16 || state.codes.len() >= 32 {
        return Err(invalid("Too many sign-in requests. Try again later."));
    }
    let ticket = random()?;
    state.pending.insert(
        ticket.clone(),
        Pending {
            view: ConsentRequest {
                id: random()?[..12].to_string(),
                client_name: client.name,
                redirect_uri: redirect_uri.into(),
                requested_access: access,
                expires_at: chrono::Utc::now().timestamp() + 300,
            },
            client_id: client.id,
            state: supplied_state.into(),
            challenge: challenge.into(),
            decision: None,
        },
    );
    engine.changed();
    Ok(ticket)
}

pub(super) fn decide(engine: &Engine, decision: Decision) -> Result<()> {
    let mut state = engine
        .oauth
        .lock()
        .map_err(|_| invalid("Sign-in unavailable."))?;
    state.prune();
    let pending = state
        .pending
        .values_mut()
        .find(|p| p.view.id == decision.request_id && p.decision.is_none())
        .ok_or_else(|| invalid("This sign-in request expired or was already decided."))?;
    let grant_id = engine.transaction(|conn, scope, saved| {
        if scope.data.workspace_id() != decision.workspace_id || !saved.enabled {
            return Err(invalid("This account or workspace changed."));
        }
        if !decision.approve {
            saved.record(&pending.client_id, "consent", None, "denied");
            return Ok(None);
        }
        if decision.agent_ids.is_empty()
            || decision.agent_ids.len() > 16
            || decision.work_ids.len() > 32
            || decision.lifetime_hours == 0
            || decision.lifetime_hours > 168
            || decision.access == Access::RequestTasks
                && pending.view.requested_access != Access::RequestTasks
        {
            return Err(invalid(
                "Choose agents, a lifetime up to seven days, and only the access requested.",
            ));
        }
        let profiles = super::repository::profiles(conn, engine.store, scope)?;
        for id in &decision.agent_ids {
            if !profiles.iter().any(|p| &p.id == id) {
                return Err(invalid("A selected agent is unavailable."));
            }
        }
        for id in &decision.work_ids {
            let work = super::tools::work(conn, engine.store, scope, id)?;
            if !decision.agent_ids.contains(&work.agent_id) {
                return Err(invalid("Select the agent that owns each shared Work item."));
            }
        }
        let now = chrono::Utc::now().timestamp();
        saved.grants.retain(|g| !g.revoked && g.expires_at > now);
        saved
            .receipts
            .retain(|_, receipt| saved.grants.iter().any(|g| receipt["grantId"] == g.id));
        if saved.grants.len() >= 32 {
            return Err(invalid("Revoke an existing client before adding another."));
        }
        let id = random()?;
        saved.grants.push(Grant {
            id: id.clone(),
            client_id: pending.client_id.clone(),
            client_name: pending.view.client_name.clone(),
            redirect_uri: pending.view.redirect_uri.clone(),
            resource: engine.resource(),
            workspace_id: decision.workspace_id.clone(),
            agent_ids: decision.agent_ids.clone(),
            work_ids: decision.work_ids.clone(),
            access: decision.access.clone(),
            // External tasks always retain exact human approval for consequential tools.
            permission_mode: "trusted-scope".into(),
            created_at: now,
            expires_at: now + i64::from(decision.lifetime_hours) * 3600,
            revoked: false,
        });
        saved.record(&pending.client_id, "consent", Some(id.clone()), "approved");
        Ok(Some(id))
    })?;
    pending.decision = Some(grant_id);
    engine.changed();
    Ok(())
}

pub(super) enum Wait {
    Pending(ConsentRequest),
    Redirect(String),
}
pub(super) fn wait(engine: &Engine, ticket: &str) -> Result<Wait> {
    let mut state = engine
        .oauth
        .lock()
        .map_err(|_| invalid("Sign-in unavailable."))?;
    state.prune();
    let pending = state
        .pending
        .get(ticket)
        .ok_or_else(|| invalid("This sign-in request expired. Start sign-in again."))?;
    if pending.decision.is_none() {
        return Ok(Wait::Pending(pending.view.clone()));
    }
    let pending = state
        .pending
        .remove(ticket)
        .ok_or_else(|| invalid("Sign-in unavailable."))?;
    let mut url = redirect(&pending.view.redirect_uri)?;
    if let Some(Some(grant)) = pending.decision {
        let code = random()?;
        state.codes.insert(
            super::hash(&code),
            Code {
                client_id: pending.client_id,
                redirect: pending.view.redirect_uri,
                challenge: pending.challenge,
                grant,
                expires: chrono::Utc::now().timestamp() + 60,
            },
        );
        url.query_pairs_mut().append_pair("code", &code);
    } else {
        url.query_pairs_mut().append_pair("error", "access_denied");
    }
    url.query_pairs_mut()
        .append_pair("state", &pending.state)
        .append_pair("iss", &engine.origin);
    Ok(Wait::Redirect(url.into()))
}

pub(super) fn token(engine: &Engine, params: HashMap<String, String>) -> Result<serde_json::Value> {
    let verifier = field(&params, "code_verifier")?;
    if field(&params, "grant_type")? != "authorization_code"
        || field(&params, "resource")? != engine.resource()
        || verifier.len() < 43
        || verifier.len() > 128
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return Err(invalid("Invalid authorization code exchange."));
    }
    let mut state = engine
        .oauth
        .lock()
        .map_err(|_| invalid("Sign-in unavailable."))?;
    state.prune();
    let code_key = super::hash(field(&params, "code")?);
    let code = state
        .codes
        .get(&code_key)
        .ok_or_else(|| invalid("Authorization code expired or already consumed."))?;
    if code.client_id != field(&params, "client_id")?
        || code.redirect != field(&params, "redirect_uri")?
        || URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != code.challenge
    {
        return Err(invalid("Invalid authorization code exchange."));
    }
    let token = random()?;
    let response = engine.transaction(|_, _, saved| {
        let now = chrono::Utc::now().timestamp();
        let grant = saved.grants.iter().find(|g| g.id == code.grant && !g.revoked && g.expires_at > now && g.resource == engine.resource())
            .ok_or_else(|| invalid("Client grant expired or was revoked."))?;
        if !saved.enabled { return Err(invalid("MCP server stopped.")); }
        let expires = grant.expires_at.min(now + 8 * 3600);
        let scope = if grant.access == Access::RequestTasks { "mivlet:read mivlet:tasks" } else { "mivlet:read" };
        saved.tokens.retain(|t| t.expires_at > now && t.grant_id != code.grant);
        saved.tokens.push(Token { hash: super::hash(&token), grant_id: code.grant.clone(), expires_at: expires });
        saved.record(&code.client_id,"sign-in",None,"authenticated");
        Ok(serde_json::json!({"access_token":token,"token_type":"Bearer","expires_in":expires - now,"scope":scope}))
    })?;
    state.codes.remove(&code_key);
    Ok(response)
}
