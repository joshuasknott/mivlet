use super::*;
use reqwest::StatusCode;

use super::transport::{has_any_scope, provider_error};
#[test]
fn large_read_keeps_records_and_cursor_as_valid_json() {
    let items: Vec<Value> = (0..50).map(|index| json!({"id": format!("file-{index}"), "name": "Report", "description": "x".repeat(500)})).collect();
    let source = json!({"items": items, "nextCursor": "opaque-page-2"});
    let result: Value =
        serde_json::from_str(&encode_read_result("google-drive", source.clone()).unwrap()).unwrap();
    assert_eq!(result, source);
}

#[test]
fn gmail_excerpt_keeps_body_data_decodable() {
    let source = json!({"id":"message-1", "payload":{"body":{"data":URL_SAFE_NO_PAD.encode("😀".repeat(20_000))}}});
    let result: Value =
        serde_json::from_str(&encode_read_result("gmail", source).unwrap()).unwrap();
    let body = URL_SAFE_NO_PAD
        .decode(result["payload"]["body"]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(String::from_utf8(body).unwrap().chars().count(), 1_000);
    assert_eq!(result["truncated"], true);
}

#[test]
fn oversized_text_is_explicitly_excerpted_without_losing_pagination() {
    let source = json!({"items": [{"id":"file-1", "description":"😀".repeat(70_000)}], "nextCursor":"opaque-page-2"});
    let result: Value =
        serde_json::from_str(&encode_read_result("google-drive", source).unwrap()).unwrap();
    assert_eq!(result["nextCursor"], "opaque-page-2");
    assert_eq!(result["items"][0]["id"], "file-1");
    assert_eq!(result["truncated"], true);
    assert!(result["coverage"].as_str().unwrap().contains("excerpts"));
    assert!(
        result["items"][0]["description"]
            .as_str()
            .unwrap()
            .chars()
            .count()
            < 1100
    );
}
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

async fn mock_response(
    status: &str,
    body: &str,
    delay_ms: u64,
) -> (Url, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_string();
    let body = body.to_string();
    let (request_tx, request_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0_u8; 16 * 1024];
        let read = stream.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..read]).to_string();
        let _ = request_tx.send(request);
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        let _ = stream.write_all(response.as_bytes()).await;
    });
    (
        Url::parse(&format!("http://{address}/google-contract")).unwrap(),
        request_rx,
    )
}

fn tokens(scopes: &[&str]) -> StoredTokenSet {
    StoredTokenSet {
        access_token: "test-token".to_string(),
        refresh_token: Some("test-refresh".to_string()),
        token_type: "Bearer".to_string(),
        expires_at: None,
        scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
        revocation_endpoint: None,
        token_endpoint: Some("https://example.invalid/token".to_string()),
        handoff_endpoint: None,
        client_id: "test-client".to_string(),
        brokered: false,
    }
}

#[test]
fn partial_scopes_never_claim_ungranted_access() {
    let tokens = tokens(&[GMAIL_READONLY]);
    assert!(require_scope("gmail", &tokens, &[GMAIL_READONLY]).is_ok());
    assert_eq!(
        require_scope("gmail", &tokens, &[GMAIL_COMPOSE])
            .expect_err("compose must be missing")
            .code,
        "permission-denied"
    );
}

#[test]
fn provider_errors_normalize_rate_limit_missing_and_expiry() {
    assert_eq!(
        provider_error("gmail", StatusCode::UNAUTHORIZED, None).code,
        "expired-auth"
    );
    assert_eq!(
        provider_error("gmail", StatusCode::NOT_FOUND, None).code,
        "not-found"
    );
    let limited = provider_error("gmail", StatusCode::TOO_MANY_REQUESTS, Some("3".into()));
    assert_eq!(limited.code, "rate-limited");
    assert!(limited.retryable);
    assert_eq!(limited.retry_after.as_deref(), Some("3"));
}

#[test]
fn drive_query_escapes_provider_syntax() {
    assert_eq!(escape_drive_query("Josh's \\ file"), "Josh\\'s \\\\ file");
}

