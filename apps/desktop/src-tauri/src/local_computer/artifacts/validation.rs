//! Passive artifact type and structure validation.

use std::{
    collections::HashSet,
    io::Read,
    panic::{catch_unwind, AssertUnwindSafe},
};

pub(crate) const MAX_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_PUBLICATIONS: usize = 256;
const MAX_OFFICE_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PDF_OBJECTS: usize = 100_000;
const MAX_PDF_PAGES: usize = 10_000;
const MAX_PDF_NODES: usize = 1_000_000;
const MAX_PDF_DEPTH: usize = 64;
const MAX_PDF_DECOMPRESSED_STREAM_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn allowed_path(relative: &str) -> Result<&str, String> {
    if relative.is_empty()
        || relative.len() > 512
        || relative.contains(['\\', ':'])
        || relative.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        || relative.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with([' ', '.'])
                || part.starts_with(' ')
        })
    {
        return Err("Choose a generated file inside the computer's Workspace folder.".into());
    }
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    mime_for(extension)?;
    Ok(extension)
}

pub(crate) fn mime_for(extension: &str) -> Result<&'static str, String> {
    match extension {
        "docx" => Ok("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Ok("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => Ok("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "pdf" => Ok("application/pdf"),
        "json" => Ok("application/json"),
        "csv" => Ok("text/csv"),
        "txt" => Ok("text/plain"),
        "md" => Ok("text/markdown"),
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err(
            "Publish a PDF, DOCX, XLSX, PPTX, CSV, text, Markdown, or raster image file.".into(),
        ),
    }
}

pub(crate) fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

pub(crate) fn check_office_metadata_xml(xml: &[u8], description: &str) -> Result<(), String> {
    if std::str::from_utf8(xml).is_err()
        || contains_ascii_case_insensitive(xml, b"<!")
        || xml.contains(&b'&')
    {
        return Err(format!("The Office {description} metadata is invalid."));
    }
    Ok(())
}

fn check_office_relationships(
    xml: &[u8],
    is_root: bool,
    expected_main_part: &str,
) -> Result<bool, String> {
    use quick_xml::{events::Event, Reader, XmlVersion};

    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut root_main_relationship = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if element.local_name().as_ref() == "Relationship" =>
            {
                let mut target = None;
                let mut target_mode = None;
                let mut relationship_type = None;
                for attribute in element.attributes().with_checks(true) {
                    let attribute =
                        attribute.map_err(|_| "The Office relationship metadata is invalid.")?;
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|_| "The Office relationship metadata is invalid.")?
                        .into_owned();
                    match attribute.key.local_name().as_ref() {
                        "Target" => target = Some(value),
                        "TargetMode" => target_mode = Some(value),
                        "Type" => relationship_type = Some(value),
                        _ => {}
                    }
                }
                if target_mode.is_some() {
                    return Err(
                        "Office documents with external relationships cannot be published.".into(),
                    );
                }
                if let Some(target) = target.as_deref() {
                    let lower = target.to_ascii_lowercase();
                    if lower.starts_with("http:")
                        || lower.starts_with("https:")
                        || lower.starts_with("file:")
                        || lower.starts_with("mailto:")
                        || lower.starts_with("//")
                        || lower.contains('\\')
                    {
                        return Err(
                            "Office documents with external relationships cannot be published."
                                .into(),
                        );
                    }
                }
                root_main_relationship |= is_root
                    && relationship_type
                        .as_deref()
                        .is_some_and(|value| value.ends_with("/officeDocument"))
                    && target.as_deref() == Some(expected_main_part);
            }
            Ok(Event::DocType(_)) => {
                return Err("The Office relationship metadata is invalid.".into())
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err("The Office relationship metadata is invalid.".into()),
        }
    }
    Ok(root_main_relationship)
}

