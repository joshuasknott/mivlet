//! Bounded content projections of already receipt-verified passive Office files.
//! No HTML, scripts, external relationships or embedded media enter the UI.
use quick_xml::{events::Event, Reader, XmlVersion};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Cursor, Read},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OfficePreview {
    kind: &'static str,
    sections: Vec<Section>,
}

#[derive(Serialize)]
pub(super) struct Section {
    name: String,
    blocks: Vec<Block>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Block {
    Paragraph { text: String, style: &'static str },
    Table { rows: Vec<Vec<String>> },
}

#[derive(Default)]
struct Node {
    name: String,
    attributes: HashMap<String, String>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn attribute(&self, key: &str) -> &str {
        self.attributes.get(key).map(String::as_str).unwrap_or("")
    }
    fn descendants<'a>(&'a self, name: &str, output: &mut Vec<&'a Node>) {
        if self.name == name {
            output.push(self);
        }
        for child in &self.children {
            child.descendants(name, output);
        }
    }
    fn find(&self, name: &str) -> Vec<&Node> {
        let mut nodes = Vec::new();
        self.descendants(name, &mut nodes);
        nodes
    }
    fn value(&self) -> String {
        let mut value = self.text.clone();
        for child in &self.children {
            value.push_str(&child.value());
        }
        value
    }
}

fn tree(xml: &[u8]) -> Option<Node> {
    let mut reader = Reader::from_reader(xml);
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        let event = reader.read_event().ok()?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                count += 1;
                if count > 50_000 || stack.len() > 64 {
                    return None;
                }
                let mut node = Node {
                    name: element.local_name().as_ref().to_string(),
                    ..Node::default()
                };
                for attribute in element.attributes().with_checks(true) {
                    let attribute = attribute.ok()?;
                    let key = attribute.key.local_name().as_ref().to_string();
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .ok()?
                        .into_owned();
                    node.attributes.insert(key, value);
                }
                if empty {
                    stack.last_mut()?.children.push(node);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return None;
                }
                let node = stack.pop()?;
                stack.last_mut()?.children.push(node);
            }
            Event::Text(text) => stack
                .last_mut()?
                .text
                .push_str(&text.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(text) => stack
                .last_mut()?
                .text
                .push_str(&text.xml_content(XmlVersion::Implicit1_0)),
            Event::GeneralRef(reference) => {
                if let Some(character) = reference.resolve_char_ref().ok()? {
                    stack.last_mut()?.text.push(character);
                } else {
                    let decoded = quick_xml::escape::unescape(&format!(
                        "&{};",
                        reference.xml_content(XmlVersion::Implicit1_0)
                    ))
                    .ok()?
                    .into_owned();
                    stack.last_mut()?.text.push_str(&decoded);
                }
            }
            Event::DocType(_) => return None,
            Event::Eof => return (stack.len() == 1).then(|| stack.remove(0)),
            _ => {}
        }
    }
}

fn part(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, path: &str) -> Option<Node> {
    let mut entry = archive.by_name(path).ok()?;
    if entry.size() > 4 * 1024 * 1024 {
        return None;
    }
    let mut xml = Vec::new();
    entry
        .by_ref()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut xml)
        .ok()?;
    if xml.len() > 4 * 1024 * 1024 {
        return None;
    }
    tree(&xml)
}

#[derive(Default)]
struct Budget {
    remaining: usize,
    truncated: bool,
}
impl Budget {
    fn text(&mut self, value: &str) -> String {
        let mut end = value.len().min(self.remaining).min(8_000);
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        self.truncated |= end < value.len();
        self.remaining -= end;
        value[..end].to_string()
    }
}

fn paragraph(node: &Node, budget: &mut Budget) -> Block {
    let text = paragraph_text(node);
    let text = if node.find("buChar").is_empty() {
        text
    } else {
        format!("• {text}")
    };
    let style = node
        .find("pStyle")
        .first()
        .map(|node| node.attribute("val"))
        .unwrap_or("");
    let style = if style == "Title" {
        "title"
    } else if style.starts_with("Heading") {
        "heading"
    } else {
        "paragraph"
    };
    Block::Paragraph {
        text: budget.text(&text),
        style,
    }
}

fn paragraph_text(node: &Node) -> String {
    match node.name.as_str() {
        "t" => node.value(),
        "br" | "cr" => "\n".into(),
        "tab" => "\t".into(),
        _ => node.children.iter().map(paragraph_text).collect(),
    }
}

