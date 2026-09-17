use super::*;

fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&[0; 16]).unwrap();
    writer.finish().unwrap();
    bytes
}

fn delivery(enabled: bool) -> ImageDelivery {
    let mut delivery = ImageDelivery::new(enabled);
    delivery.bind_thread("thread-1");
    delivery.observe(
        &json!({"method":"turn/started", "params":{"threadId":"thread-1", "turn":{"id":"turn-1"}}}),
        |_| panic!("no image"),
        |_| panic!("no event"),
    );
    delivery
}

fn notification(method: &str) -> Value {
    json!({"method":method, "params":{"threadId":"thread-1", "turnId":"turn-1", "item":{
        "type":"imageGeneration", "id":"image-1", "status":"completed",
        "result":STANDARD.encode(png()), "failure":null,
        "savedPath":"C:/private/never-read.png", "revisedPrompt":"PRIVATE_PROMPT_CANARY"
    }}})
}

#[test]
fn imports_once_and_only_emits_a_receipt_including_completion_without_start() {
    for has_start in [false, true] {
        let mut delivery = delivery(true);
        let mut events = Vec::new();
        if has_start {
            for _ in 0..2 {
                delivery.observe(
                    &notification("item/started"),
                    |_| panic!("not complete"),
                    |v| events.push(v),
                );
            }
        }
        let mut imports = 0;
        for _ in 0..2 {
            delivery.observe(
                &notification("item/completed"),
                |bytes| {
                    assert_eq!(bytes, png());
                    imports += 1;
                    Ok("{\"kind\":\"computer-artifact\"}".into())
                },
                |v| events.push(v),
            );
        }
        assert_eq!(imports, 1);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["status"], "running");
        assert_eq!(events[1]["status"], "succeeded");
        assert_eq!(events[1]["output"], "{\"kind\":\"computer-artifact\"}");
        let public = serde_json::to_string(&events).unwrap();
        for private in [
            STANDARD.encode(png()),
            "C:/private".into(),
            "PRIVATE_PROMPT_CANARY".into(),
        ] {
            assert!(!public.contains(&private));
        }
    }
}

#[test]
fn rejects_bad_images_paths_empty_results_and_provider_failures() {
    let good = notification("item/completed")["params"]["item"].clone();
    let mut corrupt = png();
    corrupt[40] ^= 0xff;
    let mut trailing = png();
    trailing.extend_from_slice(b"payload");
    for result in [
        String::new(),
        "C:/private/never-read.png".into(),
        "https://example.com/image.png".into(),
        "not-base64".into(),
        STANDARD.encode(b"not a png"),
        STANDARD.encode(corrupt),
        STANDARD.encode(trailing),
        "A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4),
    ] {
        let mut bad = good.clone();
        bad["result"] = json!(result);
        assert!(decode_result(&bad).is_err());
    }
    for status in ["failed", "in_progress", "unknown"] {
        let mut bad = good.clone();
        bad["status"] = json!(status);
        assert!(decode_result(&bad).is_err());
    }
    let mut limited = good;
    limited["failure"] = json!({"type":"usageLimitExceeded", "limitId":"image"});
    assert!(decode_result(&limited)
        .unwrap_err()
        .contains("subscription usage limit"));
}

#[test]
fn missing_scope_and_failed_publication_never_report_success() {
    for enabled in [false, true] {
        let mut delivery = delivery(enabled);
        let mut events = Vec::new();
        let mut imports = 0;
        delivery.observe(
            &notification("item/completed"),
            |_| {
                imports += 1;
                Err("Computer authority changed.".into())
            },
            |v| events.push(v),
        );
        assert_eq!(imports, usize::from(enabled));
        assert_eq!(events.last().unwrap()["status"], "failed");
    }
}

#[test]
fn stop_and_foreign_thread_or_turn_discard_results_before_import() {
    let mut delivery = delivery(true);
    for field in ["threadId", "turnId"] {
        let mut foreign = notification("item/completed");
        foreign["params"][field] = json!("foreign");
        delivery.observe(
            &foreign,
            |_| panic!("foreign image imported"),
            |_| panic!("foreign event"),
        );
    }
    *delivery.stopped.lock().unwrap() = true;
    delivery.observe(
        &notification("item/completed"),
        |_| panic!("stopped image imported"),
        |_| panic!("stopped event"),
    );
}

#[test]
fn provider_error_disables_late_image_delivery() {
    let mut delivery = delivery(true);
    delivery.observe(
        &json!({"method":"error", "params":{"message":"provider stopped"}}),
        |_| panic!("no import"),
        |_| panic!("adapter emits the error"),
    );
    delivery.observe(
        &notification("item/completed"),
        |_| panic!("late import"),
        |_| panic!("late event"),
    );
}

#[test]
fn terminal_turn_reports_missing_images_and_rejects_late_completion() {
    let mut delivery = delivery(true);
    delivery.observe(
        &notification("item/started"),
        |_| panic!("not complete"),
        |_| {},
    );
    let mut events = Vec::new();
    delivery.observe(&json!({"method":"turn/completed", "params":{"threadId":"thread-1", "turn":{"id":"turn-1"}}}), |_| panic!("not an image"), |v| events.push(v));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"], "failed");
    delivery.observe(
        &notification("item/completed"),
        |_| panic!("late image imported"),
        |_| panic!("late event"),
    );
}

#[test]
fn caps_image_results_per_turn() {
    let mut delivery = delivery(true);
    let mut events = Vec::new();
    for index in 0..=MAX_IMAGES {
        let mut start = notification("item/started");
        start["params"]["item"]["id"] = json!(format!("image-{index}"));
        delivery.observe(&start, |_| panic!("not complete"), |v| events.push(v));
    }
    assert_eq!(events.last().unwrap()["type"], "error");
    assert_eq!(delivery.started.len(), MAX_IMAGES);
}
