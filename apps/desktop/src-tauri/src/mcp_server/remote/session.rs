use super::*;

struct Pending {
    client_id: String,
    verifier: Zeroizing<String>,
    state: String,
    expires: i64,
}
struct Connected {
    token: Zeroizing<String>,
    expires: i64,
}
#[derive(Default)]
pub(crate) struct Sessions {
    pending: HashMap<String, Pending>,
    connected: HashMap<String, Connected>,
}
impl Sessions {
    fn prune(&mut self) {
        let now = chrono::Utc::now().timestamp();
        self.pending.retain(|_, entry| entry.expires > now);
        self.connected.retain(|_, entry| entry.expires > now);
    }
    pub(super) fn remove(&mut self, key: &str) {
        self.pending.remove(key);
        self.connected.remove(key);
    }
}

pub(super) fn begin(engine: &Engine, headers: &HeaderMap) -> Result<(String, String)> {
    let mut sessions = engine
        .remote
        .lock()
        .map_err(|_| invalid("Connection unavailable."))?;
    sessions.prune();
    if sessions.pending.len() >= 16 || sessions.connected.len() >= 32 {
        return Err(invalid(
            "Too many connected browsers. Disconnect an existing device first.",
        ));
    }
    let registration = serde_json::from_value(json!({"client_name":"Mivlet phone and web","redirect_uris":[format!("{}/remote/callback",engine.origin)],"token_endpoint_auth_method":"none"}))
        .map_err(|_| invalid("Connection unavailable."))?;
    let client = oauth::register(engine, registration)?;
    let client_id = client["client_id"]
        .as_str()
        .ok_or_else(|| invalid("Connection unavailable."))?
        .to_owned();
    let verifier = Zeroizing::new(random()?);
    let state = random()?;
    let ticket = oauth::authorize(
        engine,
        HashMap::from([
            ("client_id".into(), client_id.clone()),
            (
                "redirect_uri".into(),
                format!("{}/remote/callback", engine.origin),
            ),
            (
                "code_challenge".into(),
                URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            ),
            ("code_challenge_method".into(), "S256".into()),
            ("state".into(), state.clone()),
            ("response_type".into(), "code".into()),
            ("resource".into(), engine.resource()),
            ("scope".into(), "mivlet:read mivlet:tasks".into()),
        ]),
    )?;
    let id = random()?;
    if let Ok(old) = cookie(engine, headers) {
        sessions.remove(&hash(&old));
    }
    sessions.pending.insert(
        hash(&id),
        Pending {
            client_id,
            verifier,
            state,
            expires: chrono::Utc::now().timestamp() + 300,
        },
    );
    Ok((id, ticket))
}

pub(super) fn finish(engine: &Engine, headers: &HeaderMap, query: &str) -> Result<(String, i64)> {
    let id = cookie(engine, headers)?;
    let mut params = HashMap::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(invalid("Duplicate sign-in parameters."));
        }
    }
    let mut sessions = engine
        .remote
        .lock()
        .map_err(|_| invalid("Connection unavailable."))?;
    sessions.prune();
    let pending = sessions
        .pending
        .remove(&hash(&id))
        .ok_or_else(|| invalid("Connection expired."))?;
    if params.get("state") != Some(&pending.state)
        || params.get("iss") != Some(&engine.origin)
        || params.contains_key("error")
    {
        return Err(invalid("Connection did not match this browser."));
    }
    let response = oauth::token(
        engine,
        HashMap::from([
            ("grant_type".into(), "authorization_code".into()),
            ("resource".into(), engine.resource()),
            ("client_id".into(), pending.client_id),
            (
                "redirect_uri".into(),
                format!("{}/remote/callback", engine.origin),
            ),
            ("code_verifier".into(), pending.verifier.to_string()),
            (
                "code".into(),
                params
                    .remove("code")
                    .ok_or_else(|| invalid("Connection denied."))?,
            ),
        ]),
    )?;
    let token = Zeroizing::new(
        response["access_token"]
            .as_str()
            .ok_or_else(|| invalid("Connection unavailable."))?
            .to_owned(),
    );
    let seconds = response["expires_in"]
        .as_i64()
        .filter(|v| *v > 0 && *v <= 8 * 3600)
        .ok_or_else(|| invalid("Invalid connection lifetime."))?;
    let fresh = random()?;
    sessions.connected.insert(
        hash(&fresh),
        Connected {
            token,
            expires: chrono::Utc::now().timestamp() + seconds,
        },
    );
    Ok((fresh, seconds))
}

pub(super) fn authenticated(
    engine: &Engine,
    headers: &HeaderMap,
) -> Result<(Zeroizing<String>, super::super::models::Grant)> {
    let id = cookie(engine, headers)?;
    let token = {
        let mut sessions = engine
            .remote
            .lock()
            .map_err(|_| invalid("Connection unavailable."))?;
        sessions.prune();
        sessions
            .connected
            .get(&hash(&id))
            .map(|entry| entry.token.clone())
            .ok_or_else(|| invalid("Connect this browser again."))?
    };
    let grant = engine
        .transaction(|_, _, saved| repository::authenticate(saved, &token, &engine.resource()))?;
    Ok((token, grant))
}
