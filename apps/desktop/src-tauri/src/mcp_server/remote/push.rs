//! Payload-free Web Push: only a generic wake signal leaves the native host.
//! Signing keys, endpoint capabilities and bearer tokens never enter transcripts.
use super::*;
use crate::collaboration::models::{Work, WorkStatus};
use crate::store::repos::collaboration::{self as work_repo, Kind};
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

type Seen = HashMap<String, (String, bool)>;
struct Subscription {
    endpoint: Zeroizing<String>,
    token: Zeroizing<String>,
    seen: Seen,
    delivery_failed: bool,
}
#[derive(Default)]
struct Inner {
    key: Option<Arc<EcdsaKeyPair>>,
    subscriptions: HashMap<String, Subscription>,
    last_poll: Option<Instant>,
}
#[derive(Default)]
pub(crate) struct PushState {
    inner: Mutex<Inner>,
    sending: AtomicBool,
}

fn key(inner: &mut Inner) -> Result<Arc<EcdsaKeyPair>> {
    if let Some(key) = &inner.key {
        return Ok(key.clone());
    }
    let random = SystemRandom::new();
    let bytes = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random)
        .map_err(|_| invalid("Notifications could not create a signing key."))?;
    let pair = Arc::new(
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, bytes.as_ref(), &random)
            .map_err(|_| invalid("Notifications could not open their signing key."))?,
    );
    inner.key = Some(pair.clone());
    Ok(pair)
}

fn endpoint(raw: &str) -> Result<url::Url> {
    let endpoint = url::Url::parse(raw).map_err(|_| invalid("Unsupported push service."))?;
    let host = endpoint.host_str().unwrap_or_default();
    // Browser vendors own these push services. A subscription is not an
    // arbitrary native-network capability, including after DNS resolution.
    let supported = host == "fcm.googleapis.com"
        || host == "updates.push.services.mozilla.com"
        || host.ends_with(".push.apple.com")
        || host == "web.push.apple.com"
        || host.ends_with(".notify.windows.com");
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !supported
        || endpoint.scheme() != "https"
        || endpoint.port_or_known_default() != Some(443)
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() == "/"
    {
        return Err(invalid("This browser's push service is unsupported."));
    }
    Ok(endpoint)
}

fn snapshot(engine: &Engine, token: &str) -> Result<Seen> {
    engine.store.with_conn(|conn| {
        let scope = crate::authorized_scope::resolve(
            conn,
            None,
            None,
            crate::authorized_scope::ScopeAccess::Read,
        )?;
        let saved = repository::read(conn, engine.store, &scope)?;
        let grant = repository::authenticate(&saved, token, &engine.resource())?;
        let profiles = repository::profiles(conn, engine.store, &scope)?;
        let work = work_repo::list::<Work>(conn, engine.store, &scope.private, Kind::Work)?;
        Ok(work
            .iter()
            .filter(|work| {
                tools::shared(work, &grant) && profiles.iter().any(|p| p.id == work.agent_id)
            })
            .map(|work| {
                (
                    work.id.clone(),
                    (
                        format!("{:?}:{}", work.status, work.generation),
                        matches!(
                            work.status,
                            WorkStatus::Completed
                                | WorkStatus::Failed
                                | WorkStatus::Blocked
                                | WorkStatus::AwaitingApproval
                                | WorkStatus::AwaitingUser
                        ),
                    ),
                )
            })
            .collect())
    })
}

fn changed(previous: &Seen, current: &Seen) -> bool {
    current.iter().any(|(id, (fingerprint, attention))| {
        *attention && previous.get(id).is_none_or(|(old, _)| old != fingerprint)
    })
}

