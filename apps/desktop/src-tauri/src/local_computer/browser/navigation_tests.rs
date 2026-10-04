use super::*;

fn frame(url: &str, origin: &str) -> Value {
    json!({"frameTree":{"frame":{"id":"frame-one","loaderId":"loader-one","url":url,"securityOrigin":origin}}})
}
#[test]
fn navigation_choices_bind_window_generation_source_and_document() {
    let value = frame("https://example.com/report", "https://example.com");
    let mut choice = Choice::capture(
        10,
        2,
        77,
        "target",
        "session",
        "https://example.com/report",
        &value,
    )
    .unwrap();
    assert!(choice
        .check(10, 2, "https://example.com", 77, &value)
        .is_ok());
    assert!(choice
        .check(11, 2, "https://example.com", 77, &value)
        .is_err());
    assert!(choice
        .check(10, 3, "https://example.com", 77, &value)
        .is_err());
    assert!(choice
        .check(10, 2, "https://outside.example", 77, &value)
        .is_err());
    assert!(choice
        .check(10, 2, "https://example.com", 78, &value)
        .is_err());
    let mut changed = value.clone();
    changed["frameTree"]["frame"]["loaderId"] = "loader-two".into();
    assert!(choice
        .check(10, 2, "https://example.com", 77, &changed)
        .is_err());
    changed = value.clone();
    changed["frameTree"]["frame"]["url"] = "https://example.com/other".into();
    assert!(choice
        .check(10, 2, "https://example.com", 77, &changed)
        .is_err());
    choice.created = Instant::now() - Duration::from_secs(31);
    assert!(choice
        .check(10, 2, "https://example.com", 77, &value)
        .is_err());
}
#[test]
fn initial_blank_can_be_navigated_but_other_internal_urls_cannot() {
    assert!(Choice::capture(
        10,
        1,
        77,
        "target",
        "session",
        "about:blank",
        &frame("about:blank", "://")
    )
    .is_ok());
    for value in [
        "about:srcdoc",
        "chrome://settings",
        "file:///C:/private",
        "data:text/html,private",
    ] {
        assert!(source_origin(value).is_err());
    }
    assert!(Choice::capture(
        10,
        1,
        77,
        "target",
        "session",
        "about:blank",
        &frame("https://example.com/", "https://example.com")
    )
    .is_err());
}
#[test]
fn destinations_are_bounded_http_urls_without_credentials_or_control_characters() {
    assert_eq!(
        destination("https://example.com/path?q=report")
            .unwrap()
            .origin()
            .ascii_serialization(),
        "https://example.com"
    );
    for value in [
        "https://user:password@example.com/",
        "javascript:alert(1)",
        "file:///C:/private",
        "data:text/html,private",
        "https://example.com/\n",
        "ftp://example.com/",
    ] {
        assert!(destination(value).is_err());
    }
    assert!(destination(&format!("https://example.com/{}", "x".repeat(2048))).is_err());
}
