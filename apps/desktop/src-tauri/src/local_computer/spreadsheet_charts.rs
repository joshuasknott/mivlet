//! Editable, same-sheet OOXML charts. Fixed XML only; no scripts or external data.
use super::office_authoring::{
    cell_reference, escape_xml, number_text, parse_range, validate_document_text, Cell, Sheet,
};
use serde::Deserialize;

const C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XDR: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const COLORS: [&str; 3] = ["2563EB", "B45309", "047857"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Chart {
    title: String,
    #[serde(rename = "type")]
    kind: Kind,
    categories: String,
    series: Vec<Series>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Column,
    Line,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Series {
    name: String,
    values: String,
}

/// One vertical, bounded cell range; no arbitrary formulas or cross-sheet references.
pub(super) fn column_range(range: &str) -> Result<(usize, usize, usize), String> {
    let (start, end) = parse_range(range)?;
    if start.1 != end.1 || !(2..=24).contains(&(end.0 - start.0 + 1)) {
        return Err("Chart ranges need 2 to 24 cells in one column.".into());
    }
    Ok((start.0, end.0, start.1))
}

fn reference(sheet: &str, range: (usize, usize, usize)) -> String {
    let absolute = |row| {
        let cell = cell_reference(row, range.2);
        let split = cell.bytes().position(|ch| ch.is_ascii_digit()).unwrap();
        format!("${}${}", &cell[..split], &cell[split..])
    };
    format!(
        "'{}'!{}:{}",
        sheet.replace('\'', "''"),
        absolute(range.0),
        absolute(range.1)
    )
}

fn chart_xml(chart: &Chart, sheet: &Sheet, numbers: &[Vec<Option<f64>>]) -> Result<String, String> {
    validate_document_text(&chart.title, 120)?;
    if chart.series.is_empty() || chart.series.len() > 3 {
        return Err("A chart needs one to three series.".into());
    }
    let categories = column_range(&chart.categories)?;
    let mut labels = String::new();
    for (index, row) in (categories.0..=categories.1).enumerate() {
        let label = match sheet.rows.get(row).and_then(|row| row.get(categories.2)) {
            Some(Cell::Text(text)) => text.clone(),
            Some(Cell::Number(value)) => number_text(*value),
            Some(Cell::Formula(_)) => numbers
                .get(row)
                .and_then(|row| row.get(categories.2))
                .copied()
                .flatten()
                .map(number_text)
                .ok_or("The chart category has no numeric value.")?,
            _ => return Err("Chart categories need nonempty text or numeric cells.".into()),
        };
        validate_document_text(&label, 80)?;
        labels.push_str(&format!(
            "<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>",
            escape_xml(&label)
        ));
    }
    let count = categories.1 - categories.0 + 1;
    let category_cache = format!("<c:cat><c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{count}\"/>{labels}</c:strCache></c:strRef></c:cat>", escape_xml(&reference(&sheet.name, categories)));
    let mut series_xml = String::new();
    for (index, series) in chart.series.iter().enumerate() {
        validate_document_text(&series.name, 80)?;
        let range = column_range(&series.values)?;
        if range.1 - range.0 + 1 != count {
            return Err("Chart series and category ranges must have equal lengths.".into());
        }
        let mut points = String::new();
        for (point, row) in (range.0..=range.1).enumerate() {
            let value = numbers
                .get(row)
                .and_then(|row| row.get(range.2))
                .copied()
                .flatten()
                .ok_or(
                    "Every chart series cell must contain a number or a verified aggregate result.",
                )?;
            points.push_str(&format!(
                "<c:pt idx=\"{point}\"><c:v>{}</c:v></c:pt>",
                number_text(value)
            ));
        }
        let color = COLORS[index];
        let shape = match chart.kind {
            Kind::Column => format!("<c:spPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>"),
            Kind::Line => format!("<c:spPr><a:ln w=\"28575\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val=\"circle\"/><c:size val=\"5\"/></c:marker>"),
        };
        series_xml.push_str(&format!("<c:ser><c:idx val=\"{index}\"/><c:order val=\"{index}\"/><c:tx><c:v>{}</c:v></c:tx>{shape}{category_cache}<c:val><c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"{count}\"/>{points}</c:numCache></c:numRef></c:val></c:ser>", escape_xml(&series.name), escape_xml(&reference(&sheet.name, range))));
    }
    let plot = match chart.kind {
        Kind::Column => format!("<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>{series_xml}<c:gapWidth val=\"150\"/><c:overlap val=\"0\"/><c:axId val=\"1\"/><c:axId val=\"2\"/></c:barChart>"),
        Kind::Line => format!("<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{series_xml}<c:marker val=\"1\"/><c:smooth val=\"0\"/><c:axId val=\"1\"/><c:axId val=\"2\"/></c:lineChart>"),
    };
    let title = escape_xml(&chart.title);
    Ok(format!("<c:chartSpace xmlns:c=\"{C}\" xmlns:a=\"{A}\" xmlns:r=\"{R}\"><c:lang val=\"en-US\"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr lang=\"en-US\"/><a:t>{title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title><c:plotArea><c:layout/>{plot}<c:catAx><c:axId val=\"1\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"b\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"2\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/></c:catAx><c:valAx><c:axId val=\"2\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"l\"/><c:majorGridlines/><c:numFmt formatCode=\"General\" sourceLinked=\"1\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"1\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/></c:valAx></c:plotArea><c:legend><c:legendPos val=\"b\"/><c:layout/><c:overlay val=\"0\"/></c:legend><c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart></c:chartSpace>"))
}

pub(super) fn append(
    sheet_id: usize,
    sheet: &Sheet,
    numbers: &[Vec<Option<f64>>],
    worksheet: &mut String,
    files: &mut Vec<(String, String)>,
    types: &mut String,
) -> Result<(), String> {
    if sheet.charts.is_empty() {
        return Ok(());
    }
    if sheet.charts.len() > 2 {
        return Err("Use at most two charts per sheet.".into());
    }
    let mut drawing = format!("<xdr:wsDr xmlns:xdr=\"{XDR}\" xmlns:a=\"{A}\" xmlns:r=\"{R}\">");
    let mut relationships = String::from(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    let column = sheet.rows.iter().map(Vec::len).max().unwrap_or(1) + 1;
    for (index, chart) in sheet.charts.iter().enumerate() {
        let id = (sheet_id - 1) * 2 + index + 1;
        files.push((
            format!("xl/charts/chart{id}.xml"),
            chart_xml(chart, sheet, numbers)?,
        ));
        types.push_str(&format!("<Override PartName=\"/xl/charts/chart{id}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawingml.chart+xml\"/>"));
        let relationship = index + 1;
        relationships.push_str(&format!("<Relationship Id=\"rId{relationship}\" Type=\"{R}/chart\" Target=\"../charts/chart{id}.xml\"/>"));
        let row = index * 20;
        drawing.push_str(&format!("<xdr:twoCellAnchor><xdr:from><xdr:col>{column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{relationship}\" name=\"Chart {relationship}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm><a:graphic><a:graphicData uri=\"{C}\"><c:chart xmlns:c=\"{C}\" r:id=\"rId{relationship}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>", column + 10, row + 18));
    }
    drawing.push_str("</xdr:wsDr>");
    relationships.push_str("</Relationships>");
    files.push((format!("xl/drawings/drawing{sheet_id}.xml"), drawing));
    files.push((
        format!("xl/drawings/_rels/drawing{sheet_id}.xml.rels"),
        relationships,
    ));
    files.push((format!("xl/worksheets/_rels/sheet{sheet_id}.xml.rels"), format!("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{R}/drawing\" Target=\"../drawings/drawing{sheet_id}.xml\"/></Relationships>")));
    types.push_str(&format!("<Override PartName=\"/xl/drawings/drawing{sheet_id}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>"));
    *worksheet = worksheet.replace(
        "</worksheet>",
        &format!("<drawing xmlns:r=\"{R}\" r:id=\"rId1\"/></worksheet>"),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use std::{
        fs,
        io::{Cursor, Read},
    };

    pub(super) fn arguments() -> Value {
        json!({"path":"reports/charts.xlsx","sheets":[{"name":"Team's café", "rows":[
            ["Month","Net","Costs"],["Jan",12,4],["Feb",-8,9],["Mar",0,3],
            ["Total",{"formula":"sum","range":"B2:B4"},16]],
            "charts":[{"title":"Net & costs <2026>","type":"column","categories":"A2:A5",
                "series":[{"name":"Net","values":"B2:B5"},{"name":"Costs","values":"C2:C5"}]},
                {"title":"Net trend","type":"line","categories":"A2:A5","series":[{"name":"Net","values":"B2:B5"}]}]}]})
    }
    fn generate(args: &Value) -> Vec<u8> {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let result =
            super::super::office_authoring::prepare("create-spreadsheet", args, &workspace)
                .unwrap()
                .commit()
                .unwrap();
        assert!(result.ok);
        fs::read(workspace.join(args["path"].as_str().unwrap())).unwrap()
    }
    fn projection(bytes: &[u8]) -> Value {
        serde_json::to_value(
            super::super::office_preview::preview(bytes, "xlsx")
                .unwrap()
                .0,
        )
        .unwrap()
    }
    fn replace_part(bytes: &[u8], path: &str, from: &str, to: &str) -> Vec<u8> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut files = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut xml = String::new();
            entry.read_to_string(&mut xml).unwrap();
            if entry.name() == path {
                assert!(xml.contains(from));
                xml = xml.replace(from, to);
            }
            files.push((entry.name().to_string(), xml));
        }
        super::super::office_authoring::zip_files(files).unwrap()
    }
    #[test]
    fn editable_charts_link_to_real_cells_and_preview_signed_verified_results() {
        let bytes = generate(&arguments());
        assert!(super::super::artifacts::check_office(&bytes, "xlsx").unwrap());
        let value = projection(&bytes);
        let chart = &value["sections"][0]["blocks"][1];
        assert_eq!(chart["kind"], "column");
        assert_eq!(chart["title"], "Net & costs <2026>");
        assert_eq!(chart["categories"], json!(["Jan", "Feb", "Mar", "Total"]));
        assert_eq!(chart["series"][0]["values"], json!([12., -8., 0., 4.]));
        assert_eq!(value["sections"][0]["blocks"][2]["kind"], "line");
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut chart = String::new();
        archive
            .by_name("xl/charts/chart1.xml")
            .unwrap()
            .read_to_string(&mut chart)
            .unwrap();
        assert!(chart.contains("&apos;Team&apos;&apos;s café&apos;!$B$2:$B$5"));
        let forged = replace_part(
            &bytes,
            "xl/charts/chart1.xml",
            "<c:v>12</c:v>",
            "<c:v>999</c:v>",
        );
        assert_eq!(
            projection(&forged)["sections"][0]["blocks"][1]["series"][0]["values"][0],
            12.
        );
        let edited = replace_part(
            &bytes,
            "xl/worksheets/sheet1.xml",
            "<c r=\"B2\"><v>12</v></c>",
            "<c r=\"B2\"><v>18</v></c>",
        );
        assert_eq!(
            projection(&edited)["sections"][0]["blocks"][1]["series"][0]["values"][0],
            18.
        );
    }
    #[test]
    fn unsupported_or_nonlocal_charts_are_omitted_with_a_truncation_notice() {
        let bytes = generate(&arguments());
        for (from, to) in [
            ("$B$2:$B$5", "$B$2:$B$6"),
            ("clustered", "stacked"),
            ("<c:barDir val=\"col\"/>", "<c:barDir val=\"bar\"/>"),
            (
                "&apos;Team&apos;&apos;s café&apos;!$B$2:$B$5",
                "&apos;Elsewhere&apos;!$B$2:$B$5",
            ),
        ] {
            let changed = replace_part(&bytes, "xl/charts/chart1.xml", from, to);
            let (preview, truncated) =
                super::super::office_preview::preview(&changed, "xlsx").unwrap();
            assert!(truncated);
            assert_eq!(
                serde_json::to_value(preview).unwrap()["sections"][0]["blocks"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        }
        let hidden = replace_part(
            &bytes,
            "xl/worksheets/sheet1.xml",
            "<row r=\"2\">",
            "<row r=\"2\" hidden=\"1\">",
        );
        assert!(
            super::super::office_preview::preview(&hidden, "xlsx")
                .unwrap()
                .1
        );
        let external = replace_part(
            &bytes,
            "xl/charts/chart1.xml",
            "$B$2:$B$5",
            "[other.xlsx]$B$2:$B$5",
        );
        assert!(super::super::artifacts::check_office(&external, "xlsx").is_err());
    }
    #[test]
    fn bad_chart_inputs_fail_before_any_output_is_placed() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        for field in ["categories", "series"] {
            let mut args = arguments();
            if field == "categories" {
                args["sheets"][0]["charts"][0][field] = json!("A2:B4");
            } else {
                args["sheets"][0]["charts"][0][field][0]["values"] = json!("A2:A5");
            }
            assert!(super::super::office_authoring::prepare(
                "create-spreadsheet",
                &args,
                &workspace
            )
            .is_err());
            assert!(!workspace.join("reports").exists());
        }
        let mut args = arguments();
        let first = args["sheets"][0]["charts"][0].clone();
        args["sheets"][0]["charts"]
            .as_array_mut()
            .unwrap()
            .push(first);
        assert!(
            super::super::office_authoring::prepare("create-spreadsheet", &args, &workspace)
                .is_err()
        );
        assert!(!workspace.join("reports").exists());
        let mut args = arguments();
        let first = args["sheets"][0].clone();
        args["sheets"] = Value::Array(vec![first; 5]);
        for (index, sheet) in args["sheets"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            sheet["name"] = json!(format!("Sheet {index}"));
        }
        assert!(
            super::super::office_authoring::prepare("create-spreadsheet", &args, &workspace)
                .err()
                .unwrap()
                .contains("eight charts")
        );
        assert!(!workspace.join("reports").exists());
        assert!(super::column_range("A1:A25").is_err());
    }
    #[test]
    #[ignore = "explicit native XLSX/preview export for independent reader and UI acceptance"]
    fn native_chart_export_acceptance() {
        let directory = std::path::PathBuf::from(
            std::env::var_os("MIVLET_CHART_QA_OUTPUT").expect("explicit output directory"),
        );
        assert!(directory.is_absolute());
        fs::create_dir_all(&directory).unwrap();
        let bytes = generate(&arguments());
        fs::write(directory.join("native-charts.xlsx"), &bytes).unwrap();
        fs::write(
            directory.join("native-preview.json"),
            serde_json::to_vec_pretty(&projection(&bytes)).unwrap(),
        )
        .unwrap();
        let mut rows = vec![json!(["Category", "One", "Two", "Three"])];
        rows.extend((0..24).map(|index| {
            json!([
                format!("{} {index}", "Long category ".repeat(4)),
                if index % 2 == 0 { 1e12 } else { -1e12 },
                index * 1000,
                0
            ])
        }));
        let stress = json!({"path":"reports/stress.xlsx","sheets":[{"name":"Full bounds", "rows":rows,
            "charts":[{"title":"Full signed range", "type":"column","categories":"A2:A25", "series":[
                {"name":"A long series name that still fits the native eighty character bound", "values":"B2:B25"},
                {"name":"Second series", "values":"C2:C25"},{"name":"Zero series", "values":"D2:D25"}]}]}]});
        let bytes = generate(&stress);
        fs::write(directory.join("native-stress.xlsx"), &bytes).unwrap();
        fs::write(
            directory.join("native-stress-preview.json"),
            serde_json::to_vec_pretty(&projection(&bytes)).unwrap(),
        )
        .unwrap();
    }
}