fn document(root: &Node, budget: &mut Budget) -> Option<Vec<Section>> {
    let bodies = root.find("body");
    let body = bodies.first()?;
    let mut blocks = Vec::new();
    for node in body.children.iter().take(500) {
        if budget.remaining == 0 {
            budget.truncated = true;
            break;
        }
        match node.name.as_str() {
            "p" => blocks.push(paragraph(node, budget)),
            "tbl" => {
                let mut rows = Vec::new();
                let source_rows = node.find("tr");
                budget.truncated |= source_rows.len() > 100;
                for row in source_rows.iter().take(100) {
                    let cells = row.find("tc");
                    budget.truncated |= cells.len() > 26;
                    rows.push(
                        cells
                            .iter()
                            .take(26)
                            .map(|cell| {
                                budget.text(
                                    &cell
                                        .find("p")
                                        .iter()
                                        .map(|p| {
                                            p.find("t")
                                                .iter()
                                                .map(|t| t.value())
                                                .collect::<String>()
                                        })
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                )
                            })
                            .collect(),
                    );
                }
                blocks.push(Block::Table { rows });
            }
            _ => {
                budget.truncated |= !node.find("t").is_empty();
            }
        }
    }
    budget.truncated |= body.children.len() > 500;
    Some(vec![Section {
        name: "Document".into(),
        blocks,
    }])
}

fn relationships(root: &Node, base: &str) -> HashMap<String, String> {
    root.find("Relationship")
        .iter()
        .filter_map(|node| {
            if !node.attribute("TargetMode").is_empty() {
                return None;
            }
            let target = node.attribute("Target");
            let mut parts = if target.starts_with('/') {
                Vec::new()
            } else {
                vec![base]
            };
            for segment in target.trim_start_matches('/').split('/') {
                match segment {
                    ".." => {
                        parts.pop()?;
                    }
                    "." => {}
                    "" => return None,
                    value => parts.push(value),
                }
            }
            let path = parts.join("/");
            (!path.contains([':', '\\']) && path.ends_with(".xml"))
                .then(|| (node.attribute("Id").into(), path))
        })
        .collect()
}

fn coordinates(reference: &str) -> Option<(usize, usize)> {
    let split = reference.find(|c: char| c.is_ascii_digit())?;
    let mut column = 0usize;
    for byte in reference[..split].bytes() {
        if !byte.is_ascii_uppercase() {
            return None;
        }
        column = column
            .checked_mul(26)?
            .checked_add((byte - b'A' + 1) as usize)?;
    }
    let row = reference[split..].parse::<usize>().ok()?;
    Some((row.checked_sub(1)?, column.checked_sub(1)?))
}

