use super::*;

fn progress() -> Progress {
    Progress {
        frame: "frame".into(),
        url: "https://example.test/report.csv".into(),
        guid: None,
        bytes: 0,
        complete: false,
    }
}
fn begin() -> Value {
    json!({"kind":"begin","guid":"baadf00d-1234-5678-9abc-0123456789ab","frameId":"frame","url":"https://example.test/report.csv"})
}
fn update(bytes: u64, state: &str) -> Value {
    json!({"kind":"progress","guid":"baadf00d-1234-5678-9abc-0123456789ab","receivedBytes":bytes,"state":state})
}

#[test]
fn receipt_accepts_only_one_exact_frame_url_guid_with_monotonic_bounded_completion() {
    let mut received = progress();
    received.event(&begin()).unwrap();
    received.event(&update(5, "inProgress")).unwrap();
    received.event(&update(10, "completed")).unwrap();
    assert!(received.complete);
    assert_eq!(received.bytes, 10);
    assert!(received.event(&update(10, "completed")).is_err());
    for (key, value) in [
        ("frameId", json!("other")),
        ("url", json!("https://example.test/redirect.csv")),
    ] {
        let mut changed = begin();
        changed[key] = value;
        assert!(progress().event(&changed).is_err());
    }
    for event in [
        begin(),
        update(MAX_BYTES + 1, "inProgress"),
        update(0, "canceled"),
        json!({"kind":"progress","guid":"wrong","receivedBytes":1,"state":"completed"}),
    ] {
        let mut received = progress();
        received.event(&begin()).unwrap();
        assert!(received.event(&event).is_err());
    }
    let mut received = progress();
    received.event(&begin()).unwrap();
    received.event(&update(10, "inProgress")).unwrap();
    assert!(received.event(&update(9, "completed")).is_err());
    assert!(progress().event(&update(0, "completed")).is_err());
}

#[test]
fn download_link_metadata_requires_real_public_http_anchor_and_retains_exact_attributes() {
    let node = json!({"nodeType":1,"nodeName":"A","attributes":["href","/report.csv","download","report.csv"]});
    let (attrs, url) = metadata(&node, "https://example.test/reports/").unwrap();
    assert_eq!(url, "https://example.test/report.csv");
    assert_eq!(attrs["attributes"], node["attributes"]);
    for attributes in [
        json!(["href", "javascript:alert(1)"]),
        json!(["href", "file:///private"]),
        json!(["href", "https://name:password@example.test"]),
        json!(["href", "/report.csv", "hidden", ""]),
        json!(["href"]),
    ] {
        let mut changed = node.clone();
        changed["attributes"] = attributes;
        assert!(metadata(&changed, "https://example.test/").is_none());
    }
}

#[test]
fn passive_filename_and_time_budget_are_bounded_before_transfer() {
    let mut request = DownloadRequest {
        download_ref: "a".repeat(48),
        origin: "https://example.test".into(),
        name: "Report".into(),
        url: "https://example.test/report.csv".into(),
        file_name: "report.csv".into(),
        timeout_seconds: 10,
    };
    validate(&request).unwrap();
    for filename in [
        "../report.csv",
        "folder/report.csv",
        "report.exe",
        "report.html",
        "report.csv ",
        "report.csv:stream",
        ".secret.csv",
    ] {
        request.file_name = filename.into();
        assert!(validate(&request).is_err(), "{filename}");
    }
    request.file_name = "report.csv".into();
    request.timeout_seconds = 11;
    assert!(validate(&request).is_err());
    request.timeout_seconds = 0;
    assert!(validate(&request).is_err());
}

#[test]
fn private_staging_rejects_subdirectories_and_excess_files_or_bytes() {
    let root = tempfile::tempdir().unwrap();
    storage_bound(root.path()).unwrap();
    fs::create_dir(root.path().join("nested")).unwrap();
    assert!(storage_bound(root.path()).is_err());
    fs::remove_dir(root.path().join("nested")).unwrap();
    for index in 0..5 {
        fs::write(root.path().join(index.to_string()), b"x").unwrap();
    }
    assert!(storage_bound(root.path()).is_err());
    let root = tempfile::tempdir().unwrap();
    let file = fs::File::create(root.path().join("large")).unwrap();
    file.set_len(MAX_BYTES + 1).unwrap();
    assert!(storage_bound(root.path()).is_err());
}
