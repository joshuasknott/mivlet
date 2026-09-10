//! Bounded passive DOCX/XLSX authoring for an agent's private workspace.
//!
//! This is deliberately not an Office automation or command-execution surface.
//! The model supplies a small declarative document, Rust writes fixed OOXML
//! parts, then the normal publication sanitizer reopens and validates the whole
//! package before the file is placed in the workspace.

use crate::tools::{confine_path, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_TOTAL_TEXT: usize = 2 * 1024 * 1024;
const MAX_SHEETS: usize = 8;
const MAX_ROWS: usize = 2_000;
const MAX_COLUMNS: usize = 52;
const MAX_TOTAL_CELLS: usize = 100_000;
const MAX_FORMULA_RANGE_CELLS: usize = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpreadsheetRequest {
    path: String,
    sheets: Vec<Sheet>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sheet {
    name: String,
    rows: Vec<Vec<Cell>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Cell {
    Text(String),
    Number(f64),
    Boolean(bool),
    Formula(FormulaCell),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormulaCell {
    formula: Aggregate,
    range: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Aggregate {
    Sum,
    Average,
    Min,
    Max,
    Count,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentRequest {
    path: String,
    title: String,
    blocks: Vec<DocumentBlock>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum DocumentBlock {
    Paragraph { text: String },
    Bullet { text: String },
    Heading { text: String, level: u8 },
    Table { rows: Vec<Vec<String>> },
}

pub(crate) struct PreparedOffice {
    destination: PathBuf,
    path: String,
    staging: tempfile::NamedTempFile,
    byte_len: usize,
    formula_cells: usize,
    format: &'static str,
}

pub(crate) fn prepare(
    tool: &str,
    arguments: &Value,
    workspace_root: &Path,
) -> Result<PreparedOffice, String> {
    let (path, bytes, formula_cells, format) = match tool {
        "create-spreadsheet" => {
            let request: SpreadsheetRequest = serde_json::from_value(arguments.clone())
                .map_err(|_| "Spreadsheet fields do not match the bounded authoring contract.")?;
            let (bytes, formulas) = create_xlsx(&request)?;
            (request.path, bytes, formulas, "xlsx")
        }
        "create-document" => {
            let request: DocumentRequest = serde_json::from_value(arguments.clone())
                .map_err(|_| "Document fields do not match the bounded authoring contract.")?;
            let bytes = create_docx(&request)?;
            (request.path, bytes, 0, "docx")
        }
        _ => return Err("The Office authoring tool is not supported.".into()),
    };
    let destination = destination(&path, format, workspace_root)?;
    if destination.exists() {
        return Err(
            "Choose a new workspace path; Office authoring does not overwrite an existing file."
                .into(),
        );
    }
    if !crate::local_computer::artifacts::check_office(&bytes, format)? {
        return Err("Mivlet rejected the generated Office package before publication.".into());
    }
    let staging_root = workspace_root
        .parent()
        .ok_or("The Office staging path is invalid.")?;
    let mut staging = tempfile::Builder::new()
        .prefix("office-author-")
        .tempfile_in(staging_root)
        .map_err(|_| "Mivlet could not prepare the Office output.")?;
    staging
        .write_all(&bytes)
        .map_err(|_| "Mivlet could not stage the Office output.")?;
    staging
        .as_file()
        .sync_all()
        .map_err(|_| "Mivlet could not stage the Office output.")?;
    Ok(PreparedOffice {
        destination,
        path,
        staging,
        byte_len: bytes.len(),
        formula_cells,
        format,
    })
}

impl PreparedOffice {
    /// The caller must run this small final placement inside an authority-fenced
    /// commit. Generation and validation intentionally happen before that lock.
    pub(crate) fn commit(self) -> Result<ToolResult, String> {
        let Self {
            destination,
            path,
            staging,
            byte_len,
            formula_cells,
            format,
        } = self;
        let parent = destination
            .parent()
            .ok_or("The Office output path is invalid.")?;
        fs::create_dir_all(parent)
            .map_err(|_| "Mivlet could not prepare the Office output folder.")?;
        staging.persist_noclobber(&destination).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                "Choose a new workspace path; Office authoring does not overwrite an existing file."
                    .to_string()
            } else {
                "Mivlet could not finish the Office output.".to_string()
            }
        })?;
        let output = json!({
            "path": path,
            "format": format,
            "bytes": byte_len,
            "formulaCells": formula_cells,
            "validated": true,
            "publication": "Call computer-artifact with this exact path to publish the validated file."
        });
        Ok(ToolResult {
            ok: true,
            output: serde_json::to_string(&output)
                .map_err(|_| "The Office authoring receipt is invalid.")?,
        })
    }
}

fn destination(path: &str, extension: &str, root: &Path) -> Result<PathBuf, String> {
    if path.len() > 240
        || !path
            .to_ascii_lowercase()
            .ends_with(&format!(".{extension}"))
    {
        return Err(format!(
            "Choose a relative .{extension} path in this agent's workspace."
        ));
    }
    if crate::local_computer::artifacts::allowed_path(path)? != extension {
        return Err(format!(
            "Choose a publication-safe .{extension} workspace path."
        ));
    }
    confine_path(path, root)
}

fn create_xlsx(request: &SpreadsheetRequest) -> Result<(Vec<u8>, usize), String> {
    if request.sheets.is_empty() || request.sheets.len() > MAX_SHEETS {
        return Err("A spreadsheet needs between 1 and 8 sheets.".into());
    }
    let mut names = HashSet::new();
    let mut worksheets = Vec::new();
    let mut formula_count = 0;
    let mut total_text = 0usize;
    let mut total_cells = 0usize;
    for sheet in &request.sheets {
        validate_sheet_name(&sheet.name, &mut names)?;
        total_cells = total_cells.saturating_add(sheet.rows.iter().map(Vec::len).sum::<usize>());
        total_text = total_text.saturating_add(
            sheet
                .rows
                .iter()
                .flatten()
                .filter_map(|cell| match cell {
                    Cell::Text(text) => Some(text.len()),
                    _ => None,
                })
                .sum::<usize>(),
        );
        if total_text > MAX_TOTAL_TEXT {
            return Err("Spreadsheet text exceeds Mivlet's 2 MB authoring limit.".into());
        }
        if total_cells > MAX_TOTAL_CELLS {
            return Err("A spreadsheet may contain at most 100000 cells.".into());
        }
        let (xml, formulas) = worksheet_xml(sheet)?;
        formula_count += formulas;
        worksheets.push(xml);
    }

    let mut files = vec![
        (
            "[Content_Types].xml".into(),
            xlsx_content_types(request.sheets.len()),
        ),
        ("_rels/.rels".into(), root_relationships("xl/workbook.xml")),
        ("xl/workbook.xml".into(), workbook_xml(&request.sheets)),
        (
            "xl/_rels/workbook.xml.rels".into(),
            workbook_relationships(request.sheets.len()),
        ),
        ("xl/styles.xml".into(), xlsx_styles()),
    ];
    files.extend(
        worksheets
            .into_iter()
            .enumerate()
            .map(|(index, xml)| (format!("xl/worksheets/sheet{}.xml", index + 1), xml)),
    );
    Ok((zip_files(files)?, formula_count))
}

fn worksheet_xml(sheet: &Sheet) -> Result<(String, usize), String> {
    if sheet.rows.is_empty() || sheet.rows.len() > MAX_ROWS {
        return Err("Each spreadsheet sheet needs between 1 and 2000 rows.".into());
    }
    let mut values: Vec<Vec<Option<f64>>> = Vec::with_capacity(sheet.rows.len());
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><sheetData>");
    let mut formulas = 0;
    for (row_index, row) in sheet.rows.iter().enumerate() {
        if row.is_empty() || row.len() > MAX_COLUMNS {
            return Err("Spreadsheet rows need between 1 and 52 cells.".into());
        }
        xml.push_str(&format!("<row r=\"{}\">", row_index + 1));
        let mut numeric_row = Vec::with_capacity(row.len());
        for (column_index, cell) in row.iter().enumerate() {
            let reference = cell_reference(row_index, column_index);
            match cell {
                Cell::Text(text) => {
                    if text.chars().count() > 2_000 || has_forbidden_control(text) {
                        return Err(
                            "Spreadsheet text cells must be at most 2000 safe characters.".into(),
                        );
                    }
                    xml.push_str(&format!("<c r=\"{reference}\" t=\"inlineStr\"{}><is><t xml:space=\"preserve\">{}</t></is></c>", if row_index == 0 { " s=\"1\"" } else { "" }, escape_xml(text)));
                    numeric_row.push(None);
                }
                Cell::Number(number) => {
                    validate_number(*number)?;
                    xml.push_str(&format!(
                        "<c r=\"{reference}\"{}><v>{}</v></c>",
                        if row_index == 0 { " s=\"1\"" } else { "" },
                        number_text(*number)
                    ));
                    numeric_row.push(Some(*number));
                }
                Cell::Boolean(value) => {
                    xml.push_str(&format!(
                        "<c r=\"{reference}\" t=\"b\"{}><v>{}</v></c>",
                        if row_index == 0 { " s=\"1\"" } else { "" },
                        u8::from(*value)
                    ));
                    numeric_row.push(None);
                }
                Cell::Formula(formula) => {
                    let (start, end) = parse_range(&formula.range)?;
                    let range_cells = (end.0 - start.0 + 1).saturating_mul(end.1 - start.1 + 1);
                    if range_cells > MAX_FORMULA_RANGE_CELLS {
                        return Err(
                            "A spreadsheet formula may aggregate at most 10000 cells.".into()
                        );
                    }
                    if end.0 > row_index || (end.0 == row_index && end.1 >= column_index) {
                        return Err("Spreadsheet formulas may reference only cells that appear earlier in the sheet.".into());
                    }
                    let result =
                        evaluate_aggregate(formula.formula, start, end, &values, &numeric_row)?;
                    let function = match formula.formula {
                        Aggregate::Sum => "SUM",
                        Aggregate::Average => "AVERAGE",
                        Aggregate::Min => "MIN",
                        Aggregate::Max => "MAX",
                        Aggregate::Count => "COUNT",
                    };
                    xml.push_str(&format!(
                        "<c r=\"{reference}\"><f>{function}({})</f><v>{}</v></c>",
                        formula.range,
                        number_text(result)
                    ));
                    numeric_row.push(Some(result));
                    formulas += 1;
                }
            }
        }
        values.push(numeric_row);
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData><pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/></worksheet>");
    Ok((xml, formulas))
}

fn evaluate_aggregate(
    operation: Aggregate,
    start: (usize, usize),
    end: (usize, usize),
    prior_rows: &[Vec<Option<f64>>],
    current_row: &[Option<f64>],
) -> Result<f64, String> {
    let mut numbers = Vec::new();
    for row in start.0..=end.0 {
        for column in start.1..=end.1 {
            let value = if row == prior_rows.len() {
                current_row.get(column).copied().flatten()
            } else {
                prior_rows
                    .get(row)
                    .and_then(|values| values.get(column))
                    .copied()
                    .flatten()
            };
            if let Some(value) = value {
                numbers.push(value);
            }
        }
    }
    let result = match operation {
        Aggregate::Count => numbers.len() as f64,
        Aggregate::Sum => numbers.iter().sum(),
        Aggregate::Average if !numbers.is_empty() => {
            numbers.iter().sum::<f64>() / numbers.len() as f64
        }
        Aggregate::Min if !numbers.is_empty() => {
            numbers.iter().copied().fold(f64::INFINITY, f64::min)
        }
        Aggregate::Max if !numbers.is_empty() => {
            numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        }
        _ => {
            return Err(
                "AVERAGE, MIN and MAX formulas require at least one earlier numeric cell.".into(),
            )
        }
    };
    validate_number(result)?;
    Ok(result)
}

fn parse_range(value: &str) -> Result<((usize, usize), (usize, usize)), String> {
    let (start, end) = value
        .split_once(':')
        .ok_or("Formula ranges must use A1:B2 notation.")?;
    let start = parse_cell_reference(start)?;
    let end = parse_cell_reference(end)?;
    if start.0 > end.0 || start.1 > end.1 {
        return Err("Formula ranges must run from the top-left to the bottom-right cell.".into());
    }
    Ok((start, end))
}

fn parse_cell_reference(value: &str) -> Result<(usize, usize), String> {
    let letters = value
        .bytes()
        .take_while(u8::is_ascii_uppercase)
        .collect::<Vec<_>>();
    let digits = &value[letters.len()..];
    if letters.is_empty()
        || letters.len() > 2
        || digits.is_empty()
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Formula ranges must use uppercase A1 notation.".into());
    }
    let mut column = 0usize;
    for letter in letters {
        column = column * 26 + usize::from(letter - b'A' + 1);
    }
    let row = digits
        .parse::<usize>()
        .map_err(|_| "Formula row is invalid.")?;
    if row == 0 || row > MAX_ROWS || column == 0 || column > MAX_COLUMNS {
        return Err("Formula ranges must stay within 2000 rows and 52 columns.".into());
    }
    Ok((row - 1, column - 1))
}

fn validate_sheet_name(name: &str, names: &mut HashSet<String>) -> Result<(), String> {
    if name.is_empty()
        || name.chars().count() > 31
        || name.contains(['[', ']', ':', '*', '?', '/', '\\'])
        || name.starts_with('\'')
        || name.ends_with('\'')
        || has_forbidden_control(name)
        || !names.insert(name.to_lowercase())
    {
        return Err(
            "Spreadsheet sheet names must be unique, safe and at most 31 characters.".into(),
        );
    }
    Ok(())
}

fn validate_number(value: f64) -> Result<(), String> {
    if !value.is_finite() || value.abs() > 1_000_000_000_000f64 {
        return Err("Spreadsheet numbers must be finite and no larger than one trillion.".into());
    }
    Ok(())
}

fn create_docx(request: &DocumentRequest) -> Result<Vec<u8>, String> {
    if request.title.trim().is_empty()
        || request.title.chars().count() > 160
        || request.blocks.is_empty()
        || request.blocks.len() > 500
        || has_forbidden_control(&request.title)
    {
        return Err("A document needs a safe title and between 1 and 500 blocks.".into());
    }
    let mut body = paragraph_xml(&request.title, "Title", false);
    let mut total_text = request.title.len();
    for block in &request.blocks {
        match block {
            DocumentBlock::Paragraph { text } => {
                validate_document_text(text, 8_000)?;
                total_text = total_text.saturating_add(text.len());
                ensure_document_size(total_text)?;
                body.push_str(&paragraph_xml(text, "Normal", false));
            }
            DocumentBlock::Bullet { text } => {
                validate_document_text(text, 8_000)?;
                total_text = total_text.saturating_add(text.len());
                ensure_document_size(total_text)?;
                body.push_str(&paragraph_xml(&format!("• {text}"), "ListParagraph", false));
            }
            DocumentBlock::Heading { text, level } => {
                validate_document_text(text, 500)?;
                if !(1..=3).contains(level) {
                    return Err("Document heading levels must be between 1 and 3.".into());
                }
                total_text = total_text.saturating_add(text.len());
                ensure_document_size(total_text)?;
                body.push_str(&paragraph_xml(text, &format!("Heading{level}"), true));
            }
            DocumentBlock::Table { rows } => {
                if rows.is_empty()
                    || rows.len() > 200
                    || rows[0].is_empty()
                    || rows[0].len() > 12
                    || rows.iter().any(|row| row.len() != rows[0].len())
                {
                    return Err(
                        "Document tables need 1 to 200 equal-width rows and at most 12 columns."
                            .into(),
                    );
                }
                body.push_str("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/></w:tblBorders><w:tblCellMar><w:top w:w=\"100\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/><w:bottom w:w=\"100\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr>");
                for (row_index, row) in rows.iter().enumerate() {
                    body.push_str("<w:tr>");
                    for cell in row {
                        validate_document_text(cell, 2_000)?;
                        total_text = total_text.saturating_add(cell.len());
                        ensure_document_size(total_text)?;
                        body.push_str("<w:tc><w:tcPr><w:vAlign w:val=\"center\"/>");
                        if row_index == 0 {
                            body.push_str(
                                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"D9EAF7\"/>",
                            );
                        }
                        body.push_str("</w:tcPr>");
                        body.push_str(&paragraph_xml(cell, "Normal", row_index == 0));
                        body.push_str("</w:tc>");
                    }
                    body.push_str("</w:tr>");
                }
                body.push_str("</w:tbl><w:p/>");
            }
        }
    }
    body.push_str("<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1080\" w:right=\"1080\" w:bottom=\"1080\" w:left=\"1080\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>");
    let document = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>");
    zip_files(vec![
        ("[Content_Types].xml".into(), docx_content_types()),
        (
            "_rels/.rels".into(),
            root_relationships("word/document.xml"),
        ),
        ("word/document.xml".into(), document),
        ("word/_rels/document.xml.rels".into(), docx_relationships()),
        ("word/styles.xml".into(), docx_styles()),
    ])
}

fn ensure_document_size(total_text: usize) -> Result<(), String> {
    if total_text > MAX_TOTAL_TEXT {
        return Err("Document text exceeds Mivlet's 2 MB authoring limit.".into());
    }
    Ok(())
}

fn validate_document_text(text: &str, max: usize) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > max || has_forbidden_control(text) {
        return Err(
            "Document text is empty, too long, or contains unsupported control characters.".into(),
        );
    }
    Ok(())
}

fn paragraph_xml(text: &str, style: &str, bold: bool) -> String {
    format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", if bold { "<w:rPr><w:b/></w:rPr>" } else { "" }, escape_xml(text))
}

fn zip_files(files: Vec<(String, String)>) -> Result<Vec<u8>, String> {
    let mut output = Cursor::new(Vec::new());
    {
        let mut archive = ZipWriter::new(&mut output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in files {
            archive
                .start_file(name, options)
                .map_err(|_| "Mivlet could not assemble the Office package.")?;
            archive
                .write_all(content.as_bytes())
                .map_err(|_| "Mivlet could not assemble the Office package.")?;
        }
        archive
            .finish()
            .map_err(|_| "Mivlet could not finish the Office package.")?;
    }
    Ok(output.into_inner())
}

fn root_relationships(target: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"{target}\"/></Relationships>")
}

fn xlsx_content_types(sheets: usize) -> String {
    let mut value = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
    for index in 1..=sheets {
        value.push_str(&format!("<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"));
    }
    value.push_str("</Types>");
    value
}

fn workbook_xml(sheets: &[Sheet]) -> String {
    let mut value = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>");
    for (index, sheet) in sheets.iter().enumerate() {
        value.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
            escape_xml(&sheet.name),
            index + 1,
            index + 1
        ));
    }
    value.push_str("</sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>");
    value
}

fn workbook_relationships(sheets: usize) -> String {
    let mut value = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    for index in 1..=sheets {
        value.push_str(&format!("<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>"));
    }
    value.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>", sheets + 1));
    value
}

fn xlsx_styles() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Aptos\"/></font><font><b/><color rgb=\"FFFFFFFF\"/><sz val=\"11\"/><name val=\"Aptos\"/></font></fonts><fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF1F4E78\"/><bgColor indexed=\"64\"/></patternFill></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>".into()
}

