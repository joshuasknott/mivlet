use super::*;

#[test]
fn hit_coordinates_add_only_bounded_native_scroll_offsets() {
    assert_eq!(document_point((60, 40), (0.0, 0.0)).unwrap(), (60, 40));
    assert_eq!(
        document_point((60, 40), (500.0, 1200.0)).unwrap(),
        (560, 1240)
    );
    assert_eq!(document_point((60, 40), (0.0, 1200.5)).unwrap(), (60, 1241));
    for offsets in [
        (f64::NAN, 0.0),
        (0.0, f64::INFINITY),
        (-1.0, 0.0),
        (0.0, 10_000_001.0),
    ] {
        assert!(document_point((60, 40), offsets).is_err());
    }
    assert!(document_point((-1, 40), (0.0, 0.0)).is_err());
    assert!(document_point((60, 10001), (0.0, 0.0)).is_err());
}

#[test]
fn button_role_file_choosers_require_metadata_privacy_check_before_any_projection() {
    let nodes = vec![
        json!({"nodeId":"root","role":{"value":"RootWebArea"},"frameId":"frame","childIds":["file"]}),
        json!({"nodeId":"file","role":{"value":"button"},"backendDOMNodeId":42,"name":{"value":"private selected filename"}}),
    ];
    assert_eq!(privacy_fields(&nodes, "frame").unwrap(), vec![1]);
    assert!(private_attributes(&json!({"nodeType":1,"attributes":["type","file"]})).unwrap());
    assert!(!private_attributes(&json!({"nodeType":1,"attributes":["type","submit"]})).unwrap());
}

#[test]
fn tab_choices_are_exact_window_generation_expiry_and_single_use_fenced() {
    let mut snapshot = TabSnapshot {
        hwnd: 10,
        generation: 2,
        created: Instant::now(),
        window: 77,
        choices: HashMap::from([("opaque-ref".into(), "native-target".into())]),
        activations: HashMap::new(),
    };
    assert!(snapshot.consume(11, 2, "opaque-ref").is_err());
    assert!(snapshot.consume(10, 3, "opaque-ref").is_err());
    assert!(snapshot.consume(10, 2, "different-ref").is_err());
    assert_eq!(
        snapshot.consume(10, 2, "opaque-ref").unwrap(),
        ("native-target".into(), 77)
    );
    assert!(snapshot.consume(10, 2, "opaque-ref").is_err());
    snapshot.created = Instant::now() - Duration::from_secs(61);
    snapshot
        .choices
        .insert("expired".into(), "native-target".into());
    assert!(snapshot.consume(10, 2, "expired").is_err());
}

#[test]
fn origins_are_exact_http_boundaries_and_never_export_userinfo_or_queries() {
    assert_eq!(
        exact_origin("https://example.com").unwrap(),
        "https://example.com"
    );
    assert_eq!(
        url_origin("https://example.com/private?secret=value#fragment").unwrap(),
        "https://example.com"
    );
    for value in [
        "https://example.com/",
        "https://example.com/path",
        "https://user:password@example.com",
        "https://example.com?token=value",
        "file:///C:/private",
        "data:text/html,private",
        "javascript:alert(1)",
        "https://example.com\n",
    ] {
        assert!(exact_origin(value).is_err());
    }
}

fn node(id: &str, role: &str, name: &str, children: &[&str]) -> Value {
    json!({"nodeId":id,"ignored":false,"role":{"value":role},"name":{"value":name},"childIds":children})
}
#[test]
fn projection_omits_field_values_editable_descendants_and_subframes() {
    let mut root = node("1", "RootWebArea", "Public report", &["2", "3", "5", "7"]);
    root["frameId"] = "approved-frame".into();
    let mut input = node("3", "textbox", "Notes", &["4"]);
    input["value"] = json!({"value":"private field contents"});
    let mut editable = node("5", "generic", "", &["6"]);
    editable["properties"] = json!([{"name":"editable","value":{"value":"richtext"}}]);
    let mut subframe = node("7", "RootWebArea", "private subframe", &["8"]);
    subframe["frameId"] = "other-origin-frame".into();
    let output = projection(
        &[
            root,
            node("2", "StaticText", "Revenue 42", &[]),
            input,
            node("4", "StaticText", "private input descendant", &[]),
            editable,
            node("6", "StaticText", "private editor contents", &[]),
            subframe,
            node("8", "StaticText", "private frame contents", &[]),
        ],
        "approved-frame",
    )
    .unwrap();
    let result = serde_json::to_string(&output).unwrap();
    assert!(result.contains("Revenue 42"));
    assert!(!result.contains("Notes"));
    assert!(!result.contains("private"));
    assert!(!result.contains("value"));
}
#[test]
fn projection_requires_unique_bounded_frame_identity_and_rejects_cycles() {
    assert!(projection(&[], "frame").is_err());
    let mut root = node("1", "RootWebArea", "Report", &["1"]);
    root["frameId"] = "frame".into();
    assert!(projection(&[root.clone()], "frame").is_err());
    assert!(projection(&[root.clone(), root.clone()], "frame").is_err());
    assert!(projection(&vec![root; 2001], "frame").is_err());
}

