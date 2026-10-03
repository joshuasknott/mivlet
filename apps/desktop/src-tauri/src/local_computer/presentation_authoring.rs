//! Declarative, editable 16:9 slides. No scripts, links, media or Office automation.
use super::office_authoring::{escape_xml, root_relationships, validate_document_text, zip_files};
use serde::Deserialize;
use serde_json::Value;

const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Presentation {
    path: String,
    title: String,
    #[serde(default)]
    theme: Theme,
    slides: Vec<Slide>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    #[default]
    Light,
    Dark,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Slide {
    title: String,
    body: Option<String>,
    #[serde(default)]
    bullets: Vec<String>,
}

pub(super) fn create(arguments: &Value) -> Result<(String, Vec<u8>), String> {
    let request: Presentation = serde_json::from_value(arguments.clone())
        .map_err(|_| "Presentation fields do not match the bounded authoring contract.")?;
    validate_document_text(&request.title, 160)?;
    if request.slides.is_empty() || request.slides.len() > 30 {
        return Err("A presentation needs between 1 and 30 slides.".into());
    }
    for slide in &request.slides {
        validate_document_text(&slide.title, 120)?;
        if let Some(body) = &slide.body {
            validate_document_text(body, 600)?;
        }
        if slide.bullets.len() > 5 {
            return Err("Use at most five short bullets per slide.".into());
        }
        for bullet in &slide.bullets {
            validate_document_text(bullet, 120)?;
        }
        // Newlines and wrapping consume layout space; reject overfull input
        // rather than quietly cutting text from the delivered file.
        let lines = slide
            .body
            .iter()
            .chain(slide.bullets.iter())
            .map(|text| {
                text.lines()
                    .map(|line| line.chars().count().max(1).div_ceil(60))
                    .sum::<usize>()
                    + 1
            })
            .sum::<usize>();
        if lines > 17 {
            return Err("This slide is too dense. Split its content into another slide.".into());
        }
    }
    let mut content_types = String::from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/></Types>");
    let mut slide_ids = String::new();
    let mut relationships = vec![(
        "rId1".into(),
        "slideMaster",
        "slideMasters/slideMaster1.xml".into(),
    )];
    content_types = content_types.replace("</Types>", "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>");
    let root_rels = root_relationships("ppt/presentation.xml").replace("</Relationships>", "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>");
    let mut parts = vec![
        (
            "_rels/.rels".into(),
            root_rels,
        ),
        ("docProps/core.xml".into(), format!("<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title></cp:coreProperties>", escape_xml(&request.title))),
        ("ppt/slideMasters/slideMaster1.xml".into(), master()),
        (
            "ppt/slideMasters/_rels/slideMaster1.xml.rels".into(),
            rels(&[
                (
                    "rId1".into(),
                    "slideLayout",
                    "../slideLayouts/slideLayout1.xml".into(),
                ),
                ("rId2".into(), "theme", "../theme/theme1.xml".into()),
            ]),
        ),
        ("ppt/slideLayouts/slideLayout1.xml".into(), layout()),
        (
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(),
            rels(&[(
                "rId1".into(),
                "slideMaster",
                "../slideMasters/slideMaster1.xml".into(),
            )]),
        ),
        ("ppt/theme/theme1.xml".into(), theme()),
    ];
    for (index, slide) in request.slides.iter().enumerate() {
        let number = index + 1;
        let relationship = format!("rId{}", number + 1);
        slide_ids.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"{relationship}\"/>",
            255 + number
        ));
        relationships.push((relationship, "slide", format!("slides/slide{number}.xml")));
        let entry = format!("<Override PartName=\"/ppt/slides/slide{number}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>");
        content_types = content_types.replace("</Types>", &format!("{entry}</Types>"));
        parts.push((
            format!("ppt/slides/slide{number}.xml"),
            slide_xml(slide, number, &request.theme),
        ));
        parts.push((
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            rels(&[(
                "rId1".into(),
                "slideLayout",
                "../slideLayouts/slideLayout1.xml".into(),
            )]),
        ));
    }
    parts.push(("[Content_Types].xml".into(), content_types));
    parts.push((
        "ppt/_rels/presentation.xml.rels".into(),
        rels(&relationships),
    ));
    parts.push(("ppt/presentation.xml".into(), format!("<p:presentation xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\" type=\"screen16x9\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/><p:defaultTextStyle><a:defPPr><a:defRPr lang=\"en-US\"/></a:defPPr></p:defaultTextStyle></p:presentation>")));
    Ok((request.path, zip_files(parts)?))
}