pub(crate) fn check_office(bytes: &[u8], extension: &str) -> Result<bool, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "The document is not a supported Office file.")?;
    if archive.len() > 2000 {
        return Err("The document contains too many archive entries.".into());
    }
    let (main_part, main_content_type) = match extension {
        "docx" => (
            "word/document.xml",
            b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
                .as_slice(),
        ),
        "xlsx" => (
            "xl/workbook.xml",
            b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
                .as_slice(),
        ),
        "pptx" => (
            "ppt/presentation.xml",
            b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
                .as_slice(),
        ),
        _ => return Ok(false),
    };
    let mut expanded_size = 0u64;
    let mut names = HashSet::new();
    let mut content_types = false;
    let mut root_relationships = false;
    let mut main_document = false;
    let mut remaining_xml_nodes = 1_000_000;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "The Office document could not be checked.")?;
        expanded_size = expanded_size.saturating_add(entry.size());
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "The Office document contains an invalid UTF-8 file name.")?
            .to_ascii_lowercase();
        if expanded_size > MAX_OFFICE_EXPANDED_BYTES
            || entry.enclosed_name().is_none()
            || entry.encrypted()
            || name.contains('\\')
            || !names.insert(name.clone())
            || ((!entry.is_dir() || entry.size() != 0)
                && [
                    "vbaproject",
                    "activex/",
                    "embeddings/",
                    "externallinks/",
                    "customui/",
                    "webextensions/",
                    "ctrlprops/",
                    "attachedtoolbars",
                    "macrosheets/",
                ]
                .iter()
                .any(|blocked| name.contains(blocked)))
        {
            return Err(
                "Publish an Office document without macros, embedded programs, or external content."
                    .into(),
            );
        }
        if name == "[content_types].xml" {
            if entry.size() > 128 * 1024 {
                return Err("The Office document metadata is too large.".into());
            }
            let mut xml = Vec::new();
            entry
                .by_ref()
                .take(128 * 1024 + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "The Office document metadata is invalid.")?;
            check_office_metadata_xml(&xml, "document")?;
            if xml.len() > 128 * 1024
                || !contains_ascii_case_insensitive(&xml, main_content_type)
                || [
                    b"macroenabled".as_slice(),
                    b"vba".as_slice(),
                    b"activex".as_slice(),
                    b"oleobject".as_slice(),
                    b"application/vnd.ms-package".as_slice(),
                    b"macrosheet".as_slice(),
                ]
                .iter()
                .any(|blocked| contains_ascii_case_insensitive(&xml, blocked))
            {
                return Err("Macro-enabled or embedded Office content cannot be published.".into());
            }
            content_types = true;
        } else if name.ends_with(".rels") {
            if entry.size() > 1024 * 1024 {
                return Err("The Office relationship metadata is too large.".into());
            }
            let mut xml = Vec::new();
            entry
                .by_ref()
                .take(1024 * 1024 + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "The Office relationship metadata is invalid.")?;
            check_office_metadata_xml(&xml, "relationship")?;
            root_relationships |=
                check_office_relationships(&xml, name == "_rels/.rels", main_part)?;
        } else if name.ends_with(".xml") {
            if entry.size() > 16 * 1024 * 1024 {
                return Err("An Office content part exceeds the passive validation limit.".into());
            }
            let mut xml = Vec::new();
            entry
                .by_ref()
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "The Office content is invalid.")?;
            if xml.len() > 16 * 1024 * 1024 {
                return Err("An Office content part exceeds the passive validation limit.".into());
            }
            super::super::office_passive::check(
                &xml,
                name.starts_with("xl/"),
                &mut remaining_xml_nodes,
            )?;
        } else if !entry.is_dir() {
            // Do not let XML actions evade inspection by using an arbitrary
            // part extension. Accepted non-XML parts must be actual raster data.
            let asset_extension = name
                .rsplit_once('.')
                .map(|(_, extension)| extension)
                .unwrap_or("");
            if !matches!(asset_extension, "png" | "jpg" | "jpeg" | "gif" | "webp")
                || entry.size() > MAX_BYTES
            {
                return Err("This Office file contains unsupported binary or vector parts. Publish a passive copy with XML and raster images.".into());
            }
            let mut raster = Vec::new();
            entry
                .by_ref()
                .take(MAX_BYTES + 1)
                .read_to_end(&mut raster)
                .map_err(|_| "The Office image is invalid.")?;
            if raster.len() as u64 > MAX_BYTES {
                return Err("The Office image is too large.".into());
            }
            check_content(&raster, asset_extension)?;
        }
        main_document |= name == main_part;
    }
    Ok(content_types && root_relationships && main_document)
}

fn unsafe_pdf_name(name: &[u8]) -> bool {
    [
        b"JavaScript".as_slice(),
        b"Action".as_slice(),
        b"Launch".as_slice(),
        b"EmbeddedFile".as_slice(),
        b"Filespec".as_slice(),
        b"RichMedia".as_slice(),
        b"Rendition".as_slice(),
        b"Movie".as_slice(),
        b"Sound".as_slice(),
        b"GoToR".as_slice(),
        b"GoToE".as_slice(),
        b"GoTo".as_slice(),
        b"Thread".as_slice(),
        b"Named".as_slice(),
        b"SetOCGState".as_slice(),
        b"Trans".as_slice(),
        b"GoTo3DView".as_slice(),
        b"Hide".as_slice(),
        b"ResetForm".as_slice(),
        b"URI".as_slice(),
        b"SubmitForm".as_slice(),
        b"ImportData".as_slice(),
        b"Crypt".as_slice(),
        b"PS".as_slice(),
    ]
    .contains(&name)
}

fn unsafe_pdf_key(key: &[u8]) -> bool {
    [
        b"OpenAction".as_slice(),
        b"AA".as_slice(),
        b"JS".as_slice(),
        b"JavaScript".as_slice(),
        b"EmbeddedFiles".as_slice(),
        b"EF".as_slice(),
        b"AF".as_slice(),
        b"Ref".as_slice(),
        b"URL".as_slice(),
        b"XFA".as_slice(),
        b"AcroForm".as_slice(),
        b"Collection".as_slice(),
        b"RichMediaContent".as_slice(),
        b"RichMediaSettings".as_slice(),
    ]
    .contains(&key)
}