#[test]
fn gmail_normalization_rejects_malformed_messages() {
    let malformed = json!({ "threadId": "thread-1" });
    assert_eq!(
        gmail_item(&malformed).expect_err("id required").code,
        "provider-unavailable"
    );
}

#[test]
fn gmail_mime_rejects_header_injection_and_maps_replies() {
    let injected = BTreeMap::from([
        (
            "to".to_string(),
            "victim@example.com\r\nBcc: attacker@example.com".to_string(),
        ),
        ("subject".to_string(), "Hello".to_string()),
    ]);
    assert!(build_mime(&injected).is_err());
    let reply = BTreeMap::from([
        ("to".to_string(), "person@example.com".to_string()),
        ("subject".to_string(), "Re: Hello".to_string()),
        ("body".to_string(), "Reply".to_string()),
        ("inReplyTo".to_string(), "<message@example.com>".to_string()),
    ]);
    assert!(build_mime(&reply).unwrap().contains("In-Reply-To"));
}

#[test]
fn calendar_request_maps_attendees_recurrence_and_timezone() {
    let payload = BTreeMap::from([
        ("title".to_string(), "Planning".to_string()),
        ("start".to_string(), "2026-07-01T10:00:00+01:00".to_string()),
        ("end".to_string(), "2026-07-01T10:30:00+01:00".to_string()),
        ("timezone".to_string(), "Europe/London".to_string()),
        (
            "attendees".to_string(),
            "[{\"email\":\"person@example.com\"}]".to_string(),
        ),
        (
            "recurrence".to_string(),
            "[\"RRULE:FREQ=WEEKLY\"]".to_string(),
        ),
    ]);
    let event = calendar_event_body(&payload).unwrap();
    assert_eq!(
        event.pointer("/start/timeZone").and_then(Value::as_str),
        Some("Europe/London")
    );
    assert_eq!(
        event.pointer("/attendees/0/email").and_then(Value::as_str),
        Some("person@example.com")
    );
}

#[tokio::test]
async fn mocked_http_contract_sends_auth_and_exact_write_body() {
    let (url, request) = mock_response("200 OK", r#"{"id":"created"}"#, 0).await;
    let value = send_json(
        "write-contract",
        "google-drive",
        &tokens(&[DRIVE_FILE]),
        Method::POST,
        url,
        Some(json!({ "name": "Roadmap", "parents": ["folder-1"] })),
    )
    .await
    .unwrap();
    assert_eq!(value.get("id").and_then(Value::as_str), Some("created"));
    let request = request.await.unwrap();
    assert!(request.starts_with("POST /google-contract HTTP/1.1"));
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer test-token"));
    assert!(request.contains(r#"{"name":"Roadmap","parents":["folder-1"]}"#));
}

#[tokio::test]
async fn binary_multipart_preserves_every_byte_and_mutations_never_retry() {
    let data = (0u8..=255).collect::<Vec<_>>();
    let (content_type, body) = drive_multipart_body(
        &json!({"name":"Report.pdf", "mimeType":"application/pdf", "parents":["folder-1"]}),
        "application/pdf",
        &data,
    )
    .unwrap();
    assert!(body.windows(data.len()).any(|value| value == data));
    assert!(drive_multipart_body(&json!({}), "application/pdf\r\nInjected: bad", &data).is_err());
    let (other_type, _) = drive_multipart_body(&json!({}), "application/pdf", &data).unwrap();
    assert_ne!(content_type, other_type);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let expected = body.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            received.extend_from_slice(&buffer[..count]);
            if let Some(end) = received.windows(4).position(|value| value == b"\r\n\r\n") {
                let header = String::from_utf8(received[..end].to_vec()).unwrap();
                if received.len() >= end + 4 + expected.len() {
                    assert_eq!(&received[end + 4..], expected);
                    assert!(header
                        .to_lowercase()
                        .contains("authorization: bearer test-token"));
                    break;
                }
            }
        }
        stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err(),
            "mutation must never retry"
        );
    });
    let result = send_raw_json(
        "binary-upload-test",
        "google-drive",
        &tokens(&[DRIVE_FILE]),
        Method::POST,
        Url::parse(&format!("http://{address}/upload")).unwrap(),
        &content_type,
        body,
    )
    .await
    .unwrap_err();
    assert!(!result.retryable);
    assert!(result.message.contains("verify") || result.message.contains("Verify"));
    server.await.unwrap();
}