pub(super) async fn status(State(engine): State<Arc<Engine>>, headers: HeaderMap) -> Response {
    match status_value(&engine, &headers) {
        Ok(value) => Json(value).into_response(),
        Err(_) => failure(
            StatusCode::BAD_REQUEST,
            "Connect through HTTPS before enabling phone notifications.",
        ),
    }
}
pub(super) fn status_value(engine: &Engine, headers: &HeaderMap) -> Result<serde_json::Value> {
    session::authenticated(&engine, &headers)?;
    if !engine.origin.starts_with("https://") {
        return Err(invalid(
            "Phone notifications require your public HTTPS address.",
        ));
    }
    let browser = hash(&cookie(&engine, &headers)?);
    let mut state = engine
        .push
        .inner
        .lock()
        .map_err(|_| invalid("Notifications unavailable."))?;
    let public_key = URL_SAFE_NO_PAD.encode(key(&mut state)?.public_key().as_ref());
    let subscription = state.subscriptions.get(&browser);
    Ok(
        json!({"publicKey":public_key,"enabled":subscription.is_some(),"deliveryFailed":subscription.is_some_and(|s| s.delivery_failed)}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscribe {
    endpoint: Option<String>,
}
pub(super) async fn subscribe(
    State(engine): State<Arc<Engine>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match subscribe_value(&engine, &headers, &body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}
pub(super) fn subscribe_value(engine: &Engine, headers: &HeaderMap, body: &[u8]) -> Result<()> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return Err(invalid("Use a JSON notification request."));
    }
    let request: Subscribe =
        serde_json::from_slice(&body).map_err(|_| invalid("Invalid notification request."))?;
    let (token, _) = session::authenticated(&engine, &headers)?;
    let browser = hash(&cookie(&engine, &headers)?);
    if !engine.origin.starts_with("https://") {
        return Err(invalid("Phone notifications require HTTPS."));
    }
    let Some(raw) = request.endpoint else {
        remove(&engine, &browser);
        return Ok(());
    };
    endpoint(&raw)?;
    let seen = snapshot(&engine, &token)?;
    let mut state = engine
        .push
        .inner
        .lock()
        .map_err(|_| invalid("Notifications unavailable."))?;
    if state.subscriptions.len() >= 32 && !state.subscriptions.contains_key(&browser) {
        return Err(invalid("Too many browsers have notifications enabled."));
    }
    key(&mut state)?;
    state
        .subscriptions
        .retain(|_, sub| sub.endpoint.as_str() != raw);
    state.subscriptions.insert(
        browser,
        Subscription {
            endpoint: Zeroizing::new(raw),
            token,
            seen,
            delivery_failed: false,
        },
    );
    Ok(())
}

pub(super) fn remove(engine: &Engine, browser: &str) {
    if let Ok(mut state) = engine.push.inner.lock() {
        state.subscriptions.remove(browser);
    }
}

fn authorization(
    key: &EcdsaKeyPair,
    endpoint: &url::Url,
    origin: &str,
    now: i64,
) -> Result<String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        json!({"aud":endpoint.origin().ascii_serialization(),"exp":now+300,"sub":origin})
            .to_string(),
    );
    let content = format!("{header}.{claims}");
    let signature = key
        .sign(&SystemRandom::new(), content.as_bytes())
        .map_err(|_| invalid("Notifications could not be signed."))?;
    Ok(format!(
        "vapid t={content}.{}, k={}",
        URL_SAFE_NO_PAD.encode(signature.as_ref()),
        URL_SAFE_NO_PAD.encode(key.public_key().as_ref())
    ))
}

async fn deliver(
    engine: &Engine,
    browser: &str,
    token: &str,
    key: &EcdsaKeyPair,
    raw: &str,
    origin: &str,
) -> std::result::Result<u16, ()> {
    let target = endpoint(raw).map_err(|_| ())?;
    let host = target.host_str().ok_or(())?;
    let addresses =
        tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?
            .take(16)
            .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| crate::tools::is_forbidden_ip(a.ip()))
    {
        return Err(());
    }
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| ())?;
    let mut authorization = reqwest::header::HeaderValue::from_str(
        &authorization(key, &target, origin, chrono::Utc::now().timestamp()).map_err(|_| ())?,
    )
    .map_err(|_| ())?;
    authorization.set_sensitive(true);
    // DNS may have taken seconds. Recheck native grant and this subscription
    // immediately before dispatch; disconnected browsers cannot enqueue.
    if session::browser_token(engine, browser)
        .map_err(|_| ())?
        .as_str()
        != token
    {
        return Err(());
    }
    engine
        .store
        .with_conn(|conn| {
            let scope = crate::authorized_scope::resolve(
                conn,
                None,
                None,
                crate::authorized_scope::ScopeAccess::Read,
            )?;
            repository::authenticate(
                &repository::read(conn, engine.store, &scope)?,
                token,
                &engine.resource(),
            )
            .map(|_| ())
        })
        .map_err(|_| ())?;
    if !engine
        .push
        .inner
        .lock()
        .map_err(|_| ())?
        .subscriptions
        .get(browser)
        .is_some_and(|sub| sub.endpoint.as_str() == raw && sub.token.as_str() == token)
    {
        return Err(());
    }
    // RFC8030 allows an empty push. No encryption keys or message payload are
    // needed: the worker always shows the same generic notification.
    let response = client
        .post(target)
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header("TTL", "30")
        .header("Urgency", "normal")
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .body(Vec::<u8>::new())
        .send()
        .await
        .map_err(|_| ())?;
    Ok(response.status().as_u16())
}

