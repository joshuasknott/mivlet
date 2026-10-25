use super::preview::{prepare_open_copy, verify_prepared_copy};
use super::validation::{check_office_metadata_xml, contains_ascii_case_insensitive};
use super::*;
use lopdf::dictionary;
use std::path::PathBuf;

#[test]
fn saving_published_bytes_never_clobbers_and_revocation_prevents_placement() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("report.docx");
    let staged = stage_export(&destination, "docx", b"verified published bytes").unwrap();
    let authority = super::super::authority::ComputerAuthority::load(root.path()).unwrap();
    let ticket = authority.begin_viewer(1).unwrap();
    authority.revoke(1).unwrap();
    assert!(ticket
        .commit(|| commit_export(staged, &destination))
        .is_err());
    assert!(!destination.exists());

    let staged = stage_export(&destination, "docx", b"verified published bytes").unwrap();
    std::fs::write(&destination, b"existing user file").unwrap();
    assert!(commit_export(staged, &destination).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"existing user file");
    assert!(stage_export(&root.path().join("report.exe"), "docx", b"bytes").is_err());
}

#[test]
fn save_copy_contains_exact_published_bytes() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("report.pdf");
    let bytes = b"receipt-verified bytes";
    let staged = stage_export(&destination, "pdf", bytes).unwrap();
    assert!(commit_export(staged, &destination).unwrap());
    assert_eq!(std::fs::read(destination).unwrap(), bytes);
}

#[test]
fn json_preview_is_literal_bounded_utf8_and_export_preserves_original_bytes() {
    let text = format!(
        "{{\"label\":\"{}\",\"html\":\"<script>text only</script>\"}}",
        "Δ".repeat(150_000)
    );
    let bytes = text.as_bytes();
    check_content(bytes, "json").unwrap();
    let receipt = artifact_receipt("Data", "json", bytes);
    let preview = preview_bytes(&receipt.artifact, bytes);
    assert_eq!(preview.mime_type, "application/json");
    let visible = preview.text.as_deref().unwrap();
    assert!(preview.truncated);
    assert!(visible.len() <= 256 * 1024);
    assert!(text.starts_with(visible));
    assert!(preview.image_data_url.is_none());
    assert!(preview.office.is_none());
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("data.json");
    let staged = stage_export(&destination, "json", bytes).unwrap();
    assert!(commit_export(staged, &destination).unwrap());
    assert_eq!(std::fs::read(destination).unwrap(), bytes);
}