fn safe_pdf_destination(object: &lopdf::Object) -> bool {
    let lopdf::Object::Array(items) = object else {
        return false;
    };
    if !matches!(
        items.first(),
        Some(lopdf::Object::Reference(_)) | Some(lopdf::Object::Integer(_))
    ) {
        return false;
    }
    let Some(lopdf::Object::Name(kind)) = items.get(1) else {
        return false;
    };
    let expected_len = match kind.as_slice() {
        b"Fit" | b"FitB" => 2,
        b"FitH" | b"FitV" | b"FitBH" | b"FitBV" => 3,
        b"XYZ" => 5,
        b"FitR" => 6,
        _ => return false,
    };
    items.len() == expected_len
        && items[2..].iter().all(|item| {
            matches!(
                item,
                lopdf::Object::Null | lopdf::Object::Integer(_) | lopdf::Object::Real(_)
            )
        })
}

fn check_pdf_object(object: &lopdf::Object, nodes: &mut usize, depth: usize) -> Result<(), String> {
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_PDF_NODES || depth > MAX_PDF_DEPTH {
        return Err("The PDF contains too many structural elements.".into());
    }
    match object {
        lopdf::Object::Name(name) if unsafe_pdf_name(name) => {
            Err("PDFs with actions, scripts, or embedded content cannot be published.".into())
        }
        lopdf::Object::Array(items) => {
            for item in items {
                check_pdf_object(item, nodes, depth + 1)?;
            }
            Ok(())
        }
        lopdf::Object::Dictionary(dictionary) => {
            for (key, value) in dictionary.iter() {
                if key == b"OpenAction" && safe_pdf_destination(value) {
                    check_pdf_object(value, nodes, depth + 1)?;
                    continue;
                }
                if unsafe_pdf_key(key) {
                    return Err(
                        "PDFs with actions, scripts, forms, or embedded content cannot be published."
                            .into(),
                    );
                }
                check_pdf_object(value, nodes, depth + 1)?;
            }
            Ok(())
        }
        lopdf::Object::Stream(stream) => {
            if stream.dict.has(b"F")
                || stream.dict.has(b"FFilter")
                || stream.dict.has(b"FDecodeParms")
            {
                return Err("PDFs with external streams cannot be published.".into());
            }
            check_pdf_object(
                &lopdf::Object::Dictionary(stream.dict.clone()),
                nodes,
                depth + 1,
            )
        }
        _ => Ok(()),
    }
}

fn check_pdf_document(bytes: &[u8]) -> Result<lopdf::Document, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Artifacts must be at most 25 MB.".into());
    }
    if !bytes.starts_with(b"%PDF-")
        || bytes
            .windows(5)
            .filter(|window| *window == b"%PDF-")
            .count()
            != 1
        || bytes
            .windows(5)
            .filter(|window| *window == b"%%EOF")
            .count()
            != 1
        || bytes
            .windows(5)
            .rposition(|window| window == b"%%EOF")
            .is_none_or(|end| !bytes[end + 5..].iter().all(u8::is_ascii_whitespace))
    {
        return Err("The PDF structure is malformed or ambiguous.".into());
    }
    let document = lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions {
            strict: true,
            max_decompressed_size: Some(MAX_PDF_DECOMPRESSED_STREAM_BYTES),
            ..Default::default()
        },
    )
    .map_err(|_| "The PDF structure is invalid or unsupported.")?;
    if document.is_encrypted() || document.encryption_state.is_some() {
        return Err("Encrypted PDFs cannot be published.".into());
    }
    if document.objects.len() > MAX_PDF_OBJECTS {
        return Err("The PDF contains too many objects.".into());
    }
    let pages = document.get_pages();
    if pages.is_empty() || pages.len() > MAX_PDF_PAGES {
        return Err("Publish a PDF with between 1 and 10,000 pages.".into());
    }
    let mut nodes = 0usize;
    check_pdf_object(
        &lopdf::Object::Dictionary(document.trailer.clone()),
        &mut nodes,
        0,
    )?;
    for object in document.objects.values() {
        check_pdf_object(object, &mut nodes, 0)?;
    }
    Ok(document)
}

pub(crate) fn checked_pdf(bytes: &[u8]) -> Result<lopdf::Document, String> {
    catch_unwind(AssertUnwindSafe(|| check_pdf_document(bytes)))
        .map_err(|_| "The PDF structure could not be checked.".to_string())?
}

fn check_pdf(bytes: &[u8]) -> Result<bool, String> {
    checked_pdf(bytes).map(|_| true)
}

pub(crate) fn check_content(bytes: &[u8], extension: &str) -> Result<(), String> {
    mime_for(extension)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Artifacts must be at most 25 MB.".into());
    }
    let valid = match extension {
        "txt" | "md" | "csv" => !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok(),
        "json" => serde_json::from_slice::<serde_json::Value>(bytes).is_ok(),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "docx" | "xlsx" | "pptx" => check_office(bytes, extension)?,
        "pdf" => check_pdf(bytes)?,
        _ => false,
    };
    if !valid {
        return Err("The file contents do not match a supported artifact type.".into());
    }
    Ok(())
}
