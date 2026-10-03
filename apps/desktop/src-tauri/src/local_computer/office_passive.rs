//! Passive Office publication requires inspecting content XML as well as ZIP
//! parts and relationships. Word fields and slide actions can have effects;
//! Excel functions are restricted to local calculations with no external refs.
use quick_xml::{events::Event, Reader, XmlVersion};

const REJECTION: &str = "Publish a passive Office copy without dynamic fields, actions, external references or unsupported formulas.";

fn local_formula(formula: &str) -> bool {
    if formula.len() > 8_000 {
        return false;
    }
    let chars = formula.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_control() && !ch.is_whitespace() {
            return false;
        }
        if ch == '"' || ch == '\'' {
            let quote = ch;
            index += 1;
            let start = index;
            loop {
                if index >= chars.len() {
                    return false;
                }
                if chars[index] == quote {
                    if chars.get(index + 1) == Some(&quote) {
                        index += 2;
                        continue;
                    }
                    break;
                }
                index += 1;
            }
            if quote == '\''
                && (chars[start..index]
                    .iter()
                    .any(|c| matches!(c, '[' | ']' | '|' | ':' | '\\' | '/'))
                    || chars.get(index + 1) != Some(&'!'))
            {
                return false;
            }
            index += 1;
        } else if matches!(ch, '[' | ']' | '|' | '\\' | '@') {
            return false;
        } else if ch.is_alphabetic() || ch == '_' {
            let start = index;
            while index < chars.len()
                && (chars[index].is_alphanumeric() || matches!(chars[index], '_' | '.'))
            {
                index += 1;
            }
            let name = chars[start..index]
                .iter()
                .collect::<String>()
                .to_ascii_uppercase();
            let next = chars[index..].iter().find(|c| !c.is_whitespace());
            if next == Some(&'(') {
                let name = name.strip_prefix("_XLFN.").unwrap_or(&name);
                if !matches!(
                    name,
                    "SUM"
                        | "SUMIF"
                        | "SUMIFS"
                        | "SUMPRODUCT"
                        | "AVERAGE"
                        | "AVERAGEIF"
                        | "AVERAGEIFS"
                        | "MIN"
                        | "MAX"
                        | "COUNT"
                        | "COUNTA"
                        | "COUNTBLANK"
                        | "COUNTIF"
                        | "COUNTIFS"
                        | "IF"
                        | "IFS"
                        | "IFERROR"
                        | "IFNA"
                        | "AND"
                        | "OR"
                        | "NOT"
                        | "TRUE"
                        | "FALSE"
                        | "ABS"
                        | "ROUND"
                        | "ROUNDUP"
                        | "ROUNDDOWN"
                        | "INT"
                        | "MOD"
                        | "POWER"
                        | "SQRT"
                        | "CEILING"
                        | "FLOOR"
                        | "SIGN"
                        | "PI"
                        | "EXP"
                        | "LN"
                        | "LOG"
                        | "LOG10"
                        | "STDEV"
                        | "STDEV.S"
                        | "STDEV.P"
                        | "VAR"
                        | "VAR.S"
                        | "VAR.P"
                        | "MEDIAN"
                        | "LEFT"
                        | "RIGHT"
                        | "MID"
                        | "LEN"
                        | "TRIM"
                        | "UPPER"
                        | "LOWER"
                        | "PROPER"
                        | "CONCAT"
                        | "CONCATENATE"
                        | "TEXTJOIN"
                        | "TEXT"
                        | "VALUE"
                        | "SUBSTITUTE"
                        | "REPLACE"
                        | "FIND"
                        | "SEARCH"
                        | "CHAR"
                        | "UNICHAR"
                        | "EXACT"
                        | "DATE"
                        | "YEAR"
                        | "MONTH"
                        | "DAY"
                        | "DAYS"
                        | "WEEKDAY"
                        | "EDATE"
                        | "EOMONTH"
                        | "TIME"
                        | "HOUR"
                        | "MINUTE"
                        | "SECOND"
                        | "TODAY"
                        | "NOW"
                        | "INDEX"
                        | "MATCH"
                        | "VLOOKUP"
                        | "HLOOKUP"
                        | "XLOOKUP"
                        | "ROW"
                        | "COLUMN"
                        | "ROWS"
                        | "COLUMNS"
                        | "ISNUMBER"
                        | "ISTEXT"
                        | "ISBLANK"
                        | "ISERROR"
                        | "ISNA"
                ) {
                    return false;
                }
            }
        } else {
            index += 1;
        }
    }
    true
}