fn workbook(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    budget: &mut Budget,
) -> Option<Vec<Section>> {
    let book = part(archive, "xl/workbook.xml")?;
    let rels = relationships(&part(archive, "xl/_rels/workbook.xml.rels")?, "xl");
    let strings = if let Some(root) = part(archive, "xl/sharedStrings.xml") {
        let source = root.find("si");
        if source.len() > 100_000 {
            return None;
        }
        source
            .iter()
            .map(|si| si.find("t").iter().map(|t| t.value()).collect::<String>())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let sheets = book.find("sheet");
    budget.truncated |= sheets.len() > 8;
    let mut sections = Vec::new();
    for sheet in sheets.iter().take(8) {
        let root = part(archive, rels.get(sheet.attribute("id"))?)?;
        let mut rows: Vec<Vec<String>> = Vec::new();
        for cell in root.find("c") {
            let (row, column) = coordinates(cell.attribute("r"))?;
            if row >= 100 || column >= 26 {
                budget.truncated = true;
                continue;
            }
            let cached = cell
                .find("v")
                .first()
                .map(|v| v.value())
                .unwrap_or_default();
            let value = match cell.attribute("t") {
                "s" => strings.get(cached.parse::<usize>().ok()?)?.clone(),
                "inlineStr" => cell.find("t").iter().map(|t| t.value()).collect(),
                "b" => {
                    if cached == "1" {
                        "TRUE".into()
                    } else {
                        "FALSE".into()
                    }
                }
                _ => cached,
            };
            if budget.remaining == 0 {
                budget.truncated = true;
                break;
            }
            rows.resize_with(rows.len().max(row + 1), Vec::new);
            let width = rows[row].len().max(column + 1);
            rows[row].resize(width, String::new());
            rows[row][column] = budget.text(&value);
        }
        sections.push(Section {
            name: budget.text(sheet.attribute("name")),
            blocks: vec![Block::Table { rows }],
        });
    }
    Some(sections)
}

fn presentation(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    budget: &mut Budget,
) -> Option<Vec<Section>> {
    let presentation = part(archive, "ppt/presentation.xml")?;
    let rels = relationships(&part(archive, "ppt/_rels/presentation.xml.rels")?, "ppt");
    let slides = presentation.find("sldId");
    budget.truncated |= slides.len() > 30;
    let mut sections = Vec::new();
    for (index, slide) in slides.iter().take(30).enumerate() {
        let root = part(archive, rels.get(slide.attribute("id"))?)?;
        let source = root.find("p");
        budget.truncated |= source.len() > 100;
        let blocks = source
            .iter()
            .take(100)
            .enumerate()
            .map(|(index, p)| {
                let mut block = paragraph(p, budget);
                if index == 0 {
                    let Block::Paragraph { style, .. } = &mut block else {
                        unreachable!()
                    };
                    *style = "title";
                }
                block
            })
            .collect();
        sections.push(Section {
            name: format!("Slide {}", index + 1),
            blocks,
        });
    }
    Some(sections)
}

/// Failure leaves the existing external-open fallback intact. This content
/// preview deliberately does not claim to reproduce Office pagination/styles.
pub(super) fn preview(bytes: &[u8], extension: &str) -> Option<(OfficePreview, bool)> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut budget = Budget {
        remaining: 128 * 1024,
        truncated: false,
    };
    let (kind, sections) = match extension {
        "docx" => (
            "document",
            document(&part(&mut archive, "word/document.xml")?, &mut budget)?,
        ),
        "xlsx" => ("spreadsheet", workbook(&mut archive, &mut budget)?),
        "pptx" => ("presentation", presentation(&mut archive, &mut budget)?),
        _ => return None,
    };
    Some((OfficePreview { kind, sections }, budget.truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_entities_and_rejects_dtd_deep_or_invalid_xml() {
        assert_eq!(
            tree(b"<t>A &amp; B &#x1f600;</t>").unwrap().find("t")[0].value(),
            "A & B 😀"
        );
        assert!(tree(b"<!DOCTYPE t SYSTEM 'file:///secret'><t/>").is_none());
        assert!(tree(format!("{}{}", "<t>".repeat(70), "</t>".repeat(70)).as_bytes()).is_none());
        assert!(tree(b"<t></other>").is_none());
    }
    #[test]
    fn retains_sheet_positions_and_cached_formulas_with_a_bounded_grid() {
        let files = vec![
            ("xl/workbook.xml".into(), "<workbook><sheets><sheet name=\"Totals\" xmlns:r=\"r\" r:id=\"rId2\"/></sheets></workbook>".into()),
            ("xl/_rels/workbook.xml.rels".into(), "<Relationships><Relationship Id=\"rId2\" Target=\"worksheets/sheet7.xml\"/></Relationships>".into()),
            ("xl/worksheets/sheet7.xml".into(), "<worksheet><sheetData><row><c r=\"C2\"><f>SUM(A1:B1)</f><v>26</v></c><c r=\"AA1\"><v>hidden</v></c></row></sheetData></worksheet>".into()),
        ];
        let bytes = super::super::office_authoring::zip_files(files).unwrap();
        let (preview, truncated) = preview(&bytes, "xlsx").unwrap();
        let value = serde_json::to_value(preview).unwrap();
        assert_eq!(value["sections"][0]["name"], "Totals");
        assert_eq!(value["sections"][0]["blocks"][0]["rows"][1][2], "26");
        assert_eq!(value["sections"][0]["blocks"][0]["rows"][1][0], "");
        assert!(truncated);
    }
    #[test]
    fn retains_document_block_order_and_bounded_tables() {
        let root = tree(b"<document><body><p><pPr><pStyle val=\"Title\"/></pPr><r><t>Title</t></r></p><tbl><tr><tc><p><r><t>&lt;script/&gt;</t></r></p></tc></tr></tbl><p><r><t>After</t></r></p></body></document>").unwrap();
        let value = serde_json::to_value(
            document(
                &root,
                &mut Budget {
                    remaining: 30,
                    truncated: false,
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value[0]["blocks"][0]["style"], "title");
        assert_eq!(value[0]["blocks"][1]["rows"][0][0], "<script/>");
        assert_eq!(value[0]["blocks"][2]["text"], "After");
    }
}
