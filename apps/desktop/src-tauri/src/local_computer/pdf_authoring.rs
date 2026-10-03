//! Passive, bounded report layout. All operations and fonts are Mivlet-owned.
use super::pdf_font::{wrap, Font};
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream,
};
use serde::Deserialize;
use serde_json::Value;

const WIDTH: f32 = 595.0;
const HEIGHT: f32 = 842.0;
const MARGIN: f32 = 44.0;
const BOTTOM: f32 = 56.0;
const BODY: f32 = HEIGHT - MARGIN - BOTTOM;
const INK: [f32; 3] = [0.12, 0.15, 0.16];
const ACCENT: [f32; 3] = [0.25, 0.40, 0.35];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    path: String,
    title: String,
    subtitle: Option<String>,
    blocks: Vec<Block>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> Value {
        json!({"path":"reports/operations.pdf","title":"Quarterly operations report","subtitle":"Q3 results and delivery plan",
        "blocks":[
            {"type":"heading","text":"Summary","level":1},
            {"type":"paragraph","text":"Revenue increased 18%. Crème brûlée costs £26; Δοκιμή and Итог remain selectable text."},
            {"type":"table","rows":[["Metric","Result"],["Revenue","£73,100"],["Delivery","On schedule"]]},
            {"type":"bar-chart","title":"Monthly revenue","unit":"GBP thousands","labels":["July","August","September"],"values":[42,58,73]},
            {"type":"bar-chart","title":"Change against plan","unit":"percent","labels":["Alpha","Beta","Gamma"],"values":[-8,0,12]},
            {"type":"page-break"},{"type":"heading","text":"Delivery plan","level":1},
            {"type":"bullet","text":"Complete onboarding review by 12 October."},
            {"type":"bullet","text":"Publish the customer guide and run acceptance checks."}
        ]})
    }

    #[test]
    fn pdf_report_is_passive_with_embedded_unicode_and_vector_charts() {
        let (path, bytes) = create(&report()).unwrap();
        assert_eq!(path, "reports/operations.pdf");
        let document = super::super::artifacts::checked_pdf(&bytes).unwrap();
        assert_eq!(document.get_pages().len(), 2);
        let text = document.extract_text(&[1, 2]).unwrap();
        for expected in [
            "Crème brûlée",
            "£26",
            "Δοκιμή",
            "Итог",
            "Delivery plan",
            "Page 2 of 2",
            "September",
            "73",
        ] {
            assert!(text.contains(expected), "Missing {expected}: {text}");
        }
        let page = document.get_pages()[&1];
        let content = Content::decode(&document.get_page_content(page)).unwrap();
        assert!(
            content
                .operations
                .iter()
                .filter(|op| op.operator == "re")
                .count()
                >= 7
        );
        assert!(document.objects.values().any(|object| object
            .as_dict()
            .is_ok_and(|dictionary| dictionary.has(b"FontFile2"))));
    }

    #[test]
    fn tables_repeat_headers_and_long_words_remain_inside_measured_width() {
        let mut request = report();
        let mut rows = vec![vec!["Repeated header".to_string(), "Value".to_string()]];
        rows.extend(
            (0..80).map(|index| vec![format!("Record {index}"), format!("Verified value {index}")]),
        );
        request["blocks"] =
            json!([{"type":"table","rows":rows},{"type":"paragraph","text":"a".repeat(2000)}]);
        let (_, bytes) = create(&request).unwrap();
        let document = super::super::artifacts::checked_pdf(&bytes).unwrap();
        let pages = document.get_pages();
        assert!(pages.len() >= 3);
        for page in 1..=3 {
            assert!(document
                .extract_text(&[page])
                .unwrap()
                .contains("Repeated header"));
        }
        let font = Font::new(false).unwrap();
        let lines = wrap(&font, &"a".repeat(2000), 11.0, WIDTH - 2.0 * MARGIN).unwrap();
        assert_eq!(lines.concat(), "a".repeat(2000));
        assert!(lines
            .iter()
            .all(|line| font.width(line, 11.0).unwrap() <= WIDTH - 2.0 * MARGIN));
    }

    #[test]
    fn invalid_dense_and_unsupported_reports_fail_before_delivery() {
        for block in [
            json!({"type":"paragraph","text":"مرحبا"}),
            json!({"type":"paragraph","text":"emoji 🦄"}),
            json!({"type":"paragraph","text":"e\u{301}"}),
            json!({"type":"heading","level":4,"text":"Invalid"}),
            json!({"type":"table","rows":[["One","Two"],["Missing column"]]}),
            json!({"type":"table","rows":[["A","B","C","D","E","F","G","H"],["Word ".repeat(400),"B","C","D","E","F","G","H"]]}),
            json!({"type":"bar-chart","title":"Bad","labels":["A","B"],"values":[1]}),
            json!({"type":"bar-chart","title":"Bad","labels":["A"],"values":[1e13]}),
            json!({"type":"paragraph","text":"A","url":"https://example.test"}),
        ] {
            let mut request = report();
            request["blocks"] = json!([block]);
            assert!(create(&request).is_err(), "Accepted {request}");
        }
        let mut request = report();
        request["blocks"] = json!((0..51)
            .map(|_| json!({"type":"page-break"}))
            .collect::<Vec<_>>());
        assert!(create(&request).unwrap_err().contains("50 pages"));
        request["blocks"] = json!((0..20)
            .map(|_| json!({"type":"paragraph","text":"a".repeat(8000)}))
            .collect::<Vec<_>>());
        assert!(create(&request).unwrap_err().contains("100 KB"));
    }

    #[test]
    fn stopped_pdf_preparation_cannot_place_files_and_retry_cannot_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let authority_root = tempfile::tempdir().unwrap();
        let authority =
            super::super::authority::ComputerAuthority::load(authority_root.path()).unwrap();
        let generation = authority.snapshot().unwrap().generation;
        let ticket = authority.begin_agent(generation).unwrap();
        let prepared =
            super::super::office_authoring::prepare("create-pdf", &report(), &workspace).unwrap();
        let next = authority.revoke(generation).unwrap();
        assert!(ticket.commit(|| prepared.commit()).is_err());
        assert!(!workspace.join("reports").exists());
        assert!(root.path().read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("office-author-")));
        authority
            .drain(next, std::time::Duration::from_secs(1))
            .unwrap();
        let fresh = authority.begin_agent(next).unwrap();
        let prepared =
            super::super::office_authoring::prepare("create-pdf", &report(), &workspace).unwrap();
        assert!(fresh
            .commit(|| prepared.commit())
            .unwrap()
            .output
            .contains("\"validated\":true"));
        let bytes = std::fs::read(workspace.join("reports/operations.pdf")).unwrap();
        assert!(
            super::super::office_authoring::prepare("create-pdf", &report(), &workspace).is_err()
        );
        assert_eq!(
            std::fs::read(workspace.join("reports/operations.pdf")).unwrap(),
            bytes
        );
        let mut escaped = report();
        escaped["path"] = json!("../../escape.pdf");
        assert!(
            super::super::office_authoring::prepare("create-pdf", &escaped, &workspace).is_err()
        );
    }

    #[test]
    #[ignore = "Writes fixed QA reports to an explicitly supplied local test directory"]
    fn pdf_report_visual_fixture() {
        let path = std::path::PathBuf::from(
            std::env::var("MIVLET_PDF_REPORT_QA_DIR")
                .expect("Choose an existing fixture directory"),
        );
        assert!(path.is_absolute() && path.is_dir());
        let (_, bytes) = create(&report()).unwrap();
        std::fs::write(path.join("sample.pdf"), bytes).unwrap();
        let mut request = report();
        let mut rows = vec![vec!["Repeated header".to_string(), "Value".to_string()]];
        rows.extend(
            (0..80).map(|index| vec![format!("Record {index}"), format!("Verified value {index}")]),
        );
        request["blocks"] = json!([{"type":"table","rows":rows}]);
        std::fs::write(path.join("pagination.pdf"), create(&request).unwrap().1).unwrap();
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Block {
    Paragraph {
        text: String,
    },
    Bullet {
        text: String,
    },
    Heading {
        text: String,
        level: u8,
    },
    Table {
        rows: Vec<Vec<String>>,
    },
    BarChart {
        title: String,
        labels: Vec<String>,
        values: Vec<f64>,
        unit: Option<String>,
    },
    PageBreak,
}

fn text(value: &str, limit: usize, total: &mut usize) -> Result<(), String> {
    if value.trim().is_empty()
        || value.chars().count() > limit
        || value.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(
            "PDF report text is empty, too long or contains unsupported control characters.".into(),
        );
    }
    *total += value.len();
    if *total > 100 * 1024 {
        return Err("A PDF report supports at most 100 KB of text.".into());
    }
    Ok(())
}

