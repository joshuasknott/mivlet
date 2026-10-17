use super::*;

fn node() -> Value {
    json!({"backendDOMNodeId":42,"ignored":false,"role":{"value":"textbox"},"name":{"value":"Public topic"},"value":{"value":""}})
}
fn input() -> Value {
    json!({"nodeType":1,"nodeName":"INPUT","attributes":["type","text","aria-label","Public topic"]})
}
#[test]
fn only_named_empty_public_text_fields_offer_choices() {
    assert_eq!(candidate(&node()), Some((42, "Public topic".into())));
    for (field, value) in [
        ("value", json!({"value":"Human's existing text"})),
        ("name", json!({"value":"Password"})),
        ("name", json!({"value":""})),
        ("role", json!({"value":"combobox"})),
        (
            "properties",
            json!([{"name":"readonly","value":{"value":true}}]),
        ),
    ] {
        let mut changed = node();
        changed[field] = value;
        assert!(candidate(&changed).is_none(), "{field}");
    }
    let mut missing = node();
    missing.as_object_mut().unwrap().remove("value");
    assert!(candidate(&missing).is_none());
}
#[test]
fn native_metadata_excludes_private_fields_and_preserves_existing_content() {
    assert!(metadata(&input()).is_some());
    for attrs in [
        json!(["type", "password"]),
        json!(["type", "file"]),
        json!(["type", "number"]),
        json!(["autocomplete", "one-time-code"]),
        json!(["autocomplete", "cc-number"]),
        json!(["name", "api_token"]),
        json!(["value", "already filled"]),
        json!(["readonly", ""]),
        json!(["contenteditable", "true"]),
        json!(["hidden", ""]),
        json!(["disabled", ""]),
    ] {
        let mut changed = input();
        changed["attributes"] = attrs;
        assert!(metadata(&changed).is_none());
    }
    assert!(metadata(&json!({"nodeType":1,"nodeName":"TEXTAREA","attributes":[]})).is_some());
}
#[test]
fn form_choice_expires_and_binds_exact_document_origin_name_window_and_generation() {
    let frame = Frame {
        id: "frame".into(),
        loader: "loader".into(),
        url: "https://example.test/form".into(),
    };
    let mut choice = Choice {
        hwnd: 1,
        generation: 2,
        window: 3,
        created: Instant::now(),
        target: "target".into(),
        session: "session".into(),
        frame: frame.clone(),
        origin: "https://example.test".into(),
        field: Field {
            backend: 42,
            name: "Public topic".into(),
            metadata: metadata(&input()).unwrap(),
        },
    };
    choice
        .check((1, 2, 3), "https://example.test", "Public topic", &frame)
        .unwrap();
    for (scope, origin, name) in [
        ((9, 2, 3), "https://example.test", "Public topic"),
        ((1, 9, 3), "https://example.test", "Public topic"),
        ((1, 2, 9), "https://example.test", "Public topic"),
        ((1, 2, 3), "https://other.test", "Public topic"),
        ((1, 2, 3), "https://example.test", "Password"),
    ] {
        assert!(choice.check(scope, origin, name, &frame).is_err());
    }
    let mut changed = frame.clone();
    changed.loader = "other-loader".into();
    assert!(choice
        .check((1, 2, 3), "https://example.test", "Public topic", &changed)
        .is_err());
    choice.created = Instant::now() - Duration::from_secs(31);
    assert!(choice
        .check((1, 2, 3), "https://example.test", "Public topic", &frame)
        .is_err());
}
#[test]
fn field_text_is_bounded_and_never_treats_input_as_source() {
    validate_text("A public topic").unwrap();
    validate_text("');globalThis.exfiltrate();//").unwrap();
    assert!(validate_text("").is_err());
    assert!(validate_text(&"x".repeat(2049)).is_err());
    assert!(validate_text("hello\0world").is_err());
    assert!(validate_text("Bearer abcdefghijklmnopqrstuvwxyz1234567890").is_err());
}