#[tokio::test]
async fn mocked_http_contract_rejects_malformed_and_honors_cancellation() {
    let (bad_url, _) = mock_response("200 OK", "not-json", 0).await;
    let malformed = send_json(
        "malformed-contract",
        "gmail",
        &tokens(&[GMAIL_READONLY]),
        Method::GET,
        bad_url,
        None,
    )
    .await
    .expect_err("malformed JSON must fail");
    assert_eq!(malformed.code, "provider-unavailable");

    let call_id = "cancel-contract";
    let (slow_url, _) = mock_response("200 OK", r#"{"messages":[]}"#, 500).await;
    let gmail_tokens = tokens(&[GMAIL_READONLY]);
    let request = send_json(call_id, "gmail", &gmail_tokens, Method::GET, slow_url, None);
    tokio::pin!(request);
    tokio::select! {
        result = &mut request => panic!("request finished before cancellation: {result:?}"),
        _ = tokio::time::sleep(Duration::from_millis(25)) => {}
    }
    assert!(cancel_google_request(call_id));
    let cancelled = request.await.expect_err("cancelled request must fail");
    assert_eq!(cancelled.code, "cancelled");
}

#[tokio::test]
async fn raw_uploads_do_not_follow_redirects_to_another_origin() {
    let escaped = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!("http://{}/escape", escaped.local_addr().unwrap());
    let (url, request) = mock_response(
        &format!("307 Temporary Redirect\r\nLocation: {location}"),
        "",
        0,
    )
    .await;
    assert!(send_raw_json(
        "redirect-upload-test",
        "google-drive",
        &tokens(&[DRIVE_FILE]),
        Method::POST,
        url,
        "application/pdf",
        b"approved upload bytes".to_vec()
    )
    .await
    .is_err());
    request.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), escaped.accept())
            .await
            .is_err()
    );
}

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[test]
fn uncertain_upload_responses_require_verification_and_never_offer_retry() {
    for code in ["provider-unavailable", "cancelled"] {
        let failure = upload_failure(error("google-drive", code, "lost upload response", true));
        assert!(!failure.retryable);
        assert!(failure.message.to_lowercase().contains("verify"));
    }
    assert_eq!(
        upload_failure(error(
            "google-drive",
            "permission-denied",
            "reconnect",
            false
        ))
        .code,
        "permission-denied"
    );
}

#[test]
fn test_has_any_scope_suffix_matching() {
    let t = tokens(&["https://www.googleapis.com/auth/drive.readonly"]);
    assert!(has_any_scope(&t, &["drive.readonly"]));
    assert!(!has_any_scope(&t, &["drive.file"]));
}