pub(super) fn create(arguments: &Value) -> Result<(String, Vec<u8>), String> {
    let request: Report = serde_json::from_value(arguments.clone())
        .map_err(|_| "PDF fields do not match the bounded report contract.")?;
    let mut total = 0;
    text(&request.title, 160, &mut total)?;
    if let Some(subtitle) = &request.subtitle {
        text(subtitle, 300, &mut total)?;
    }
    if request.blocks.is_empty() || request.blocks.len() > 200 {
        return Err("A PDF report needs between 1 and 200 blocks.".into());
    }
    for block in &request.blocks {
        match block {
            Block::Paragraph { text: value } | Block::Bullet { text: value } => {
                text(value, 8000, &mut total)?
            }
            Block::Heading { text: value, level } => {
                text(value, 500, &mut total)?;
                if !(1..=3).contains(level) {
                    return Err("PDF heading level must be 1, 2 or 3.".into());
                }
            }
            Block::Table { rows } => {
                let columns = rows.first().map_or(0, Vec::len);
                if rows.is_empty() || rows.len() > 200 || !(1..=8).contains(&columns) {
                    return Err("PDF tables support 1–200 rows and 1–8 columns.".into());
                }
                for row in rows {
                    if row.len() != columns {
                        return Err("Every PDF table row must have the same columns.".into());
                    }
                    for cell in row {
                        text(cell, 2000, &mut total)?;
                    }
                }
            }
            Block::BarChart {
                title,
                labels,
                values,
                unit,
            } => {
                text(title, 100, &mut total)?;
                if let Some(unit) = unit {
                    text(unit, 32, &mut total)?;
                }
                if labels.is_empty()
                    || labels.len() > 20
                    || labels.len() != values.len()
                    || values.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
                {
                    return Err("A bar chart needs 1–20 matching labels and finite values within ±1 trillion.".into());
                }
                for label in labels {
                    text(label, 100, &mut total)?;
                }
            }
            Block::PageBreak => {}
        }
    }
    let mut layout = Layout::new()?;
    layout.paragraph(&request.title, 24.0, true, 0.0, 8.0)?;
    if let Some(subtitle) = &request.subtitle {
        layout.paragraph(subtitle, 11.0, false, 0.0, 12.0)?;
    }
    for block in &request.blocks {
        match block {
            Block::Paragraph { text } => layout.paragraph(text, 11.0, false, 0.0, 8.0)?,
            Block::Bullet { text } => {
                layout.paragraph(&format!("• {text}"), 11.0, false, 10.0, 5.0)?
            }
            Block::Heading { text, level } => {
                layout.paragraph(text, 19.0 - f32::from(*level) * 2.0, true, 0.0, 8.0)?
            }
            Block::Table { rows } => layout.table(rows)?,
            Block::BarChart {
                title,
                labels,
                values,
                unit,
            } => layout.chart(title, labels, values, unit.as_deref())?,
            Block::PageBreak => layout.new_page()?,
        }
    }
    Ok((request.path, layout.finish(&request.title)?))
}

