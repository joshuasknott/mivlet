use super::*;

fn viewport() -> Viewport {
    Viewport {
        width: 800.0,
        height: 600.0,
        page_x: 0.0,
        page_y: 0.0,
    }
}
fn frame() -> Frame {
    Frame {
        id: "frame".into(),
        loader: "loader".into(),
        url: "https://example.test/report".into(),
    }
}
#[test]
fn scroll_choice_binds_document_window_generation_viewport_and_age() {
    let mut choice = Choice {
        scope: (1, 2, 3),
        created: Instant::now(),
        target: "target".into(),
        session: "session".into(),
        frame: frame(),
        origin: "https://example.test".into(),
        viewport: viewport(),
        hit: (4, json!({})),
    };
    choice
        .check((1, 2, 3), "https://example.test", &frame(), &viewport())
        .unwrap();
    for scope in [(9, 2, 3), (1, 9, 3), (1, 2, 9)] {
        assert!(choice
            .check(scope, "https://example.test", &frame(), &viewport())
            .is_err());
    }
    assert!(choice
        .check((1, 2, 3), "https://other.test", &frame(), &viewport())
        .is_err());
    for field in ["id", "loader", "url"] {
        let mut changed = frame();
        match field {
            "id" => changed.id = "other".into(),
            "loader" => changed.loader = "other".into(),
            _ => changed.url.push_str("#changed"),
        }
        assert!(choice
            .check((1, 2, 3), "https://example.test", &changed, &viewport())
            .is_err());
    }
    for field in ["width", "height", "page_x", "page_y"] {
        let mut changed = viewport();
        match field {
            "width" => changed.width += 1.0,
            "height" => changed.height += 1.0,
            "page_x" => changed.page_x += 1.0,
            _ => changed.page_y += 1.0,
        }
        assert!(choice
            .check((1, 2, 3), "https://example.test", &frame(), &changed)
            .is_err());
    }
    choice.created = Instant::now() - Duration::from_secs(31);
    assert!(choice
        .check((1, 2, 3), "https://example.test", &frame(), &viewport())
        .is_err());
}
#[test]
fn wheel_is_one_bounded_vertical_event_without_modifiers_or_buttons() {
    let expected = json!({"type":"mouseWheel","x":400,"y":300,"deltaX":0,"deltaY":480.0,"modifiers":0,"buttons":0,"button":"none","pointerType":"mouse"});
    assert_eq!(viewport().wheel("down").unwrap(), expected);
    assert_eq!(viewport().wheel("up").unwrap()["deltaY"], -480.0);
    assert!(viewport().wheel("left").is_err());
    let mut huge = viewport();
    huge.height = 10000.0;
    assert_eq!(huge.wheel("down").unwrap()["deltaY"], 600.0);
}
#[test]
fn viewport_requires_bounded_unzoomed_numbers_and_scroll_positions() {
    let layout = json!({"cssVisualViewport":{"clientWidth":800,"clientHeight":600,"pageX":0,"pageY":0,"scale":1,"offsetX":0,"offsetY":0,"zoom":1}});
    assert!(Viewport::read(&layout).is_some());
    for (key, value) in [
        ("scale", json!(2)),
        ("zoom", json!(2)),
        ("offsetX", json!(1)),
        ("offsetY", json!(1)),
        ("clientWidth", json!(99)),
        ("clientHeight", json!(10001)),
        ("pageY", json!(-1)),
        ("pageX", Value::Null),
    ] {
        let mut changed = layout.clone();
        changed["cssVisualViewport"][key] = value;
        assert!(Viewport::read(&changed).is_none());
    }
}
#[test]
fn wheel_hit_refuses_widgets_editable_ancestors_and_unbound_nodes() {
    let tree = json!([
        {"nodeId":"root","role":{"value":"RootWebArea"},"frameId":"frame","childIds":["parent"]},
        {"nodeId":"parent","parentId":"root","role":{"value":"generic"},"childIds":["child"]},
        {"nodeId":"child","parentId":"parent","role":{"value":"paragraph"},"backendDOMNodeId":4}
    ])
    .as_array()
    .unwrap()
    .clone();
    assert!(public_hit(&tree, "frame", 4).unwrap());
    assert!(!public_hit(&tree, "frame", 99).unwrap());
    for role in [
        "textbox",
        "button",
        "link",
        "spinbutton",
        "combobox",
        "slider",
        "RootWebArea",
    ] {
        let mut blocked = tree.clone();
        blocked[1]["role"]["value"] = json!(role);
        assert!(!public_hit(&blocked, "frame", 4).unwrap());
    }
    for editable in [json!("richtext"), json!(true), Value::Null] {
        let mut blocked = tree.clone();
        blocked[1]["properties"] = json!([{"name":"editable","value":{"value":editable}}]);
        assert!(!public_hit(&blocked, "frame", 4).unwrap());
    }
    let mut broken = tree.clone();
    broken[1]["childIds"] = json!([]);
    assert!(!public_hit(&broken, "frame", 4).unwrap());
    let mut foreign = tree;
    foreign[2]["frameId"] = json!("subframe");
    assert!(!public_hit(&foreign, "frame", 4).unwrap());
}
#[test]
fn wheel_metadata_never_accepts_fields_or_editable_dom_targets() {
    let node = json!({"nodeType":1,"nodeName":"DIV","attributes":[]});
    assert!(metadata(&node).is_some());
    for tag in ["INPUT", "SELECT", "TEXTAREA", "IFRAME", "BUTTON", "A"] {
        let mut blocked = node.clone();
        blocked["nodeName"] = json!(tag);
        assert!(metadata(&blocked).is_none());
    }
    for attributes in [
        json!(["contenteditable", "true"]),
        json!(["hidden", ""]),
        json!(["inert", ""]),
        json!(["bad"]),
    ] {
        let mut blocked = node.clone();
        blocked["attributes"] = attributes;
        assert!(metadata(&blocked).is_none());
    }
}