pub(in crate::mcp_server) fn schedule(engine: Arc<Engine>) {
    if !engine.config.remote_access || engine.push.sending.swap(true, Ordering::AcqRel) {
        return;
    }
    let batch = (|| {
        let mut state = engine.push.inner.lock().ok()?;
        if state.subscriptions.is_empty()
            || state
                .last_poll
                .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
        {
            return None;
        }
        state.last_poll = Some(Instant::now());
        let key = state.key.clone()?;
        let entries = state
            .subscriptions
            .iter()
            .map(|(id, sub)| (id.clone(), sub.endpoint.clone(), sub.token.clone()))
            .collect::<Vec<_>>();
        Some((key, entries))
    })();
    let Some((key, entries)) = batch else {
        engine.push.sending.store(false, Ordering::Release);
        return;
    };
    tauri::async_runtime::spawn(async move {
        for (id, endpoint, token) in entries {
            if !session::browser_token(&engine, &id)
                .is_ok_and(|current| current.as_str() == token.as_str())
            {
                remove(&engine, &id);
                continue;
            }
            let Ok(current) = snapshot(&engine, &token) else {
                remove(&engine, &id);
                continue;
            };
            let send = engine.push.inner.lock().ok().is_some_and(|mut state| {
                let Some(sub) = state
                    .subscriptions
                    .get_mut(&id)
                    .filter(|sub| sub.endpoint.as_str() == endpoint.as_str())
                else {
                    return false;
                };
                let send = changed(&sub.seen, &current);
                sub.seen = current;
                send
            });
            if !send {
                continue;
            }
            // No replay on ambiguous network failure; a later status change
            // may trigger another generic signal. Expired/revoked grants drop.
            let result = deliver(&engine, &id, &token, &key, &endpoint, &engine.origin).await;
            if matches!(result, Ok(404 | 410)) {
                if let Ok(mut state) = engine.push.inner.lock() {
                    if state
                        .subscriptions
                        .get(&id)
                        .is_some_and(|sub| sub.endpoint.as_str() == endpoint.as_str())
                    {
                        state.subscriptions.remove(&id);
                    }
                }
            } else if let Ok(mut state) = engine.push.inner.lock() {
                if let Some(sub) = state
                    .subscriptions
                    .get_mut(&id)
                    .filter(|sub| sub.endpoint.as_str() == endpoint.as_str())
                {
                    sub.delivery_failed = !matches!(result, Ok(200..=299));
                }
            }
        }
        engine.push.sending.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_are_push_service_capabilities_not_arbitrary_network_destinations() {
        for valid in [
            "https://fcm.googleapis.com/fcm/send/opaque",
            "https://updates.push.services.mozilla.com/wpush/v2/opaque",
            "https://web.push.apple.com/Qopaque",
        ] {
            assert!(endpoint(valid).is_ok());
        }
        for denied in [
            "http://fcm.googleapis.com/fcm/send/opaque",
            "https://127.0.0.1/push",
            "https://fcm.googleapis.com.evil.test/send/x",
            "https://user@web.push.apple.com/Qopaque",
            "https://web.push.apple.com:444/Qopaque",
            "https://web.push.apple.com/Qopaque#x",
        ] {
            assert!(endpoint(denied).is_err());
        }
    }
    #[test]
    fn vapid_signature_and_audience_bind_the_push_service_without_user_content() {
        let pair = key(&mut Inner::default()).unwrap();
        let target = endpoint("https://fcm.googleapis.com/fcm/send/opaque").unwrap();
        let value = authorization(&pair, &target, "https://mivlet.example", 1000).unwrap();
        let jwt = value
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let parts = jwt.split('.').collect::<Vec<_>>();
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            pair.public_key().as_ref(),
        )
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            claims,
            json!({"aud":"https://fcm.googleapis.com","exp":1300,"sub":"https://mivlet.example"})
        );
    }
    #[test]
    fn notifications_require_new_attention_or_completion_not_each_poll() {
        let initial = HashMap::from([("task".into(), ("Running:1".into(), false))]);
        let finished = HashMap::from([("task".into(), ("Completed:1".into(), true))]);
        assert!(!changed(&initial, &initial));
        assert!(changed(&initial, &finished));
        assert!(!changed(&finished, &finished));
        assert!(!changed(&finished, &HashMap::new()));
    }
}