struct Layout {
    pages: Vec<Vec<Operation>>,
    operations: Vec<Operation>,
    y: f32,
    regular: Font,
    bold: Font,
}

impl Layout {
    fn new() -> Result<Self, String> {
        Ok(Self {
            pages: Vec::new(),
            operations: Vec::new(),
            y: HEIGHT - MARGIN,
            regular: Font::new(false)?,
            bold: Font::new(true)?,
        })
    }
    fn new_page(&mut self) -> Result<(), String> {
        if self.pages.len() >= 49 {
            return Err("This PDF exceeds 50 pages. Split the report.".into());
        }
        self.pages.push(std::mem::take(&mut self.operations));
        self.y = HEIGHT - MARGIN;
        Ok(())
    }
    fn room(&mut self, height: f32) -> Result<(), String> {
        if height > BODY {
            return Err(
                "This PDF block cannot fit on one page. Split the table row or chart.".into(),
            );
        }
        if self.y - height < BOTTOM {
            self.new_page()?;
        }
        Ok(())
    }
    fn draw_text(
        &mut self,
        text: &str,
        x: f32,
        top: f32,
        size: f32,
        bold: bool,
        color: [f32; 3],
    ) -> Result<(), String> {
        let encoded = if bold {
            self.bold.encode(text)?
        } else {
            self.regular.encode(text)?
        };
        self.operations.extend([
            Operation::new("q", vec![]),
            Operation::new("rg", color.into_iter().map(Object::from).collect()),
            Operation::new("BT", vec![]),
            Operation::new(
                "Tf",
                vec![if bold { "F2".into() } else { "F1".into() }, size.into()],
            ),
            Operation::new(
                "Tm",
                vec![
                    1.into(),
                    0.into(),
                    0.into(),
                    1.into(),
                    x.into(),
                    (top - size).into(),
                ],
            ),
            Operation::new("Tj", vec![encoded]),
            Operation::new("ET", vec![]),
            Operation::new("Q", vec![]),
        ]);
        Ok(())
    }
    fn rectangle(&mut self, x: f32, y: f32, width: f32, height: f32, color: [f32; 3]) {
        self.operations.extend([
            Operation::new("q", vec![]),
            Operation::new("rg", color.into_iter().map(Object::from).collect()),
            Operation::new("re", vec![x.into(), y.into(), width.into(), height.into()]),
            Operation::new("f", vec![]),
            Operation::new("Q", vec![]),
        ]);
    }
    fn paragraph(
        &mut self,
        text: &str,
        size: f32,
        bold: bool,
        indent: f32,
        gap: f32,
    ) -> Result<(), String> {
        let font = if bold { &self.bold } else { &self.regular };
        let lines = wrap(font, text, size, WIDTH - 2.0 * MARGIN - indent)?;
        // Keep a heading/title with at least one following body line.
        if bold {
            self.room((lines.len() as f32 * size * 1.4 + 16.0).min(BODY))?;
        }
        for line in lines {
            self.room(size * 1.4)?;
            self.draw_text(
                &line,
                MARGIN + indent,
                self.y,
                size,
                bold,
                if bold { ACCENT } else { INK },
            )?;
            self.y -= size * 1.4;
        }
        self.y -= gap;
        Ok(())
    }
    fn table_row(
        &mut self,
        lines: &[Vec<String>],
        width: f32,
        bold: bool,
        shade: bool,
    ) -> Result<(), String> {
        let height = lines.iter().map(Vec::len).max().unwrap_or(1) as f32 * 13.0 + 12.0;
        self.room(height)?;
        if shade {
            self.rectangle(
                MARGIN,
                self.y - height,
                WIDTH - 2.0 * MARGIN,
                height,
                [0.94, 0.96, 0.95],
            );
        }
        for (column, cell) in lines.iter().enumerate() {
            for (index, line) in cell.iter().enumerate() {
                self.draw_text(
                    line,
                    MARGIN + column as f32 * width + 6.0,
                    self.y - 6.0 - index as f32 * 13.0,
                    10.0,
                    bold,
                    INK,
                )?;
            }
        }
        self.y -= height;
        self.rectangle(
            MARGIN,
            self.y,
            WIDTH - 2.0 * MARGIN,
            0.4,
            [0.82, 0.86, 0.84],
        );
        Ok(())
    }
    fn table(&mut self, rows: &[Vec<String>]) -> Result<(), String> {
        let width = (WIDTH - 2.0 * MARGIN) / rows[0].len() as f32;
        let header = rows[0]
            .iter()
            .map(|cell| wrap(&self.bold, cell, 10.0, width - 12.0))
            .collect::<Result<Vec<_>, _>>()?;
        let header_height = header.iter().map(Vec::len).max().unwrap_or(1) as f32 * 13.0 + 12.0;
        let first_height = rows
            .get(1)
            .map(|row| {
                row.iter()
                    .map(|cell| {
                        wrap(&self.regular, cell, 10.0, width - 12.0).map(|lines| lines.len())
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map(|heights| heights.into_iter().max().unwrap_or(1) as f32 * 13.0 + 12.0)
            })
            .transpose()?
            .unwrap_or(0.0);
        self.room(header_height + first_height)?;
        self.table_row(&header, width, true, true)?;
        for (index, row) in rows.iter().skip(1).enumerate() {
            let lines = row
                .iter()
                .map(|cell| wrap(&self.regular, cell, 10.0, width - 12.0))
                .collect::<Result<Vec<_>, _>>()?;
            let height = lines.iter().map(Vec::len).max().unwrap_or(1) as f32 * 13.0 + 12.0;
            if height + header_height > BODY {
                return Err("This PDF table row is too tall. Split its content.".into());
            }
            if self.y - height < BOTTOM {
                self.new_page()?;
                self.table_row(&header, width, true, true)?;
            }
            self.table_row(&lines, width, false, index % 2 == 1)?;
        }
        self.y -= 12.0;
        Ok(())
    }
    fn chart(
        &mut self,
        title: &str,
        labels: &[String],
        values: &[f64],
        unit: Option<&str>,
    ) -> Result<(), String> {
        let label_lines = labels
            .iter()
            .map(|label| wrap(&self.regular, label, 10.0, 130.0))
            .collect::<Result<Vec<_>, _>>()?;
        if label_lines.iter().any(|lines| lines.len() > 2) {
            return Err("Use shorter bar-chart labels (at most two lines).".into());
        }
        let heading = unit.map_or_else(|| title.to_string(), |unit| format!("{title} ({unit})"));
        let heading_lines = wrap(&self.bold, &heading, 14.0, WIDTH - 2.0 * MARGIN)?;
        let heading_height = heading_lines.len() as f32 * 19.0 + 12.0;
        self.room(heading_height + labels.len() as f32 * 32.0 + 25.0)?;
        for line in heading_lines {
            self.draw_text(&line, MARGIN, self.y, 14.0, true, ACCENT)?;
            self.y -= 19.0;
        }
        self.y -= 12.0;
        let minimum = values.iter().copied().fold(0.0, f64::min);
        let maximum = values.iter().copied().fold(0.0, f64::max);
        let range = if maximum == minimum {
            1.0
        } else {
            maximum - minimum
        };
        let plot_x = MARGIN + 142.0;
        let plot_width = 282.0;
        let zero = plot_x + (-minimum / range * plot_width as f64) as f32;
        self.rectangle(
            zero,
            self.y - labels.len() as f32 * 32.0,
            0.5,
            labels.len() as f32 * 32.0,
            [0.70, 0.76, 0.73],
        );
        for (index, lines) in label_lines.iter().enumerate() {
            for (line_index, line) in lines.iter().enumerate() {
                self.draw_text(
                    line,
                    MARGIN,
                    self.y - line_index as f32 * 12.0,
                    10.0,
                    false,
                    INK,
                )?;
            }
            let end = plot_x + ((values[index] - minimum) / range * plot_width as f64) as f32;
            self.rectangle(
                zero.min(end),
                self.y - 18.0,
                (end - zero).abs(),
                13.0,
                ACCENT,
            );
            let value = values[index].to_string();
            if self.regular.width(&value, 9.0)? > 72.0 {
                return Err(
                    "This chart value label is too wide. Rescale the values and state their unit."
                        .into(),
                );
            }
            self.draw_text(&value, plot_x + plot_width + 8.0, self.y, 9.0, false, INK)?;
            self.y -= 32.0;
        }
        self.y -= 16.0;
        Ok(())
    }
    fn finish(mut self, title: &str) -> Result<Vec<u8>, String> {
        self.pages.push(std::mem::take(&mut self.operations));
        let page_count = self.pages.len();
        for index in 0..page_count {
            self.draw_text(
                &format!("Page {} of {page_count}", index + 1),
                MARGIN,
                36.0,
                9.0,
                false,
                [0.45, 0.49, 0.47],
            )?;
            self.pages[index].extend(std::mem::take(&mut self.operations));
        }
        let mut document = Document::with_version("1.7");
        let regular = self.regular.embed(&mut document)?;
        let bold = self.bold.embed(&mut document)?;
        let parent = document.new_object_id();
        let mut pages = Vec::new();
        for operations in self.pages {
            let bytes = Content { operations }
                .encode()
                .map_err(|_| "PDF report encoding failed.")?;
            let contents = document.add_object(Stream::new(dictionary! {}, bytes));
            pages.push(document.add_object(dictionary! {
                "Type"=>"Page","Parent"=>parent,"MediaBox"=>vec![0.into(),0.into(),WIDTH.into(),HEIGHT.into()],
                "Resources"=>dictionary! {"Font"=>dictionary! {"F1"=>regular,"F2"=>bold}},"Contents"=>contents,
            }).into());
        }
        document.objects.insert(
            parent,
            dictionary! {"Type"=>"Pages","Kids"=>pages,"Count"=>page_count as i64}.into(),
        );
        let catalog = document.add_object(dictionary! {"Type"=>"Catalog","Pages"=>parent});
        document.trailer.set("Root", catalog);
        let title = [
            vec![0xfe, 0xff],
            title.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        ]
        .concat();
        let info = document.add_object(dictionary! {"Title"=>Object::string_literal(title),"Producer"=>Object::string_literal("Mivlet")});
        document.trailer.set("Info", info);
        document.compress();
        let mut bytes = Vec::new();
        document
            .save_to(&mut bytes)
            .map_err(|_| "PDF report could not be saved.")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Generated PDF exceeds the 8 MB report limit.".into());
        }
        Ok(bytes)
    }
}
