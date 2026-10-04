//! Chart projections resolve local worksheet cells, never untrusted chart caches.
use super::{part, relationships, Block, Budget, Node};
use serde::Serialize;
use std::{collections::HashMap, io::Cursor};

#[derive(Debug, Serialize)]
pub(super) struct Series {
    name: String,
    values: Vec<f64>,
}

fn relation_part(path: &str) -> Option<(String, &str)> {
    let (base, file) = path.rsplit_once('/')?;
    Some((format!("{base}/_rels/{file}.rels"), base))
}

fn source_range(formula: &str, sheet: &str) -> Option<(usize, usize, usize)> {
    let prefix = format!("'{}'!", sheet.replace('\'', "''"));
    // Exact sheet-name equality excludes other workbooks, sheets and URI formulas.
    let range = formula
        .strip_prefix(&prefix)
        .or_else(|| formula.strip_prefix(&format!("{sheet}!")))?;
    super::super::spreadsheet_charts::column_range(&range.replace('$', "")).ok()
}

fn cell_value(cell: &Node, strings: &[String]) -> Option<String> {
    let cached = cell
        .find("v")
        .first()
        .map(|v| v.value())
        .unwrap_or_default();
    match cell.attribute("t") {
        "inlineStr" => Some(cell.find("t").iter().map(|t| t.value()).collect()),
        "s" => strings.get(cached.parse::<usize>().ok()?).cloned(),
        "" | "n" | "str" => Some(cached),
        _ => None,
    }
}

fn read_chart(
    root: &Node,
    sheet: &str,
    cells: &HashMap<String, &Node>,
    strings: &[String],
    budget: &mut Budget,
) -> Option<Block> {
    let plot = root.find("plotArea");
    let plot = *plot.first()?;
    let candidates = plot
        .children
        .iter()
        .filter(|node| node.name.ends_with("Chart"))
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return None;
    }
    let chart = candidates[0];
    let kind = match chart.name.as_str() {
        "barChart"
            if chart.find("barDir").first()?.attribute("val") == "col"
                && chart.find("grouping").first()?.attribute("val") == "clustered" =>
        {
            "column"
        }
        "lineChart"
            if chart.find("grouping").first()?.attribute("val") == "standard"
                && !chart
                    .find("smooth")
                    .iter()
                    .any(|node| node.attribute("val") != "0") =>
        {
            "line"
        }
        _ => return None,
    };
    // Custom scaling/secondary axes/hidden rows would change the picture.
    if !root.find("min").is_empty()
        || !root.find("max").is_empty()
        || !root.find("logBase").is_empty()
        || root.find("catAx").len() != 1
        || root.find("valAx").len() != 1
        || root
            .find("orientation")
            .iter()
            .any(|node| node.attribute("val") != "minMax")
    {
        return None;
    }
    let source = chart.find("ser");
    if source.is_empty() || source.len() > 3 {
        return None;
    }
    let mut categories: Option<Vec<String>> = None;
    let mut series = Vec::new();
    for item in source {
        let cat = item.find("cat");
        let category_formula = cat.first()?.find("f");
        if category_formula.len() != 1 {
            return None;
        }
        let range = source_range(&category_formula[0].value(), sheet)?;
        let labels = (range.0..=range.1)
            .map(|row| {
                let key = super::super::office_authoring::cell_reference(row, range.2);
                let value = cell_value(cells.get(&key)?, strings)?;
                (value.chars().count() <= 80 && !value.trim().is_empty()).then_some(value)
            })
            .collect::<Option<Vec<_>>>()?;
        if categories.as_ref().is_some_and(|prior| prior != &labels) {
            return None;
        }
        let val = item.find("val");
        let value_formula = val.first()?.find("f");
        if value_formula.len() != 1 {
            return None;
        }
        let range = source_range(&value_formula[0].value(), sheet)?;
        if range.1 - range.0 + 1 != labels.len() {
            return None;
        }
        let values = (range.0..=range.1)
            .map(|row| {
                let key = super::super::office_authoring::cell_reference(row, range.2);
                let cell = *cells.get(&key)?;
                if !matches!(cell.attribute("t"), "" | "n") {
                    return None;
                }
                let value = cell_value(cell, strings)?.parse::<f64>().ok()?;
                (value.is_finite() && value.abs() <= 1_000_000_000_000f64).then_some(value)
            })
            .collect::<Option<Vec<_>>>()?;
        let tx = item.find("tx");
        // Arbitrary series-name references/literal caches are omitted, not guessed.
        let name = tx
            .first()?
            .children
            .iter()
            .find(|node| node.name == "v")?
            .value();
        if name.trim().is_empty() || name.chars().count() > 80 {
            return None;
        }
        series.push(Series {
            name: budget.text(&name),
            values,
        });
        categories = Some(labels);
    }
    let title = root
        .find("title")
        .first()?
        .find("t")
        .iter()
        .map(|node| node.value())
        .collect::<String>();
    if title.trim().is_empty() || title.chars().count() > 120 {
        return None;
    }
    Some(Block::Chart {
        kind,
        title: budget.text(&title),
        categories: categories?.iter().map(|value| budget.text(value)).collect(),
        series,
    })
}

pub(super) fn extract(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    root: &Node,
    sheet_path: &str,
    sheet: &str,
    strings: &[String],
    budget: &mut Budget,
) -> Vec<Block> {
    let mut output = Vec::new();
    let drawings = root.find("drawing");
    if drawings.is_empty() {
        return output;
    }
    let extract =
        |archive: &mut zip::ZipArchive<Cursor<&[u8]>>, budget: &mut Budget| -> Option<Vec<Block>> {
            if drawings.len() != 1
                || root
                    .find("row")
                    .iter()
                    .any(|row| matches!(row.attribute("hidden"), "1" | "true"))
                || root
                    .find("col")
                    .iter()
                    .any(|col| matches!(col.attribute("hidden"), "1" | "true"))
            {
                return None;
            }
            let (rel_path, base) = relation_part(sheet_path)?;
            let rels = relationships(&part(archive, &rel_path)?, base);
            let drawing_path = rels.get(drawings[0].attribute("id"))?;
            if !drawing_path.starts_with("xl/drawings/") {
                return None;
            }
            let drawing = part(archive, drawing_path)?;
            let (rel_path, base) = relation_part(drawing_path)?;
            let rels = relationships(&part(archive, &rel_path)?, base);
            let references = drawing.find("chart");
            budget.truncated |= references.len() > 2;
            let mut cells = HashMap::new();
            for cell in root.find("c") {
                if cells
                    .insert(cell.attribute("r").to_string(), cell)
                    .is_some()
                {
                    return None;
                }
            }
            let mut blocks = Vec::new();
            for reference in references.iter().take(2) {
                let block = rels
                    .get(reference.attribute("id"))
                    .filter(|path| path.starts_with("xl/charts/"))
                    .and_then(|path| part(archive, path))
                    .and_then(|chart| read_chart(&chart, sheet, &cells, strings, budget));
                if let Some(block) = block {
                    blocks.push(block);
                } else {
                    budget.truncated = true;
                }
            }
            Some(blocks)
        };
    match extract(archive, budget) {
        Some(blocks) => output.extend(blocks),
        None => budget.truncated = true,
    }
    output
}
