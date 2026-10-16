//! Bounded, lossless edits for Office packages.
//!
//! The editor deliberately works on the original package bytes. It only
//! changes one existing plain paragraph text node or one existing worksheet
//! value node and copies every other ZIP entry byte-for-byte. Formula cells,
//! fields and array/shared formulas are rejected because a
//! cached preview cannot safely author those structures.

use std::io::{Cursor, Read, Write};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_REPLACEMENT: usize = 32_000;
const MAX_ENTRIES: usize = 2_000;
const MAX_ENTRY_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeEditKind {
    DocxParagraph,
    XlsxCell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficeEdit {
    pub kind: OfficeEditKind,
    pub entry: String,
    pub selector: String,
    pub replacement: String,
}

fn reject_replacement(value: &str) -> Result<(), String> {
    if value.len() > MAX_REPLACEMENT {
        return Err("The Office edit is too large.".into());
    }
    // Office XML is XML 1.0. Keep replacement bytes valid for every supported
    // text node, including an intentionally empty value, before escaping it.
    if value.chars().any(|ch| {
        !matches!(
            ch,
            '\u{9}'
                | '\u{A}'
                | '\u{D}'
                | '\u{20}'..='\u{D7FF}'
                | '\u{E000}'..='\u{FFFD}'
                | '\u{10000}'..='\u{10FFFF}'
        )
    }) {
        return Err("The Office edit contains an invalid character.".into());
    }
    Ok(())
}

fn reject_entry(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.contains(['\\', ':'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("The Office entry target is invalid.".into());
    }
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn replace_one_text_node(
    xml: &str,
    tag: &str,
    selector: &str,
    replacement: &str,
) -> Result<String, String> {
    let start = xml
        .match_indices(selector)
        .find_map(|(offset, _)| is_tag_start(xml, offset, selector).then_some(offset))
        .ok_or_else(|| "The requested Office target was not found.".to_string())?;
    let value_start = xml[start..]
        .find('>')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| "The Office target is malformed.".to_string())?;
    let value_end = xml[value_start..]
        .find(&format!("</{tag}>"))
        .map(|offset| value_start + offset)
        .ok_or_else(|| "The Office target is malformed.".to_string())?;
    let mut result = String::with_capacity(xml.len() + replacement.len());
    result.push_str(&xml[..value_start]);
    result.push_str(&xml_escape(replacement));
    result.push_str(&xml[value_end..]);
    Ok(result)
}

fn is_tag_start(xml: &str, offset: usize, name: &str) -> bool {
    let Some(rest) = xml.get(offset..) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix(name) else {
        return false;
    };
    matches!(
        rest.as_bytes().first(),
        Some(b'>' | b'/' | b' ' | b'\t' | b'\r' | b'\n')
    )
}

/// Locate direct body paragraphs using XML depth while retaining original bytes.
/// Nested tables, content controls and paragraph properties must not alter the
/// preview's paragraph numbering.
fn body_paragraph_span(xml: &str, wanted: usize) -> Result<(usize, usize), String> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut body_depth = None;
    let mut paragraph = 0usize;
    let mut selected = None;
    loop {
        let start = reader.buffer_position() as usize;
        match reader
            .read_event()
            .map_err(|_| "The Office XML is malformed.".to_string())?
        {
            Event::Start(node) => {
                if body_depth == Some(depth) && node.local_name().as_ref() == "p" {
                    if paragraph == wanted {
                        selected = Some((start, depth + 1));
                    }
                    paragraph += 1;
                }
                depth += 1;
                if node.local_name().as_ref() == "body" && body_depth.is_none() {
                    body_depth = Some(depth);
                }
            }
            Event::Empty(node)
                if body_depth == Some(depth) && node.local_name().as_ref() == "p" =>
            {
                if paragraph == wanted {
                    return Err("The empty paragraph has no editable text run.".into());
                }
                paragraph += 1;
            }
            Event::End(_) => {
                if let Some((start, selected_depth)) = selected {
                    if depth == selected_depth {
                        return Ok((start, reader.buffer_position() as usize));
                    }
                }
                if body_depth == Some(depth) {
                    break;
                }
                depth = depth.saturating_sub(1);
            }
            Event::DocType(_) => return Err("Office XML document types are unsupported.".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    Err("The requested paragraph was not found.".into())
}

fn edit_docx(xml: &str, paragraph: usize, replacement: &str) -> Result<String, String> {
    let (start, end) = body_paragraph_span(xml, paragraph)?;
    let block = &xml[start..end];
    if block.contains("<w:fld") || block.contains("<w:instrText") || block.contains("<w:hyperlink")
    {
        return Err(
            "This paragraph contains fields or links that Mivlet cannot safely edit inline.".into(),
        );
    }
    if block
        .match_indices("<w:t")
        .filter(|(offset, _)| is_tag_start(block, *offset, "<w:t"))
        .count()
        != 1
    {
        return Err("Only plain single-run paragraphs are supported for inline editing.".into());
    }
    let edited = replace_one_text_node(block, "w:t", "<w:t", replacement)?;
    Ok(format!("{}{}{}", &xml[..start], edited, &xml[end..]))
}

fn edit_xlsx(xml: &str, cell: &str, replacement: &str) -> Result<String, String> {
    let selector = format!("r=\"{cell}\"");
    let start = xml
        .find(&selector)
        .ok_or_else(|| "The requested spreadsheet cell was not found.".to_string())?;
    let cell_start = xml[..start]
        .rfind("<c ")
        .ok_or_else(|| "The spreadsheet cell is malformed.".to_string())?;
    let cell_end = xml[start..]
        .find("</c>")
        .map(|offset| start + offset + 4)
        .ok_or_else(|| "The spreadsheet cell is malformed.".to_string())?;
    let block = &xml[cell_start..cell_end];
    if block.contains("<f") {
        return Err("Formula spreadsheet cells are read-only; formulas and their cached results are preserved.".into());
    }
    if block.contains("t=\"s\"") || block.contains("t='s'") {
        let value_start = block
            .find("<v>")
            .map(|offset| offset + 3)
            .ok_or_else(|| "The shared spreadsheet cell is malformed.".to_string())?;
        let value_end = block[value_start..]
            .find("</v>")
            .map(|offset| value_start + offset)
            .ok_or_else(|| "The shared spreadsheet cell is malformed.".to_string())?;
        if block[value_start..value_end].parse::<usize>().is_err() {
            return Err("The shared spreadsheet cell index is invalid.".into());
        }
        let opening_end = block
            .find('>')
            .ok_or_else(|| "The spreadsheet cell is malformed.".to_string())?
            + 1;
        let mut opening = block[..opening_end].to_string();
        opening = opening
            .replace("t=\"s\"", "t=\"inlineStr\"")
            .replace("t='s'", "t=\"inlineStr\"");
        let mut edited = String::with_capacity(block.len() + replacement.len() + 24);
        edited.push_str(&opening);
        edited.push_str(&block[opening_end..value_start - 3]);
        edited.push_str("<is><t>");
        edited.push_str(&xml_escape(replacement));
        edited.push_str("</t></is>");
        edited.push_str(&block[value_end + 4..]);
        return Ok(format!(
            "{}{}{}",
            &xml[..cell_start],
            edited,
            &xml[cell_end..]
        ));
    }
    if block.contains("t=\"str\"") || block.contains("t='str'") {
        return Err("Formula string spreadsheet cells are read-only.".into());
    }
    if block.contains("t=\"inlineStr\"") || block.contains("t='inlineStr'") {
        if block.contains("<r")
            || block
                .match_indices("<t")
                .filter(|(offset, _)| is_tag_start(block, *offset, "<t"))
                .count()
                != 1
        {
            return Err("Only plain inline spreadsheet strings can be edited safely.".into());
        }
        let edited = replace_one_text_node(block, "t", "<t", replacement)?;
        return Ok(format!(
            "{}{}{}",
            &xml[..cell_start],
            edited,
            &xml[cell_end..]
        ));
    }
    if !block.contains("<v>") {
        return Err("The selected spreadsheet cell has no editable value.".into());
    }
    if block.contains("t=\"b\"") || block.contains("t='b'") {
        if !matches!(replacement, "0" | "1") {
            return Err("Boolean spreadsheet cells accept only 0 or 1.".into());
        }
    } else {
        if block.contains("t=") && !block.contains("t=\"n\"") && !block.contains("t='n'") {
            return Err("Only numeric or boolean spreadsheet cells can be edited safely.".into());
        }
        if !replacement
            .parse::<f64>()
            .map(|value| value.is_finite())
            .unwrap_or(false)
        {
            return Err("Numeric spreadsheet cells accept only finite numbers.".into());
        }
    }
    // The selector located the containing cell; replace only its value node so
    // style/type attributes and sibling formula cells remain byte-for-byte
    // equivalent in the unpacked OOXML.
    let edited = replace_one_text_node(block, "v", "<v", replacement)?;
    Ok(format!(
        "{}{}{}",
        &xml[..cell_start],
        edited,
        &xml[cell_end..]
    ))
}

pub fn edit_package(bytes: &[u8], edit: &OfficeEdit) -> Result<Vec<u8>, String> {
    reject_replacement(&edit.replacement)?;
    reject_entry(&edit.entry)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The Office package could not be opened.".to_string())?;
    if archive.len() > MAX_ENTRIES {
        return Err("This Office package contains too many entries to edit safely.".into());
    }
    let mut entries = Vec::with_capacity(archive.len());
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| "The Office package contains an invalid entry.".to_string())?;
        let name = file.name().to_string();
        if file.encrypted()
            || file.enclosed_name().is_none()
            || name.contains('\\')
            || name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || file.size() > MAX_ENTRY_BYTES
        {
            return Err("This Office package contains an unsafe or oversized entry.".into());
        }
        expanded = expanded.saturating_add(file.size());
        if expanded > MAX_EXPANDED_BYTES {
            return Err("This Office package expands beyond the safe editing limit.".into());
        }
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|_| "The Office package entry could not be read.".to_string())?;
        entries.push((name, content));
    }
    let mut found = false;
    for (name, content) in &mut entries {
        if name != &edit.entry {
            continue;
        }
        let source = String::from_utf8(content.clone())
            .map_err(|_| "The Office XML entry is not UTF-8.".to_string())?;
        let updated = match edit.kind {
            OfficeEditKind::DocxParagraph => edit_docx(
                &source,
                edit.selector
                    .parse()
                    .map_err(|_| "The paragraph selector is invalid.".to_string())?,
                &edit.replacement,
            )?,
            OfficeEditKind::XlsxCell => edit_xlsx(&source, &edit.selector, &edit.replacement)?,
        };
        *content = updated.into_bytes();
        found = true;
    }
    if !found {
        return Err("The requested Office XML entry was not found.".into());
    }
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in entries {
            writer
                .start_file(name, options)
                .map_err(|_| "The edited Office package could not be written.".to_string())?;
            writer
                .write_all(&content)
                .map_err(|_| "The edited Office package could not be written.".to_string())?;
        }
        writer
            .finish()
            .map_err(|_| "The edited Office package could not be finalized.".to_string())?;
    }
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(entry: &str, xml: &str) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(&mut output);
        writer
            .start_file(entry, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        writer
            .start_file("keep.bin", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"untouched").unwrap();
        writer.finish().unwrap();
        output.into_inner()
    }

    #[test]
    fn edits_plain_docx_paragraph_and_preserves_other_entries() {
        let bytes = package(
            "word/document.xml",
            "<w:document><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:body></w:document>",
        );
        let result = edit_package(
            &bytes,
            &OfficeEdit {
                kind: OfficeEditKind::DocxParagraph,
                entry: "word/document.xml".into(),
                selector: "0".into(),
                replacement: "New & safe".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(result)).unwrap();
        let mut document = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert!(document.contains("New &amp; safe"));
        let mut keep = String::new();
        archive
            .by_name("keep.bin")
            .unwrap()
            .read_to_string(&mut keep)
            .unwrap();
        assert_eq!(keep, "untouched");
    }

    #[test]
    fn permits_empty_text_values_but_rejects_xml_control_characters() {
        let bytes = package(
            "word/document.xml",
            "<w:document><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:body></w:document>",
        );
        let empty = edit_package(
            &bytes,
            &OfficeEdit {
                kind: OfficeEditKind::DocxParagraph,
                entry: "word/document.xml".into(),
                selector: "0".into(),
                replacement: String::new(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(empty)).unwrap();
        let mut document = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert!(document.contains("<w:t></w:t>"));

        let error = edit_package(
            &bytes,
            &OfficeEdit {
                kind: OfficeEditKind::DocxParagraph,
                entry: "word/document.xml".into(),
                selector: "0".into(),
                replacement: "bad\u{1}".into(),
            },
        )
        .unwrap_err();
        assert!(error.contains("invalid character"));
    }

    #[test]
    fn rejects_formula_cells() {
        let bytes = package("xl/worksheets/sheet1.xml", "<worksheet><sheetData><c r=\"A1\"><f>SUM(A2:A3)</f><v>2</v></c></sheetData></worksheet>");
        let error = edit_package(
            &bytes,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "3".into(),
            },
        )
        .unwrap_err();
        assert!(error.contains("formulas"));
    }

    #[test]
    fn preserves_unrelated_docx_fields_and_xlsx_formulas() {
        let docx = package(
            "word/document.xml",
            "<w:document><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:p><w:fldSimple><w:r><w:t>KEEP</w:t></w:r></w:fldSimple></w:p></w:body></w:document>",
        );
        let edited = edit_package(
            &docx,
            &OfficeEdit {
                kind: OfficeEditKind::DocxParagraph,
                entry: "word/document.xml".into(),
                selector: "0".into(),
                replacement: "New".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(edited)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<w:fldSimple>"));
        assert!(xml.contains("New"));

        let xlsx = package(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData><c r=\"A1\"><v>1</v></c><c r=\"B1\"><f>SUM(A1)</f><v>1</v></c></sheetData></worksheet>",
        );
        let edited = edit_package(
            &xlsx,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "2".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(edited)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<f>SUM(A1)</f>"));
        assert!(xml.contains("<c r=\"A1\"><v>2</v>"));
        assert!(xml.contains("<c r=\"B1\"><f>SUM(A1)</f><v>1</v>"));
    }

    #[test]
    fn docx_selector_counts_only_plain_body_paragraphs() {
        let docx = package(
            "word/document.xml",
            "<w:document><w:body><w:p><w:pPr/><w:r><w:t>First</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>",
        );
        let edited = edit_package(
            &docx,
            &OfficeEdit {
                kind: OfficeEditKind::DocxParagraph,
                entry: "word/document.xml".into(),
                selector: "1".into(),
                replacement: "Updated".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(edited)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<w:t>Table</w:t>"));
        assert!(xml.contains("<w:t>Updated</w:t>"));
    }

    #[test]
    fn rejects_rich_inline_strings_and_non_finite_numbers() {
        let inline = package(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData><c r=\"A1\" t=\"inlineStr\"><is><r><t>Old</t></r></is></c></sheetData></worksheet>",
        );
        let error = edit_package(
            &inline,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "New".into(),
            },
        )
        .unwrap_err();
        assert!(error.contains("plain inline"));

        let numeric = package(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData><c r=\"A1\"><v>1</v></c></sheetData></worksheet>",
        );
        let error = edit_package(
            &numeric,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "NaN".into(),
            },
        )
        .unwrap_err();
        assert!(error.contains("finite numbers"));
    }

    #[test]
    fn edits_plain_inline_and_shared_strings_without_mutating_shared_table() {
        let inline = package(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData><c r=\"A1\" t=\"inlineStr\"><is><t>Old</t></is></c></sheetData></worksheet>",
        );
        let edited = edit_package(
            &inline,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "New & safe".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(edited)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("t=\"inlineStr\"><is><t>New &amp; safe</t>"));

        let shared = package(
            "xl/worksheets/sheet1.xml",
            "<worksheet><sheetData><c r=\"A1\" s=\"2\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>0</v></c></sheetData></worksheet>",
        );
        let edited = edit_package(
            &shared,
            &OfficeEdit {
                kind: OfficeEditKind::XlsxCell,
                entry: "xl/worksheets/sheet1.xml".into(),
                selector: "A1".into(),
                replacement: "Only A1".into(),
            },
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(edited)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("r=\"A1\" s=\"2\" t=\"inlineStr\"><is><t>Only A1</t>"));
        assert!(xml.contains("r=\"B1\" t=\"s\"><v>0</v>"));
    }
}