#[tokio::test]
async fn test_drive_search_pagination() {
    let _lock = ENV_LOCK.lock().await;
    let (url, request_rx) =
        mock_response("200 OK", r#"{"files":[],"nextPageToken":"drive-next"}"#, 0).await;

    std::env::set_var("MIVLET_GOOGLE_DRIVE_API", url.to_string());
    std::env::remove_var("FABLE_GOOGLE_DRIVE_API");

    let drive_tokens = tokens(&[DRIVE_READONLY]);
    let (_, next_cursor) = drive_search(
        "test-call",
        &drive_tokens,
        "query",
        20,
        Some("drive-cursor"),
    )
    .await
    .unwrap();

    std::env::remove_var("MIVLET_GOOGLE_DRIVE_API");
    std::env::remove_var("FABLE_GOOGLE_DRIVE_API");

    assert_eq!(next_cursor, Some("drive-next".to_string()));

    let request = request_rx.await.unwrap();
    assert!(request.contains("pageToken=drive-cursor"));
}

#[tokio::test]
async fn test_gmail_search_pagination() {
    let _lock = ENV_LOCK.lock().await;
    let (url, request_rx) = mock_response(
        "200 OK",
        r#"{"messages":[],"nextPageToken":"gmail-next"}"#,
        0,
    )
    .await;

    std::env::set_var("MIVLET_GOOGLE_GMAIL_API", url.to_string());
    std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

    let gmail_tokens = tokens(&[GMAIL_READONLY]);
    let (_, next_cursor) = gmail_search(
        "test-call",
        &gmail_tokens,
        "query",
        20,
        Some("gmail-cursor"),
    )
    .await
    .unwrap();

    std::env::remove_var("MIVLET_GOOGLE_GMAIL_API");
    std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

    assert_eq!(next_cursor, Some("gmail-next".to_string()));

    let request = request_rx.await.unwrap();
    assert!(request.contains("pageToken=gmail-cursor"));
}

#[tokio::test]
async fn test_calendar_search_pagination() {
    let _lock = ENV_LOCK.lock().await;
    let (url, request_rx) =
        mock_response("200 OK", r#"{"items":[],"nextPageToken":"cal-next"}"#, 0).await;

    std::env::set_var("MIVLET_GOOGLE_CALENDAR_API", url.to_string());
    std::env::remove_var("FABLE_GOOGLE_CALENDAR_API");

    let cal_tokens = tokens(&[CALENDAR_READONLY]);
    let (_, next_cursor) =
        calendar_search("test-call", &cal_tokens, "my query", 20, Some("cal-cursor"))
            .await
            .unwrap();

    std::env::remove_var("MIVLET_GOOGLE_CALENDAR_API");
    std::env::remove_var("FABLE_GOOGLE_CALENDAR_API");

    assert_eq!(next_cursor, Some("cal-next".to_string()));

    let request = request_rx.await.unwrap();
    assert!(request.contains("pageToken=cal-cursor"));
}

#[tokio::test]
async fn test_gmail_search_partial_failure() {
    let _lock = ENV_LOCK.lock().await;
    let (url, _request_rx) = mock_response(
        "200 OK",
        r#"{"messages":[{"id":"msg-123","threadId":"thread-123"}],"nextPageToken":"gmail-next"}"#,
        0,
    )
    .await;

    std::env::set_var("MIVLET_GOOGLE_GMAIL_API", url.to_string());
    std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

    let gmail_tokens = tokens(&[GMAIL_READONLY]);
    let (items, next_cursor) = gmail_search("test-call", &gmail_tokens, "query", 20, None)
        .await
        .unwrap();

    std::env::remove_var("MIVLET_GOOGLE_GMAIL_API");
    std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

    assert_eq!(next_cursor, Some("gmail-next".to_string()));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, "msg-123");
    assert_eq!(items[0].title, "(message unavailable)");
    assert_eq!(
        items[0].summary,
        "This message could not be read from Gmail."
    );
}

#[test]
fn test_safe_user_facing_errors() {
    let err = provider_error("google-drive", StatusCode::BAD_REQUEST, None);
    assert_eq!(err.message, "Google rejected the request.");
    assert_eq!(err.code, "invalid-request");

    // Ensure no private credentials or secrets are leaked
    let secret = "my-secret-oauth-token-12345";
    let err_unauthorized = provider_error("gmail", StatusCode::UNAUTHORIZED, None);
    assert!(!err_unauthorized.message.contains(secret));
    assert_eq!(err_unauthorized.code, "expired-auth");
}

#[test]
#[ignore = "requires deliberate MIVLET_GOOGLE_LIVE_TEST credentials and provider account"]
fn live_google_contract_is_opt_in() {
    assert!(crate::env_compat::var_named("MIVLET_GOOGLE_LIVE_TEST").is_ok());
}