fn docx_content_types() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>".into()
}

fn docx_relationships() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>".into()
}

fn docx_styles() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Aptos\" w:hAnsi=\"Aptos\"/><w:sz w:val=\"22\"/><w:color w:val=\"000000\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style><w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"0\" w:after=\"320\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"40\"/><w:color w:val=\"000000\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/><w:spacing w:before=\"280\" w:after=\"120\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/><w:color w:val=\"000000\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"100\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"26\"/><w:color w:val=\"000000\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/><w:spacing w:before=\"200\" w:after=\"80\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"23\"/><w:color w:val=\"000000\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"360\" w:hanging=\"180\"/></w:pPr></w:style></w:styles>".into()
}

fn cell_reference(row: usize, column: usize) -> String {
    let mut column = column + 1;
    let mut letters = String::new();
    while column > 0 {
        let remainder = (column - 1) % 26;
        letters.insert(0, char::from(b'A' + remainder as u8));
        column = (column - 1) / 26;
    }
    format!("{letters}{}", row + 1)
}

fn number_text(value: f64) -> String {
    if value == -0.0 {
        "0".into()
    } else {
        value.to_string()
    }
}

fn has_forbidden_control(value: &str) -> bool {
    value.chars().any(|character| {
        let code = character as u32;
        (code < 32 && !matches!(character, '\n' | '\r' | '\t')) || code == 127
    })
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn spreadsheet_contains_real_formula_and_verified_cache() {
        let request: SpreadsheetRequest = serde_json::from_value(json!({
            "path": "totals.xlsx",
            "sheets": [{ "name": "Summary", "rows": [
                ["Item", "Value"], ["Alpha", 6], ["Beta", 20],
                ["Total", { "formula": "sum", "range": "B2:B3" }]
            ] }]
        }))
        .unwrap();
        let (bytes, formulas) = create_xlsx(&request).unwrap();
        assert_eq!(formulas, 1);
        assert!(crate::local_computer::artifacts::check_office(&bytes, "xlsx").unwrap());
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<f>SUM(B2:B3)</f><v>26</v>"));
    }

    #[test]
    fn document_is_passive_valid_docx() {
        let request: DocumentRequest = serde_json::from_value(json!({
            "path": "summary.docx", "title": "Audit summary", "blocks": [
                { "type": "paragraph", "text": "The calculated total is 26." },
                { "type": "table", "rows": [["Item", "Value"], ["Total", "26"]] }
            ]
        }))
        .unwrap();
        let bytes = create_docx(&request).unwrap();
        assert!(crate::local_computer::artifacts::check_office(&bytes, "docx").unwrap());
    }

    #[test]
    fn formulas_cannot_reference_future_cells() {
        let request: SpreadsheetRequest = serde_json::from_value(json!({
            "path": "bad.xlsx", "sheets": [{ "name": "Sheet1", "rows": [
                [{ "formula": "sum", "range": "A1:A2" }], [1]
            ] }]
        }))
        .unwrap();
        assert!(create_xlsx(&request).unwrap_err().contains("earlier"));
    }

    #[test]
    fn authoring_validates_then_places_a_new_publishable_file() {
        let workspace_container = tempfile::tempdir().unwrap();
        let workspace = workspace_container.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let arguments = json!({
            "path": "reports/totals.xlsx",
            "sheets": [{ "name": "Summary", "rows": [
                ["Item", "Value"], ["Alpha", 6], ["Beta", 20],
                ["Total", { "formula": "sum", "range": "B2:B3" }]
            ] }]
        });
        let result = prepare("create-spreadsheet", &arguments, &workspace)
            .unwrap()
            .commit()
            .unwrap();
        assert!(result.output.contains("\"validated\":true"));
        assert!(workspace.join("reports/totals.xlsx").is_file());
        assert!(prepare("create-spreadsheet", &arguments, &workspace)
            .err()
            .unwrap()
            .contains("does not overwrite"));
    }

    #[test]
    fn revoked_generation_cannot_commit_and_a_fresh_retry_works() {
        let authority_root = tempfile::tempdir().unwrap();
        let workspace_container = tempfile::tempdir().unwrap();
        let workspace = workspace_container.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let authority =
            crate::local_computer::authority::ComputerAuthority::load(authority_root.path())
                .unwrap();
        let generation = authority.snapshot().unwrap().generation;
        let arguments = json!({
            "path": "reports/cancelled.xlsx",
            "sheets": [{ "name": "Summary", "rows": [["Item", "Value"], ["Total", 26]] }]
        });

        let ticket = authority.begin_agent(generation).unwrap();
        let prepared = prepare("create-spreadsheet", &arguments, &workspace).unwrap();
        let next_generation = authority.revoke(generation).unwrap();
        assert!(ticket.commit(|| prepared.commit()).is_err());
        assert!(!workspace.join("reports/cancelled.xlsx").exists());
        assert!(!workspace.join("reports").exists());
        assert!(workspace_container
            .path()
            .read_dir()
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("office-author-")));

        authority
            .drain(next_generation, std::time::Duration::from_secs(1))
            .unwrap();
        let retry = authority.begin_agent(next_generation).unwrap();
        let prepared = prepare("create-spreadsheet", &arguments, &workspace).unwrap();
        retry.commit(|| prepared.commit()).unwrap();
        assert!(workspace.join("reports/cancelled.xlsx").is_file());
    }

    #[test]
    fn unicode_limits_count_characters_while_the_aggregate_budget_counts_bytes() {
        let document: DocumentRequest = serde_json::from_value(json!({
            "path": "unicode.docx",
            "title": "🦊".repeat(100),
            "blocks": [{ "type": "paragraph", "text": "🦊".repeat(1_000) }]
        }))
        .unwrap();
        assert!(create_docx(&document).is_ok());

        let spreadsheet: SpreadsheetRequest = serde_json::from_value(json!({
            "path": "unicode.xlsx",
            "sheets": [{ "name": "Unicode", "rows": [["🦊".repeat(1_000)]] }]
        }))
        .unwrap();
        assert!(create_xlsx(&spreadsheet).is_ok());

        let too_long: DocumentRequest = serde_json::from_value(json!({
            "path": "too-long.docx",
            "title": "🦊".repeat(161),
            "blocks": [{ "type": "paragraph", "text": "Ready." }]
        }))
        .unwrap();
        assert!(create_docx(&too_long).is_err());
    }
}
