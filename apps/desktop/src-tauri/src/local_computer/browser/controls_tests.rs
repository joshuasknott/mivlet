use super::*;

fn frame() -> Frame {
    Frame {
        id: "frame".into(),
        loader: "loader".into(),
        url: "https://example.test/report".into(),
    }
}
#[test]
fn click_choice_binds_label_document_origin_window_generation_and_age() {
    let mut choice = Choice {
        hwnd: 1,
        generation: 2,
        window: 3,
        created: Instant::now(),
        target: "native-target".into(),
        session: "private-session".into(),
        frame: frame(),
        origin: "https://example.test".into(),
        control: Control {
            backend: 4,
            role: "button".into(),
            name: "Submit".into(),
            metadata: json!({}),
        },
    };
    choice
        .check(1, 2, 3, "https://example.test", "Submit", &frame())
        .unwrap();
    for (hwnd, generation, window, origin, name) in [
        (9, 2, 3, "https://example.test", "Submit"),
        (1, 9, 3, "https://example.test", "Submit"),
        (1, 2, 9, "https://example.test", "Submit"),
        (1, 2, 3, "https://other.test", "Submit"),
        (1, 2, 3, "https://example.test", "Delete"),
    ] {
        assert!(choice
            .check(hwnd, generation, window, origin, name, &frame())
            .is_err());
    }
    for field in ["loader", "id", "url"] {
        let mut changed = frame();
        match field {
            "loader" => changed.loader = "new-loader".into(),
            "id" => changed.id = "other-frame".into(),
            _ => changed.url = "https://example.test/other".into(),
        }
        assert!(choice
            .check(1, 2, 3, "https://example.test", "Submit", &changed)
            .is_err());
    }
    choice.created = Instant::now() - Duration::from_secs(31);
    assert!(choice
        .check(1, 2, 3, "https://example.test", "Submit", &frame())
        .is_err());
}
#[test]
fn only_public_named_enabled_buttons_and_links_are_candidates() {
    let node = json!({"backendDOMNodeId":42,"ignored":false,"role":{"value":"button"},"name":{"value":"Submit"}});
    assert_eq!(
        candidate(&node).unwrap(),
        (42, "button".into(), "Submit".into())
    );
    for (key, value) in [
        ("role", json!({"value":"textbox"})),
        ("ignored", json!(true)),
        ("name", json!({"value":""})),
        (
            "properties",
            json!([{"name":"disabled","value":{"value":true}}]),
        ),
    ] {
        let mut changed = node.clone();
        changed[key] = value;
        assert!(candidate(&changed).is_none());
    }
}
#[test]
fn dom_metadata_rejects_editable_downloads_credentials_and_non_http_links() {
    let button = json!({"nodeType":1,"nodeName":"BUTTON","attributes":["type","submit"]});
    assert!(metadata(&button, "button", &frame().url).is_some());
    for attributes in [
        json!(["disabled", ""]),
        json!(["contenteditable", "true"]),
        json!(["hidden", ""]),
        json!(["download", "report.pdf"]),
    ] {
        let mut blocked = button.clone();
        blocked["attributes"] = attributes;
        assert!(metadata(&blocked, "button", &frame().url).is_none());
    }
    for href in [
        "javascript:alert(1)",
        "file:///private",
        "data:text/html,unsafe",
        "https://user:pass@example.test/",
    ] {
        assert!(metadata(
            &json!({"nodeType":1,"nodeName":"A","attributes":["href",href]}),
            "link",
            &frame().url
        )
        .is_none());
    }
    assert!(metadata(
        &json!({"nodeType":1,"nodeName":"A","attributes":["href","/next"]}),
        "link",
        &frame().url
    )
    .is_some());
    assert!(metadata(
        &json!({"nodeType":1,"nodeName":"INPUT","attributes":["type","file"]}),
        "button",
        &frame().url
    )
    .is_none());
}
#[test]
fn click_point_requires_one_finite_visible_untransformed_quad_without_zoom() {
    let quad = json!({"quads":[[10,20,110,20,110,60,10,60]]});
    let viewport = json!({"cssVisualViewport":{"clientWidth":800,"clientHeight":600,"scale":1,"offsetX":0,"offsetY":0}});
    assert_eq!(point(&quad, &viewport).unwrap(), (60, 40));
    for values in [
        json!([]),
        json!([[10, 20, 110, 20, 110, 60, 10, 60], [1, 2, 3, 2, 3, 4, 1, 4]]),
        json!([[-10, 20, 110, 20, 110, 60, -10, 60]]),
        json!([[10, 20, 110, 21, 110, 60, 10, 60]]),
        json!([[10, 20, 110, 20, 110, 700, 10, 700]]),
        json!([[10, 20, 11, 20, 11, 21, 10, 21]]),
    ] {
        assert!(point(&json!({"quads":values}), &viewport).is_err());
    }
    let mut zoomed = viewport.clone();
    zoomed["cssVisualViewport"]["scale"] = json!(2);
    assert!(point(&quad, &zoomed).is_err());
    let mut page_zoomed = viewport;
    page_zoomed["cssVisualViewport"]["zoom"] = json!(2);
    assert!(point(&quad, &page_zoomed).is_err());
}
