use super::*;

fn credential(id: &str) -> Credential {
    Credential {
        token: "fixture-private-token".into(),
        base_url: match id {
            "shopify" => "https://fixture.myshopify.com",
            "workday" => "https://tenant.myworkday.com/api/staffing/v7/tenant",
            "docusign" => "https://demo.docusign.net",
            _ => "",
        }
        .into(),
        account_id: match id {
            "instagram" => "123456",
            "docusign" => "account-123",
            _ => "",
        }
        .into(),
        developer_token: if id == "google-ads" {
            "fixture-developer-token"
        } else {
            ""
        }
        .into(),
        login_customer_id: String::new(),
    }
}

#[test]
fn every_plugin_has_a_native_read_probe_and_never_takes_an_arbitrary_destination() {
    for id in IDS {
        let mut credential = credential(id);
        validate(id, &mut credential, true).unwrap();
        let request = probe_request(id);
        let read = map_read(&credential, &request).unwrap();
        assert_eq!(read.url.scheme(), "https");
        assert!(!read.url.as_str().contains("fixture-private-token"));
        assert!(read.method == Method::GET || matches!(*id, "shopify" | "google-ads"));
        let unsupported = ConnectorCapabilityRequest {
            capability: "delete-everything".into(),
            ..request
        };
        assert!(map_read(&credential, &unsupported).is_err());
    }
}

#[test]
fn tenant_destinations_and_credential_shapes_fail_closed() {
    for (id, urls) in [
        (
            "shopify",
            vec![
                "https://evil.example",
                "https://fixture.myshopify.com.evil.example",
                "http://fixture.myshopify.com",
                "https://user:pass@fixture.myshopify.com",
                "https://fixture.myshopify.com:8443",
                "https://fixture.myshopify.com/admin",
                "https://fixture.myshopify.com?redirect=evil",
            ],
        ),
        (
            "workday",
            vec![
                "https://localhost/api/staffing/v7/tenant",
                "https://tenant.workday.com/api/staffing/v7/tenant/../workers",
                "https://tenant.myworkday.com/api/payroll/v1/tenant",
                "https://tenant.myworkday.com.evil.example/api/staffing/v7/tenant",
            ],
        ),
        (
            "docusign",
            vec![
                "https://evil.docusign.net",
                "https://demo.docusign.net.evil.example",
                "https://account.docusign.com/oauth/userinfo",
            ],
        ),
    ] {
        for url in urls {
            let mut c = credential(id);
            c.base_url = url.into();
            assert!(validate(id, &mut c, true).is_err(), "{url}");
        }
    }
    let mut c = credential("outlook");
    c.token = "secret\r\nInjected: yes".into();
    assert!(validate("outlook", &mut c, true).is_err());
    c = credential("outlook");
    c.base_url = "https://evil.example".into();
    assert!(validate("outlook", &mut c, true).is_err());
    assert!(serde_json::from_value::<Credential>(
        json!({"token":"fixture", "headers":{"Authorization":"evil"}})
    )
    .is_err());
}

#[test]
fn resource_ids_and_pagination_cannot_change_the_credential_destination() {
    let c = credential("outlook");
    let mut request = probe_request("outlook");
    for cursor in [
        "https://evil.example/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/me/drive",
        "https://user:pass@graph.microsoft.com/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/me/messages?access_token=secret",
    ] {
        request.cursor = Some(cursor.into());
        assert!(map_read(&c, &request).is_err(), "{cursor}");
    }
    request.cursor = Some("https://graph.microsoft.com/v1.0/me/messages?$skip=20".into());
    assert!(map_read(&c, &request).is_ok());
    request.cursor = None;
    request.capability = "messages.read".into();
    for id in [
        "..",
        "../sendMail",
        "valid?redirect=evil",
        "abc/attachments",
        "%2f..%2f",
        "valid#evil",
    ] {
        request.input.insert("id".into(), json!(id));
        assert!(map_read(&c, &request).is_err(), "{id}");
    }
    request.input.insert("id".into(), json!("message-123="));
    assert!(map_read(&c, &request).is_ok());
}

#[test]
fn greenhouse_v3_uses_verified_link_cursors_without_extra_query_parameters() {
    let requested = Url::parse("https://harvest.greenhouse.io/v3/jobs?per_page=20").unwrap();
    let header = "<https://harvest.greenhouse.io/v3/jobs?cursor=opaque%2Btoken>; rel=\"next\"";
    let cursor = greenhouse_cursor(Some(header), &requested)
        .unwrap()
        .unwrap();
    let mut r = probe_request("greenhouse");
    r.cursor = Some(cursor);
    let read = map_read(&credential("greenhouse"), &r).unwrap();
    assert_eq!(
        read.url.as_str(),
        "https://harvest.greenhouse.io/v3/jobs?cursor=opaque%2Btoken"
    );
    assert!(greenhouse_cursor(
        Some("<https://evil.example/v3/jobs?cursor=x>; rel=\"next\""),
        &requested
    )
    .is_err());
    assert!(greenhouse_cursor(
        Some("<https://harvest.greenhouse.io/v3/candidates?cursor=x>; rel=\"next\""),
        &requested
    )
    .is_err());
    assert!(greenhouse_cursor(
        Some("<https://harvest.greenhouse.io/v3/jobs?cursor=x&access_token=secret>; rel=\"next\""),
        &requested
    )
    .is_err());
    assert!(greenhouse_cursor(None, &requested).unwrap().is_none());
}

