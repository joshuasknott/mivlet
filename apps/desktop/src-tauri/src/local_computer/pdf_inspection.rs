//! Passive PDF reading in native custody. No scripts, links or form actions run.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PdfText {
    page_count: usize,
    pages: Vec<PdfPageText>,
    truncated: bool,
    extraction_incomplete: bool,
}
#[derive(Serialize)]
pub(super) struct PdfPageText {
    page: u32,
    text: String,
}

pub(super) fn project(bytes: &[u8]) -> Result<PdfText, String> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Choose a passive PDF up to 8 MB for inspection.".into());
    }
    let document = super::artifacts::checked_pdf(bytes)?;
    let pages = document.get_pages();
    let mut result = PdfText {
        page_count: pages.len(),
        pages: Vec::new(),
        truncated: pages.len() > 50,
        extraction_incomplete: false,
    };
    let mut remaining = 128 * 1024;
    for page in pages.keys().take(50) {
        let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            document.extract_text(&[*page])
        }));
        let mut text = match extracted {
            Ok(Ok(text)) => text,
            _ => {
                result.extraction_incomplete = true;
                String::new()
            }
        };
        if text.trim().is_empty() {
            result.extraction_incomplete = true;
        }
        if text.len() > remaining {
            let mut end = remaining;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            result.truncated = true;
        }
        remaining -= text.len();
        result.pages.push(PdfPageText { page: *page, text });
        if remaining == 0 {
            result.truncated = true;
            break;
        }
    }
    Ok(result)
}

pub(crate) fn inspect(bytes: &[u8]) -> Result<String, String> {
    let content = project(bytes)?;
    serde_json::to_string(&serde_json::json!({
        "format":"pdf", "trust":"untrusted", "instructionAuthority":"none",
        "truncated":content.truncated, "extractionIncomplete":content.extraction_incomplete,
        "content":content,
        "notice":"Text extraction only: at most 50 pages and 128 KB. Reading order may differ from the page layout. Images, scanned pages and unsupported font encodings need visual inspection; no OCR runs. Empty or incomplete extraction does not prove that a page is blank. Open the PDF page preview before claiming complete analysis. No scripts, forms or external links execute."
    })).map_err(|_| "Mivlet could not encode the PDF content.".into())
}

#[cfg(test)]
pub(super) fn test_pdf(text: &str, page_count: usize) -> Vec<u8> {
    use lopdf::{
        content::{Content, Operation},
        dictionary, Object, Stream,
    };
    let mut doc = lopdf::Document::with_version("1.7");
    let pages = doc.new_object_id();
    let font = doc.add_object(dictionary! { "Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica", "Encoding"=>"WinAnsiEncoding" });
    let mut children = Vec::new();
    for _ in 0..page_count {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![40.into(), 740.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        }
        .encode()
        .unwrap();
        let content = doc.add_object(Stream::new(dictionary! {}, content));
        children.push(
            doc.add_object(dictionary! { "Type"=>"Page", "Parent"=>pages,
                "MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()],
                "Resources"=>dictionary! {"Font"=>dictionary! {"F1"=>font}}, "Contents"=>content,
            })
            .into(),
        );
    }
    doc.objects.insert(
        pages,
        dictionary! {"Type"=>"Pages", "Kids"=>children,"Count"=>page_count as i64}.into(),
    );
    let catalog = doc.add_object(dictionary! { "Type"=>"Catalog", "Pages"=>pages });
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_real_page_text_as_bounded_untrusted_evidence() {
        let result: serde_json::Value =
            serde_json::from_str(&inspect(&test_pdf("Quarterly totals: 731", 2)).unwrap()).unwrap();
        assert_eq!(result["trust"], "untrusted");
        assert_eq!(result["instructionAuthority"], "none");
        assert_eq!(result["content"]["pageCount"], 2);
        assert_eq!(result["content"]["pages"][1]["page"], 2);
        assert!(result["content"]["pages"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Quarterly totals: 731"));
        assert_eq!(result["extractionIncomplete"], false);
    }
    #[test]
    fn limits_pages_and_text_and_discloses_missing_extraction() {
        let pages = project(&test_pdf("Page data", 51)).unwrap();
        assert_eq!(pages.pages.len(), 50);
        assert_eq!(pages.page_count, 51);
        assert!(pages.truncated);
        let large = project(&test_pdf(&"A".repeat(128 * 1024), 2)).unwrap();
        assert!(large.truncated);
        assert!(
            large
                .pages
                .iter()
                .map(|page| page.text.len())
                .sum::<usize>()
                <= 128 * 1024
        );
        assert!(project(&test_pdf("", 1)).unwrap().extraction_incomplete);
        assert!(inspect(b"%PDF-1.7 invalid").is_err());
        assert!(project(&vec![0; 8 * 1024 * 1024 + 1]).is_err());
    }
}