#[test]
fn editable_text_names_and_value_derived_field_labels_are_omitted() {
    let mut root = node("1", "RootWebArea", "Report", &["2", "3"]);
    root["frameId"] = "frame".into();
    let mut text = node("2", "StaticText", "private editable text", &[]);
    text["properties"] = json!([{"name":"editable","value":{"value":"plaintext"}}]);
    let mut field = node("3", "textbox", "Entered: private input", &[]);
    field["value"] = json!({"value":"private input"});
    let result =
        serde_json::to_string(&projection(&[root, text, field], "frame").unwrap()).unwrap();
    assert!(!result.contains("private"));
    assert!(result.contains("Report"));
}
#[test]
fn partial_long_field_values_cannot_leak_through_accessible_names() {
    let mut root = node("1", "RootWebArea", "Report", &["2"]);
    root["frameId"] = "frame".into();
    let mut field = node("2", "textbox", "partial confidential entry", &[]);
    field["value"] = json!({"value":format!("partial confidential entry{}", "x".repeat(600))});
    let result = serde_json::to_string(&projection(&[root, field], "frame").unwrap()).unwrap();
    assert!(!result.contains("confidential"));
    assert!(result.contains("textbox"));
    assert!(result.contains("Report"));
}
#[test]
fn projection_reports_label_and_total_text_truncation_before_node_limit() {
    let mut root = node("1", "RootWebArea", "Report", &["2"]);
    root["frameId"] = "frame".into();
    let clipped = projection(
        &[root.clone(), node("2", "StaticText", &"a".repeat(401), &[])],
        "frame",
    )
    .unwrap();
    assert!(clipped.truncated);
    assert_eq!(clipped.content[1]["name"].as_str().unwrap().len(), 400);
    let mut nodes = vec![root];
    nodes[0]["childIds"] = json!((2..=50).map(|id| id.to_string()).collect::<Vec<_>>());
    nodes.extend((2..=50).map(|id| node(&id.to_string(), "StaticText", &"b".repeat(400), &[])));
    let clipped = projection(&nodes, "frame").unwrap();
    assert!(clipped.truncated);
    assert_eq!(
        clipped
            .content
            .iter()
            .map(|node| node["name"].as_str().unwrap().chars().count())
            .sum::<usize>(),
        16000
    );
}
#[test]
fn field_privacy_metadata_refuses_password_otp_and_payment_fields() {
    assert!(
        !private_attributes(&json!({"nodeType":3,"nodeValue":"hidden editable descendant"}))
            .unwrap()
    );
    for attrs in [
        json!(["type", "PASSWORD"]),
        json!(["type", "file"]),
        json!(["autocomplete", "section-login one-time-code"]),
        json!(["autocomplete", "cc-number"]),
    ] {
        assert!(private_attributes(&json!({"attributes":attrs})).unwrap());
    }
    assert!(!private_attributes(
        &json!({"attributes":["type","text","value","private field contents"]})
    )
    .unwrap());
    assert!(private_attributes(&json!({})).is_err());
    assert!(private_attributes(&json!({"attributes":["type"]})).is_err());
}
#[test]
fn frame_checks_live_security_origin_and_navigation_identity() {
    let value = json!({"frameTree":{"frame":{"id":"frame","loaderId":"loader","url":"https://example.com/report","securityOrigin":"https://example.com"}}});
    assert!(frame(&value, "https://example.com").is_ok());
    assert!(frame(&value, "https://other.example").is_err());
    let mut changed = value.clone();
    changed["frameTree"]["frame"]["securityOrigin"] = "https://other.example".into();
    assert!(frame(&changed, "https://example.com").is_err());
}

#[test]
fn virtual_editable_text_requires_a_checked_real_editable_ancestor() {
    let mut root = node("1", "RootWebArea", "Report", &["2"]);
    root["frameId"] = "frame".into();
    let mut field = node("2", "textbox", "Notes", &["3"]);
    field["backendDOMNodeId"] = 20.into();
    let mut virtual_text = node("3", "InlineTextBox", "hidden value", &[]);
    virtual_text["parentId"] = "2".into();
    virtual_text["properties"] = json!([{"name":"editable","value":{"value":"plaintext"}}]);
    assert_eq!(
        privacy_fields(
            &[root.clone(), field.clone(), virtual_text.clone()],
            "frame"
        )
        .unwrap(),
        vec![1]
    );
    virtual_text["parentId"] = "1".into();
    assert!(privacy_fields(&[root, field, virtual_text], "frame").is_err());
}