#[test]
fn shopify_queries_are_parameterized_and_ads_reads_cannot_mutate_budgets() {
    let mut r = probe_request("shopify");
    r.input
        .insert("query".into(), json!("test\" } mutation { evil }"));
    let read = map_read(&credential("shopify"), &r).unwrap();
    let body = read.body.unwrap();
    assert!(!body["query"].as_str().unwrap().contains("evil"));
    assert_eq!(body["variables"]["query"], r.input["query"]);
    let mut r = probe_request("google-ads");
    r.capability = "campaigns.list".into();
    r.input.insert("customerId".into(), json!("1234567890"));
    let read = map_read(&credential("google-ads"), &r).unwrap();
    assert!(read.url.path().ends_with("/googleAds:search"));
    assert!(read.body.unwrap()["query"]
        .as_str()
        .unwrap()
        .starts_with("SELECT "));
    r.input.insert("customerId".into(), json!("123:mutate"));
    assert!(map_read(&credential("google-ads"), &r).is_err());
}

#[test]
fn empty_lists_are_valid_but_error_shapes_and_unbounded_inputs_are_not() {
    for id in IDS {
        let mut r = probe_request(id);
        r.input.insert("limit".into(), json!(51));
        assert!(map_read(&credential(id), &r).is_err());
    }
    let r = probe_request("outlook");
    let read = map_read(&credential("outlook"), &r).unwrap();
    assert_eq!(extract(&r, &read, &json!({"value":[]})).unwrap().0.len(), 0);
    assert!(extract(&r, &read, &json!({"error":"invalid token"})).is_err());
    assert!(extract(&r, &read, &json!({"value":{}})).is_err());
    let next = "https://graph.microsoft.com/v1.0/me/messages?$skip=20";
    assert_eq!(
        extract(
            &r,
            &read,
            &json!({"value":[{"id":"message-1"}],"@odata.nextLink":next})
        )
        .unwrap()
        .1
        .as_deref(),
        Some(next)
    );
}

#[test]
fn credential_fields_and_tokenized_download_links_never_reach_the_model() {
    let c = credential("google-ads");
    let mut data = json!({"text":"fixture-private-token", "nested":{"access_token":"other-token","recording_play_passcode":"secret","safe":"readable"}, "download_url":"https://zoom.us/recording?access_token=another-token&id=123", "description":"fixture-developer-token"});
    redact(&mut data, &c);
    let encoded = data.to_string();
    for secret in [
        "fixture-private-token",
        "other-token",
        "another-token",
        "fixture-developer-token",
        "access_token",
        "passcode",
    ] {
        assert!(!encoded.contains(secret));
    }
    assert_eq!(data["nested"]["safe"], "readable");
    assert!(data["download_url"].as_str().unwrap().contains("id=123"));
    for cursor in [
        "https://graph.microsoft.com/v1.0/me/messages?access_token=other-secret",
        "https://graph.microsoft.com/v1.0/me/messages?ACCESS_TOKEN=other-secret",
        "https://graph.microsoft.com/v1.0/me/messages?offset=fixture%2Dprivate%2Dtoken",
        "https://user:private@graph.microsoft.com/v1.0/me/messages?$skip=20",
        "fixture-private-token",
    ] {
        assert!(!safe_cursor(cursor, &c), "{cursor}");
    }
    assert!(safe_cursor(
        "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque%2Bcursor",
        &c
    ));
    assert!(safe_cursor("opaque-page-token", &c));
}

async fn fixture_response(response: String) -> (String, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut data = vec![0; 8192];
        let size = stream.read(&mut data).await.unwrap();
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&data[..size]).to_string()
    });
    (format!("http://{address}/fixture"), task)
}

#[tokio::test]
async fn native_transport_authenticates_rejects_redirects_and_suppresses_error_bodies() {
    for id in ["outlook", "greenhouse", "lever", "shopify", "google-ads"] {
        let (url, task) = fixture_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
        )
        .await;
        send(id, &credential(id), &get(url, "").unwrap())
            .await
            .unwrap();
        let request = task.await.unwrap().to_ascii_lowercase();
        assert!(request.contains(match id {
            "lever" => "authorization: basic ",
            "shopify" => "x-shopify-access-token: fixture-private-token",
            _ => "authorization: bearer fixture-private-token",
        }));
        if id == "google-ads" {
            assert!(request.contains("developer-token: fixture-developer-token"));
        }
    }
    let (url, task) = fixture_response("HTTP/1.1 302 Found\r\nLocation: https://evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()).await;
    assert!(
        send("outlook", &credential("outlook"), &get(url, "").unwrap())
            .await
            .is_err()
    );
    task.await.unwrap();
    let (url, task) = fixture_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 21\r\nConnection: close\r\n\r\nfixture-private-token".into()).await;
    let err = send("outlook", &credential("outlook"), &get(url, "").unwrap())
        .await
        .unwrap_err();
    task.await.unwrap();
    assert_eq!(err.code, "needs-auth");
    assert!(!err.message.contains("fixture-private-token"));
}
