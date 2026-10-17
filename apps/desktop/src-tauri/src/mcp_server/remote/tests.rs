use super::*;
use crate::mcp_server::{
    models::{Access, Decision},
    tests::engine,
};

fn headers(id: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        format!("__Host-mivlet-remote={id}").parse().unwrap(),
    );
    headers
}
fn approve(engine: &Engine, ticket: &str, access: Access) -> String {
    let pending = engine.oauth.lock().unwrap().pending();
    oauth::decide(
        engine,
        Decision {
            request_id: pending[0].id.clone(),
            approve: true,
            workspace_id: "default".into(),
            agent_ids: vec!["agent-one".into()],
            work_ids: vec![],
            access,
            lifetime_hours: 1,
        },
    )
    .unwrap();
    let oauth::Wait::Redirect(url) = oauth::wait(engine, ticket).unwrap() else {
        panic!("Expected authorization redirect")
    };
    url::Url::parse(&url).unwrap().query().unwrap().to_owned()
}

#[test]
fn browser_pairing_keeps_tokens_native_rotates_cookie_and_checks_revocation() {
    let engine = engine("https://mivlet.example");
    let (pending, ticket) = session::begin(&engine, &HeaderMap::new()).unwrap();
    assert!(session::authenticated(&engine, &headers(&pending)).is_err());
    let query = approve(&engine, &ticket, Access::RequestTasks);
    assert!(session::finish(&engine, &headers(&random().unwrap()), &query).is_err());
    let (connected, seconds) = session::finish(&engine, &headers(&pending), &query).unwrap();
    assert_ne!(connected, pending);
    assert!(seconds <= 3600);
    assert!(session::finish(&engine, &headers(&pending), &query).is_err());
    let (token, grant) = session::authenticated(&engine, &headers(&connected)).unwrap();
    assert_ne!(&*token, &connected);
    let visible = tools::invoke(
        &engine,
        &token,
        "mivlet_agents",
        json!({"workspaceId":"default"}),
    )
    .unwrap();
    assert_eq!(visible["agents"].as_array().unwrap().len(), 1);
    assert!(!visible.to_string().contains("PRIVATE"));
    engine
        .transaction(|_, _, saved| {
            saved
                .grants
                .iter_mut()
                .find(|g| g.id == grant.id)
                .unwrap()
                .revoked = true;
            Ok(())
        })
        .unwrap();
    assert!(session::authenticated(&engine, &headers(&connected)).is_err());
}

#[test]
fn callback_rejects_state_issuer_duplicates_and_expired_browser() {
    for change in ["state", "iss", "duplicate", "expired"] {
        let engine = engine("https://mivlet.example");
        let (pending, ticket) = session::begin(&engine, &HeaderMap::new()).unwrap();
        let query = approve(&engine, &ticket, Access::ReadOnly);
        let query = match change {
            "duplicate" => format!("{query}&state=again"),
            "expired" => {
                engine.remote.lock().unwrap().remove(&hash(&pending));
                query
            }
            name => url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(
                    url::form_urlencoded::parse(query.as_bytes()).map(|(key, value)| {
                        let value = if key == name { "wrong".into() } else { value };
                        (key, value)
                    }),
                )
                .finish(),
        };
        assert!(session::finish(&engine, &headers(&pending), &query).is_err());
    }
    let engine = engine("https://mivlet.example");
    let mut duplicates = headers(&random().unwrap());
    duplicates.append(
        header::COOKIE,
        format!("__Host-mivlet-remote={}", random().unwrap())
            .parse()
            .unwrap(),
    );
    assert!(cookie(&engine, &duplicates).is_err());
}

#[tokio::test]
async fn remote_http_is_opt_in_and_rejects_cross_origin_writes_and_mcp_cookie_auth() {
    use std::future::IntoFuture;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    let mut e = engine(&origin);
    Arc::get_mut(&mut e).unwrap().config.remote_access = true;
    let server = tokio::spawn(
        axum::serve(listener, crate::mcp_server::http::router(e.clone())).into_future(),
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let page = client.get(format!("{origin}/remote")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(page.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("script-src 'self'"));
    assert_eq!(
        client
            .post(format!("{origin}/remote/connect"))
            .header("x-mivlet-remote", "1")
            .header(header::ORIGIN, "https://other.example")
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(format!("{origin}/remote/connect"))
            .header(header::ORIGIN, &origin)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let started = client
        .post(format!("{origin}/remote/connect"))
        .header("x-mivlet-remote", "1")
        .header(header::ORIGIN, &origin)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(started.status(), 200);
    let cookie = started.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    let body = started.text().await.unwrap();
    assert!(!body.contains("access_token") && !body.contains("code_verifier"));
    let denied = client
        .post(format!("{origin}/mcp"))
        .header(header::COOKIE, cookie.split(';').next().unwrap())
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    server.abort();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(listener, crate::mcp_server::http::router(engine(&origin))).into_future(),
    );
    assert_eq!(
        client
            .get(format!("{origin}/remote"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    server.abort();
}