#[test]
fn previews_are_bounded_plain_text_or_raster_data() {
    let mut artifact = LocalComputerArtifact {
        kind: "computer-artifact".into(),
        version: 1,
        id: random_id().unwrap(),
        computer_id: "computer".into(),
        title: "Notes".into(),
        mime_type: "text/plain".into(),
        size_bytes: 0,
        relative_path: "notes.txt".into(),
        created_at: "now".into(),
    };
    let text = "é".repeat(150_000);
    let preview = preview_bytes(&artifact, text.as_bytes());
    assert!(preview.truncated);
    assert!(preview.text.unwrap().len() <= 256 * 1024);
    assert!(preview.image_data_url.is_none());
    artifact.mime_type = "image/png".into();
    let preview = preview_bytes(&artifact, b"\x89PNG\r\n\x1a\n");
    assert!(preview
        .image_data_url
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert!(preview.text.is_none());
    let oversized = preview_bytes(&artifact, &vec![0; 8 * 1024 * 1024 + 1]);
    assert!(oversized.image_data_url.is_none());
    artifact.mime_type =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into();
    assert!(preview_bytes(&artifact, b"<script>not rendered</script>")
        .text
        .is_none());
}

#[test]
fn paths_reject_host_traversal_secrets_and_executable_types() {
    for path in [
        "../report.docx",
        "/report.docx",
        "C:/report.docx",
        "a\\report.docx",
        ".config/report.txt",
        "a/./report.docx",
        "a/../report.docx",
        "a//report.docx",
        "report.docx:stream",
        "report.html",
        "report.svg",
        "report.exe",
        "report.xlsm",
        "a /report.txt",
        "report.docx.",
    ] {
        assert!(allowed_path(path).is_err(), "accepted {path}");
    }
    for path in [
        "reports/report.docx",
        "report.docx",
        "result.xlsx",
        "slides.pptx",
        "report.pdf",
        "data.csv",
        "summary.json",
        "notes.md",
        "image.png",
    ] {
        assert!(allowed_path(path).is_ok());
    }
}

#[test]
fn content_must_match_allowlisted_type() {
    assert!(check_content(b"MZ executable", "pdf").is_err());
    assert!(check_content(b"text\0hidden", "txt").is_err());
    assert!(check_content(b"%PDF-1.7\nfixture", "pdf").is_err());
    assert!(check_content(b"hello,world\n1,2", "csv").is_ok());
    assert!(check_content(br#"{"total":15,"items":[true,null,1.5]}"#, "json").is_ok());
    for bytes in [
        b"{invalid}".as_slice(),
        b"NaN",
        b"{} trailing",
        b"\xff",
        b"<script>alert(1)</script>",
    ] {
        assert!(check_content(bytes, "json").is_err());
    }
    assert!(check_content(b"not a zip", "docx").is_err());
    assert!(check_content(b"<svg/>", "svg").is_err());
}

fn pdf_document(modify: impl FnOnce(&mut lopdf::Document, &mut lopdf::Dictionary)) -> Vec<u8> {
    let mut document = lopdf::Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(lopdf::dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    });
    document.objects.insert(
        pages_id,
        lopdf::Object::Dictionary(lopdf::dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        }),
    );
    let mut catalog = lopdf::dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    };
    modify(&mut document, &mut catalog);
    let catalog_id = document.add_object(catalog);
    document.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn pdf_requires_one_strict_unencrypted_passive_document() {
    let valid = pdf_document(|_, _| {});
    assert!(check_content(&valid, "pdf").is_ok());

    let safe_open_destination = pdf_document(|_, catalog| {
        catalog.set(
            "OpenAction",
            lopdf::Object::Array(vec![0.into(), lopdf::Object::Name(b"Fit".to_vec())]),
        );
    });
    assert!(check_content(&safe_open_destination, "pdf").is_ok());

    let mut appended = valid.clone();
    appended.extend_from_slice(b"\n% second update\n%%EOF\n");
    assert!(check_content(&appended, "pdf").is_err());

    let mut encrypted_document = lopdf::Document::load_mem(&valid).unwrap();
    encrypted_document.trailer.set(
        "ID",
        lopdf::Object::Array(vec![
            lopdf::Object::string_literal("first-document-id"),
            lopdf::Object::string_literal("second-document-id"),
        ]),
    );
    let encryption = lopdf::EncryptionState::try_from(lopdf::EncryptionVersion::V2 {
        document: &encrypted_document,
        owner_password: "",
        user_password: "",
        key_length: 128,
        permissions: lopdf::Permissions::all(),
    })
    .unwrap();
    encrypted_document.encrypt(&encryption).unwrap();
    let mut encrypted = Vec::new();
    encrypted_document.save_to(&mut encrypted).unwrap();
    assert!(check_content(&encrypted, "pdf")
        .unwrap_err()
        .contains("Encrypted PDFs"));
}

#[test]
fn pdf_actions_embeds_and_external_streams_are_rejected_after_parsing() {
    let scripted = pdf_document(|document, catalog| {
        let action = document.add_object(lopdf::dictionary! {
            "S" => "JavaScript",
            "JS" => lopdf::Object::string_literal("app.alert('opened')"),
        });
        catalog.set("OpenAction", action);
    });
    assert!(check_content(&scripted, "pdf").is_err());

    let embedded = pdf_document(|document, _| {
        document.add_object(lopdf::Stream::new(
            lopdf::dictionary! { "Type" => "EmbeddedFile" },
            b"payload".to_vec(),
        ));
    });
    assert!(check_content(&embedded, "pdf").is_err());

    let external_stream = pdf_document(|document, _| {
        document.add_object(lopdf::Stream::new(
                lopdf::dictionary! { "F" => lopdf::Object::string_literal("https://example.test/data") },
                Vec::new(),
            ));
    });
    assert!(check_content(&external_stream, "pdf").is_err());

    let mut object_stream_document = lopdf::Document::load_mem(&pdf_document(|_, _| {})).unwrap();
    object_stream_document.add_object(lopdf::dictionary! {
        "S" => "Launch",
        "F" => lopdf::Object::string_literal("payload.exe"),
    });
    let mut object_stream = Vec::new();
    object_stream_document
        .save_modern(&mut object_stream)
        .unwrap();
    assert!(contains_ascii_case_insensitive(&object_stream, b"/ObjStm"));
    assert!(check_content(&object_stream, "pdf").is_err());
}

fn office_fixture(extension: &str, extra: Option<&str>, external: bool) -> Vec<u8> {
    let (main_part, main_content_type) = match extension {
        "docx" => (
            "word/document.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
        "xlsx" => (
            "xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        ),
        "pptx" => (
            "ppt/presentation.xml",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        ),
        _ => unreachable!(),
    };
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for name in [
        Some("[Content_Types].xml"),
        Some("_rels/.rels"),
        Some(main_part),
        extra,
    ]
    .into_iter()
    .flatten()
    {
        if name.ends_with('/') {
            writer
                .add_directory(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            continue;
        }
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        let contents = if name == "[Content_Types].xml" {
            format!("<Types><Override ContentType=\"{main_content_type}\"/></Types>")
        } else if name == "_rels/.rels" && external {
            "<Relationships><Relationship TargetMode='External' Target='https://example.test'/></Relationships>".into()
        } else if name == "_rels/.rels" {
            format!("<Relationships><Relationship Type='relationships/officeDocument' Target='{main_part}'/></Relationships>")
        } else {
            "<fixture/>".into()
        };
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn artifact_receipt(title: &str, extension: &str, bytes: &[u8]) -> ArtifactReceipt {
    ArtifactReceipt {
        artifact: LocalComputerArtifact {
            kind: "computer-artifact".into(),
            version: 1,
            id: random_id().unwrap(),
            computer_id: "computer".into(),
            title: title.into(),
            mime_type: mime_for(extension).unwrap().into(),
            size_bytes: bytes.len() as u64,
            relative_path: format!("report.{extension}"),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
        workspace_id: "workspace".into(),
        agent_id: "agent-a".into(),
        export_name: format!("mivlet-{}.{extension}", crate::paths::file_slug(title)),
        sha256: digest(bytes),
    }
}

#[test]
fn office_documents_require_matching_parts_and_reject_active_content() {
    assert!(check_content(&office_fixture("docx", None, false), "docx").is_ok());
    assert!(check_content(&office_fixture("xlsx", None, false), "xlsx").is_ok());
    assert!(check_content(&office_fixture("pptx", None, false), "pptx").is_ok());
    assert!(check_content(
        &office_fixture("docx", Some("word/hidden.part"), false),
        "docx"
    )
    .is_err());
    assert!(check_content(
        &office_fixture("docx", Some("word/hidden.png"), false),
        "docx"
    )
    .is_err());
    for (extension, part, content_type, xml) in [
            ("docx", "word/document.xml", "wordprocessingml.document", "<document><fldSimple instr='DDEAUTO example'/></document>"),
            ("xlsx", "xl/workbook.xml", "spreadsheetml.sheet", "<workbook><definedName>WEBSERVICE(&quot;https://example.test&quot;)</definedName></workbook>"),
            ("pptx", "ppt/presentation.xml", "presentationml.presentation", "<presentation><hlinkClick action='ppaction://program'/></presentation>"),
        ] {
            let bytes = super::super::office_authoring::zip_files(vec![
                ("[Content_Types].xml".into(), format!("<Types><Override ContentType='application/vnd.openxmlformats-officedocument.{content_type}.main+xml'/></Types>")),
                ("_rels/.rels".into(), super::super::office_authoring::root_relationships(part)),
                (part.into(), xml.into()),
            ]).unwrap();
            assert!(check_content(&bytes, extension).is_err(), "{extension}");
        }
    assert!(check_content(
        &office_fixture("pptx", Some("ppt/embeddings/"), false),
        "pptx"
    )
    .is_ok());
    assert!(check_content(&office_fixture("docx", None, false), "xlsx").is_err());
    assert!(check_content(
        &office_fixture("docx", Some("word/vbaProject.bin"), false),
        "docx"
    )
    .is_err());
    assert!(check_content(
        &office_fixture("pptx", Some("ppt/embeddings/evil.bin"), false),
        "pptx"
    )
    .is_err());
    assert!(check_content(&office_fixture("pptx", None, true), "pptx").is_err());
    assert!(
        check_office_metadata_xml(b"<Types><!-- misleading metadata --></Types>", "document")
            .is_err()
    );
    assert!(
        check_office_metadata_xml(b"<Types ContentType='macro&#69;nabled'/>", "document").is_err()
    );
}

#[test]
#[ignore = "requires explicit generated Office/PDF fixtures in MIVLET_ARTIFACT_FIXTURE_DIR"]
fn generated_documents_pass_the_native_validator() {
    let fixture_root = PathBuf::from(
        std::env::var("MIVLET_ARTIFACT_FIXTURE_DIR")
            .expect("set MIVLET_ARTIFACT_FIXTURE_DIR to the approved document fixture directory"),
    );
    for (relative, extension) in [
        ("source/document.docx", "docx"),
        ("source/workbook.xlsx", "xlsx"),
        ("source/presentation.pptx", "pptx"),
        ("source/report.pdf", "pdf"),
        ("rendered/document.pdf", "pdf"),
        ("rendered/presentation.pdf", "pdf"),
        ("recalculated/workbook.xlsx", "xlsx"),
    ] {
        let path = fixture_root.join(relative);
        let bytes = fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "could not read generated fixture {}: {error}",
                path.display()
            )
        });
        check_content(&bytes, extension).unwrap_or_else(|error| {
            panic!("generated fixture {} was rejected: {error}", path.display())
        });
    }
}

#[test]
fn actual_files_stay_in_root_and_publication_is_immutable() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let source = workspace.join("report.txt");
    fs::write(&source, b"first").unwrap();
    let bytes = read_bounded(&workspace, &source).unwrap();
    let copy = write_copy(
        &temp.path().join("artifacts"),
        &random_id().unwrap(),
        "report.txt",
        &bytes,
    )
    .unwrap();
    fs::write(&source, b"second").unwrap();
    assert_eq!(
        read_bounded(&temp.path().join("artifacts"), &copy).unwrap(),
        b"first"
    );
    assert!(read_bounded(&workspace, &copy).is_err());
    assert_ne!(digest(b"first"), digest(b"second"));
}

#[test]
fn prepared_launch_copy_must_match_the_receipt_at_open_time() {
    let temp = tempfile::tempdir().unwrap();
    let open_root = temp.path().join("artifact-open");
    let bytes = b"verified published bytes\n".to_vec();
    let receipt = artifact_receipt("Report", "txt", &bytes);
    let prepared = prepare_open_copy(&open_root, &receipt, &bytes).unwrap();
    assert_eq!(fs::read(&prepared).unwrap(), bytes);
    // A local process can replace the freshly written launch copy between
    // preparation and the system open; the launch-time check must reject
    // content that never passed validation instead of opening it.
    fs::write(
        &prepared,
        b"replacement content that never passed validation\n",
    )
    .unwrap();
    let error = verify_prepared_copy(&open_root, &prepared, &receipt).unwrap_err();
    assert!(error.contains("changed"));
    // Restoring the verified bytes makes the same check pass.
    fs::write(&prepared, &bytes).unwrap();
    verify_prepared_copy(&open_root, &prepared, &receipt).unwrap();
    // A receipt for different content cannot authorize the prepared copy.
    let other = artifact_receipt("Report", "txt", b"other artifact bytes\n");
    assert!(verify_prepared_copy(&open_root, &prepared, &other).is_err());
    // A path outside the artifact-open root never passes launch verification.
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, &bytes).unwrap();
    assert!(verify_prepared_copy(&open_root, &outside, &receipt).is_err());
}

#[test]
fn a_different_valid_document_cannot_replace_the_prepared_copy() {
    let temp = tempfile::tempdir().unwrap();
    let open_root = temp.path().join("artifact-open");
    let first = office_fixture("docx", None, false);
    let second = office_fixture("docx", Some("word/extra.xml"), false);
    assert_ne!(first, second);
    assert!(check_content(&second, "docx").is_ok());
    let receipt = artifact_receipt("Report", "docx", &first);
    let prepared = prepare_open_copy(&open_root, &receipt, &first).unwrap();
    // Swapping in a different, still-valid document would pass the type
    // check; only the receipt digest can bind the launch copy to the
    // published artifact.
    fs::write(&prepared, &second).unwrap();
    assert!(verify_prepared_copy(&open_root, &prepared, &receipt).is_err());
}

#[test]
fn valid_docx_xlsx_and_pdf_preparation_passes_launch_verification() {
    let temp = tempfile::tempdir().unwrap();
    let open_root = temp.path().join("artifact-open");
    for (extension, bytes) in [
        ("docx", office_fixture("docx", None, false)),
        ("xlsx", office_fixture("xlsx", None, false)),
        ("pdf", pdf_document(|_, _| {})),
    ] {
        let receipt = artifact_receipt("Valid document", extension, &bytes);
        let prepared = prepare_open_copy(&open_root, &receipt, &bytes).unwrap();
        assert_eq!(
            prepared.file_name().unwrap().to_str().unwrap(),
            format!("mivlet-valid-document.{extension}")
        );
        assert_eq!(fs::read(&prepared).unwrap(), bytes);
        verify_prepared_copy(&open_root, &prepared, &receipt).unwrap();
    }
}

#[test]
#[cfg(windows)]
fn prepared_copy_reached_through_a_junction_is_rejected_before_launch() {
    use std::process::Command;
    let temp = tempfile::tempdir().unwrap();
    let open_root = temp.path().join("artifact-open");
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let bytes = b"verified published bytes\n".to_vec();
    let receipt = artifact_receipt("Report", "txt", &bytes);
    let prepared = prepare_open_copy(&open_root, &receipt, &bytes).unwrap();
    let id = prepared.parent().unwrap();
    let kept = temp.path().join("kept");
    fs::rename(id, &kept).unwrap();
    let junction = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(id)
        .arg(&outside)
        .status();
    match junction {
        Ok(status) if status.success() => {}
        _ => {
            eprintln!("skipping junction regression: mklink /J unavailable");
            return;
        }
    }
    // The same bytes now sit behind a junction outside the artifact root.
    fs::write(outside.join(receipt.export_name.clone()), &bytes).unwrap();
    assert!(verify_prepared_copy(&open_root, &prepared, &receipt).is_err());
}

#[test]
fn opaque_ids_and_receipt_scope_are_checked() {
    let id = random_id().unwrap();
    assert!(valid_id(&id));
    assert!(!valid_id("artifact-../file"));
    let mut request = OpenArtifactRequest {
        workspace_id: "workspace".into(),
        agent_id: "agent-a".into(),
        artifact_id: id.clone(),
        expected_generation: 1,
    };
    let receipt = ArtifactReceipt {
        artifact: LocalComputerArtifact {
            kind: "computer-artifact".into(),
            version: 1,
            id,
            computer_id: "computer".into(),
            title: "Report".into(),
            mime_type: "text/plain".into(),
            size_bytes: 5,
            relative_path: "report.txt".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
        workspace_id: "workspace".into(),
        agent_id: "agent-a".into(),
        export_name: "mivlet-report.txt".into(),
        sha256: digest(b"first"),
    };
    assert!(validate_receipt(&receipt, &request, "computer").is_ok());
    request.agent_id = "agent-b".into();
    assert!(validate_receipt(&receipt, &request, "computer").is_err());
}