fn rels(items: &[(String, &str, String)]) -> String {
    let mut xml = String::from(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    for (id, kind, target) in items {
        xml.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{R}/{kind}\" Target=\"{target}\"/>"
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

fn group() -> &'static str {
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
}

fn paragraph(text: &str, size: usize, color: &str, bullet: bool, bold: bool) -> String {
    let marker = if bullet {
        "<a:buChar char=\"•\"/>"
    } else {
        "<a:buNone/>"
    };
    let indent = if bullet {
        " marL=\"228600\" indent=\"-228600\""
    } else {
        ""
    };
    // a:br keeps explicit line breaks within one paragraph.
    let runs = text.split('\n').map(|line| format!("<a:r><a:rPr lang=\"en-US\" sz=\"{size}\" b=\"{}\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:latin typeface=\"Aptos\"/></a:rPr><a:t>{}</a:t></a:r>", u8::from(bold), escape_xml(line))).collect::<Vec<_>>().join("<a:br/>");
    format!("<a:p><a:pPr{indent}><a:lnSpc><a:spcPct val=\"110000\"/></a:lnSpc><a:spcAft><a:spcPts val=\"800\"/></a:spcAft>{marker}</a:pPr>{runs}<a:endParaRPr lang=\"en-US\" sz=\"{size}\"/></a:p>")
}

fn shape(id: usize, name: &str, y: usize, height: usize, paragraphs: &str) -> String {
    format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"685800\" y=\"{y}\"/><a:ext cx=\"10820400\" cy=\"{height}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>")
}

fn slide_xml(slide: &Slide, number: usize, theme: &Theme) -> String {
    let (background, ink, muted) = match theme {
        Theme::Light => ("F7F8FA", "17212E", "566577"),
        Theme::Dark => ("17212E", "F7F8FA", "BCC9D8"),
    };
    let title = shape(
        2,
        "Title",
        457200,
        1005840,
        &paragraph(&slide.title, 3000, ink, false, true),
    );
    let mut body = slide
        .body
        .iter()
        .map(|text| paragraph(text, 2000, ink, false, false))
        .collect::<String>();
    for text in &slide.bullets {
        body.push_str(&paragraph(text, 2000, ink, true, false));
    }
    if body.is_empty() {
        body = "<a:p/>".into();
    }
    let body = shape(3, "Content", 1645920, 4434840, &body);
    let footer = shape(
        4,
        "Slide number",
        6355080,
        274320,
        &paragraph(&number.to_string(), 1100, muted, false, false),
    );
    format!("<p:sld xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{background}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{}{title}{body}{footer}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>", group())
}

fn master() -> String {
    format!("<p:sldMaster xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\"><p:cSld name=\"Mivlet\"><p:spTree>{}</p:spTree></p:cSld><p:clrMap accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" bg1=\"lt1\" bg2=\"lt2\" folHlink=\"folHlink\" hlink=\"hlink\" tx1=\"dk1\" tx2=\"dk2\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>", group())
}

fn layout() -> String {
    format!("<p:sldLayout xmlns:a=\"{A}\" xmlns:r=\"{R}\" xmlns:p=\"{P}\" type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>", group())
}

fn theme() -> String {
    let colors = [
        ("dk1", "17212E"),
        ("lt1", "FFFFFF"),
        ("dk2", "566577"),
        ("lt2", "F7F8FA"),
        ("accent1", "3468C0"),
        ("accent2", "45856A"),
        ("accent3", "B17837"),
        ("accent4", "8664A6"),
        ("accent5", "35879B"),
        ("accent6", "BC5967"),
        ("hlink", "3468C0"),
        ("folHlink", "8664A6"),
    ]
    .iter()
    .map(|(name, color)| format!("<a:{name}><a:srgbClr val=\"{color}\"/></a:{name}>"))
    .collect::<String>();
    let fonts = "<a:majorFont><a:latin typeface=\"Aptos Display\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Aptos\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont>";
    let fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
    let line = "<a:ln w=\"9525\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>";
    format!("<a:theme xmlns:a=\"{A}\" name=\"Mivlet\"><a:themeElements><a:clrScheme name=\"Mivlet\">{colors}</a:clrScheme><a:fontScheme name=\"Aptos\">{fonts}</a:fontScheme><a:fmtScheme name=\"Mivlet\"><a:fillStyleLst>{fill}{fill}{fill}</a:fillStyleLst><a:lnStyleLst>{line}{line}{line}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>{fill}{fill}{fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn slides_are_editable_passive_packages_with_escaped_text_and_real_bullets() {
        let (_, bytes) = create(&serde_json::json!({"path":"deck.pptx","title":"Review","theme":"dark","slides":[{"title":"A & B","body":"<untrusted>\nSecond line","bullets":["One","Two"]}]})).unwrap();
        assert!(super::super::artifacts::check_office(&bytes, "pptx").unwrap());
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut slide = String::new();
        zip.by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut slide)
            .unwrap();
        assert!(slide.contains("A &amp; B"));
        assert!(slide.contains("&lt;untrusted&gt;"));
        assert!(slide.contains("<a:buChar char=\"•\"/>"));
        assert!(slide.contains("<a:br/>"));
        assert!(slide.contains("17212E"));
        // Optional local QA handoff to an independent Office reader. The
        // runner selects the output path; this branch is compiled only in tests.
        if let Ok(directory) = std::env::var("MIVLET_OFFICE_QA_OUTPUT") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(std::path::Path::new(&directory).join("review.pptx"), &bytes).unwrap();
        }
    }

    #[test]
    fn dense_unsafe_and_unknown_content_is_rejected_without_dropping_text() {
        for slide in [
            serde_json::json!({"title":"Title", "body":"line\n".repeat(30)}),
            serde_json::json!({"title":"bad\u{0}"}),
            serde_json::json!({"title":"Title", "html":"<script/>"}),
            serde_json::json!({"title":"Title", "bullets":vec!["bullet";6]}),
        ] {
            assert!(create(
                &serde_json::json!({"path":"deck.pptx","title":"Review","slides":[slide]})
            )
            .is_err());
        }
    }
}