pub(super) fn check(
    xml: &[u8],
    spreadsheet: bool,
    remaining_nodes: &mut usize,
) -> Result<(), String> {
    let mut reader = Reader::from_reader(xml);
    let mut capture = None;
    let mut formula = String::new();
    loop {
        let event = reader.read_event().map_err(|_| REJECTION)?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                *remaining_nodes = remaining_nodes.checked_sub(1).ok_or(REJECTION)?;
                let local = element.local_name();
                let name = local.as_ref();
                if matches!(
                    name,
                    "fldSimple"
                        | "fldChar"
                        | "instrText"
                        | "altChunk"
                        | "hlinkClick"
                        | "hlinkMouseOver"
                        | "oleObj"
                        | "OLEObject"
                        | "object"
                        | "attachedTemplate"
                        | "externalData"
                        | "webPr"
                        | "queryTable"
                        | "connection"
                ) {
                    return Err(REJECTION.into());
                }
                if spreadsheet
                    && matches!(
                        name,
                        "f" | "definedName"
                            | "formula"
                            | "formula1"
                            | "formula2"
                            | "calculatedColumnFormula"
                            | "totalsRowFormula"
                    )
                {
                    if capture.is_some() {
                        return Err(REJECTION.into());
                    }
                    if name == "definedName" {
                        for attribute in element.attributes().with_checks(true) {
                            let attribute = attribute.map_err(|_| REJECTION)?;
                            if attribute.key.local_name().as_ref() == "name"
                                && attribute
                                    .normalized_value(XmlVersion::Implicit1_0)
                                    .map_err(|_| REJECTION)?
                                    .to_ascii_lowercase()
                                    .contains("auto_")
                            {
                                return Err(REJECTION.into());
                            }
                        }
                    }
                    capture = if empty { None } else { Some(name.to_string()) };
                    formula.clear();
                }
            }
            Event::End(element) => {
                if capture.as_deref() == Some(element.local_name().as_ref()) {
                    if !local_formula(&formula) {
                        return Err(REJECTION.into());
                    }
                    capture = None;
                }
            }
            Event::Text(text) if capture.is_some() => {
                formula.push_str(&text.xml_content(XmlVersion::Implicit1_0))
            }
            Event::CData(text) if capture.is_some() => {
                formula.push_str(&text.xml_content(XmlVersion::Implicit1_0))
            }
            Event::GeneralRef(reference) if capture.is_some() => {
                if let Some(character) = reference.resolve_char_ref().map_err(|_| REJECTION)? {
                    formula.push(character);
                } else {
                    formula.push_str(
                        &quick_xml::escape::unescape(&format!(
                            "&{};",
                            reference.xml_content(XmlVersion::Implicit1_0)
                        ))
                        .map_err(|_| REJECTION)?,
                    );
                }
            }
            Event::DocType(_) => return Err(REJECTION.into()),
            Event::Eof => {
                return if capture.is_none() {
                    Ok(())
                } else {
                    Err(REJECTION.into())
                }
            }
            _ => {}
        }
        if formula.len() > 8_000 {
            return Err(REJECTION.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permits_local_calculation_and_literal_text_without_external_or_unknown_functions() {
        for formula in [
            "SUM(B2:B3)",
            "IF(A1>0,\"https://example.test/a[1]\",0)",
            "SUM('Sheet 2'!A1:A3)",
            "_xlfn.XLOOKUP(A1,B1:B10,C1:C10)",
        ] {
            assert!(local_formula(formula), "{formula}");
        }
        for formula in [
            "WEBSERVICE(\"https://example.test/\")",
            "_xlfn.IMAGE(A1)",
            "RTD(\"example\",,1)",
            "CALL(A1)",
            "INDIRECT(A1)",
            "SUM('[external.xlsx]Sheet'!A1)",
            "program|'arg'!A1",
            "unknown .func(A1)",
        ] {
            assert!(!local_formula(formula), "{formula}");
        }
    }
    #[test]
    fn validates_decoded_xml_and_rejects_fields_actions_dtd_and_exhaustion() {
        for xml in [
            "<w:fldSimple xmlns:w='word' w:instr='DDEAUTO example'/>",
            "<w:instrText xmlns:w='word'>DDEAUTO</w:instrText>",
            "<a:hlinkClick xmlns:a='drawing' action='ppaction://program'/>",
            "<worksheet><f>WEB&#83;ERVICE(\"https://example.test\")</f></worksheet>",
            "<worksheet><formula1>WEBSERVICE(\"https://example.test\")</formula1></worksheet>",
            "<table><calculatedColumnFormula>CALL(A1)</calculatedColumnFormula></table>",
            "<!DOCTYPE root><root/>",
        ] {
            assert!(check(xml.as_bytes(), true, &mut 100).is_err());
        }
        assert!(check(
            b"<root><f>SUM(A1:A2)</f><t>WEBSERVICE is ordinary text here</t></root>",
            true,
            &mut 100
        )
        .is_ok());
        assert!(check(
            b"<root><f t='shared' si='0'/><f>SUM(A1:A2)</f></root>",
            true,
            &mut 100
        )
        .is_ok());
        assert!(check(
            b"<root><definedName name='_xlnm.Auto_Open'>A1</definedName></root>",
            true,
            &mut 100
        )
        .is_err());
        assert!(check(b"<root><child/></root>", false, &mut 1).is_err());
    }
}
