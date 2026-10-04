use super::super::{artifacts, office_authoring, office_inspection, office_preview};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{fs, io::Read};

fn raster(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .add_text_chunk(
                "private-metadata".into(),
                "must not leave the source".into(),
            )
            .unwrap();
        let mut pixels = vec![255; width as usize * height as usize * 4];
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let x = index % width as usize;
            pixel.copy_from_slice(if x < width as usize / 2 {
                &[52, 104, 192, 255]
            } else {
                &[69, 133, 106, 180]
            });
        }
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&pixels)
            .unwrap();
    }
    bytes
}

fn source(bytes: &[u8], path: &str) -> Value {
    json!({"path":path, "sha256":hex::encode(Sha256::digest(bytes)), "alt":"Blue & green <sample>"})
}

fn deck(bytes: &[u8]) -> Value {
    json!({"path":"reports/pictures.pptx", "title":"Picture report", "slides":[
        {"title":"Results", "bullets":["Validated native snapshot", "The original stays unchanged"], "image":source(bytes,"chart.png")},
        {"title":"Full picture", "image":source(bytes,"chart.png")}
    ]})
}

fn package_part(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut output = Vec::new();
    zip.by_name(name).unwrap().read_to_end(&mut output).unwrap();
    output
}

fn rewrite(bytes: &[u8], name: &str, content: Vec<u8>) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut parts = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let path = entry.name().to_string();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        parts.push((
            path.clone(),
            if path == name { content.clone() } else { bytes },
        ));
    }
    office_authoring::zip_bytes(parts).unwrap()
}

fn sample_package() -> Vec<u8> {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = raster(16, 16);
    fs::write(temporary.path().join("chart.png"), &bytes).unwrap();
    super::super::presentation_authoring::create(&deck(&bytes), temporary.path())
        .unwrap()
        .1
}

#[test]
fn unsupported_picture_links_geometry_and_pixels_are_omitted_with_notice() {
    let bytes = sample_package();
    let rel_path = "ppt/slides/_rels/slide1.xml.rels";
    let rels = String::from_utf8(package_part(&bytes, rel_path)).unwrap();
    let slide_path = "ppt/slides/slide1.xml";
    let slide = String::from_utf8(package_part(&bytes, slide_path)).unwrap();
    let (prefix, picture) = slide.split_once("<p:pic>").unwrap();
    let malformed = [
        rewrite(&bytes, rel_path, rels.replace("../media/image1.png", "https://example.test/image.png").into_bytes()),
        rewrite(&bytes, rel_path, rels.replace("Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\"", "TargetMode=\"External\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\"").into_bytes()),
        rewrite(&bytes, rel_path, rels.replace("/relationships/image", "/relationships/slide").into_bytes()),
        rewrite(&bytes, rel_path, rels.replace("../media/image1.png", "../../../secret.png").into_bytes()),
        rewrite(&bytes, slide_path, format!("{prefix}<p:pic>{}",picture.replace("<a:blip r:embed=\"rId2\"/>","<a:blip r:embed=\"rId2\" r:link=\"link\"/>")).into_bytes()),
        rewrite(&bytes, slide_path, format!("{prefix}<p:pic>{}",picture.replace("<a:stretch>","<a:srcRect l=\"10000\"/><a:stretch>")).into_bytes()),
        rewrite(&bytes, slide_path, format!("{prefix}<p:pic>{}",picture.replace("<p:cNvPr id=\"5\"", "<p:cNvPr hidden=\"true\" id=\"5\"")).into_bytes()),
        rewrite(&bytes, slide_path, format!("{prefix}<p:pic>{}",picture.replace("<a:xfrm>","<a:xfrm rot=\"90000\">")).into_bytes()),
        rewrite(&bytes, "ppt/media/image1.png",b"\x89PNG\r\n\x1a\n".to_vec()),
    ];
    for input in malformed {
        let (projection, truncated) = office_preview::preview(&input, "pptx").unwrap();
        let value = serde_json::to_value(projection).unwrap();
        assert!(truncated);
        assert!(!value["sections"][0]["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["type"] == "image"));
        assert_eq!(value["sections"][0]["blocks"][0]["text"], "Results");
        // The unaffected second slide still has its independently decoded image.
        assert!(value["sections"][1]["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["type"] == "image"));
    }
}

#[test]
fn projection_picture_count_and_byte_budget_remain_bounded() {
    let bytes = sample_package();
    let path = "ppt/slides/slide1.xml";
    let slide = String::from_utf8(package_part(&bytes, path)).unwrap();
    let (_, tail) = slide.split_once("<p:pic>").unwrap();
    let picture = format!("<p:pic>{}</p:pic>", tail.split_once("</p:pic>").unwrap().0);
    let many = rewrite(
        &bytes,
        path,
        slide.replace(&picture, &picture.repeat(10)).into_bytes(),
    );
    let (projection, truncated) = office_preview::preview(&many, "pptx").unwrap();
    let projection = serde_json::to_value(projection).unwrap();
    let count = projection["sections"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|section| section["blocks"].as_array().unwrap())
        .filter(|block| block["type"] == "image")
        .count();
    assert_eq!(count, 8);
    assert!(truncated);
    // An incompressible raster exercises aggregate thumbnail bytes, independent
    // of count. Source/authoring limits remain unchanged.
    let mut seed = 17u32;
    let pixels = (0..512 * 512 * 4)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect::<Vec<_>>();
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 512, 512);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&pixels)
            .unwrap();
    }
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("chart.png"), &png).unwrap();
    let mut args = deck(&png);
    args["slides"] = json!(vec![args["slides"][1].clone(); 8]);
    let output = super::super::presentation_authoring::create(&args, temporary.path())
        .unwrap()
        .1;
    let (projection, truncated) = office_preview::preview(&output, "pptx").unwrap();
    let value = serde_json::to_value(projection).unwrap();
    let images = value["sections"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|section| section["blocks"].as_array().unwrap())
        .filter(|block| block["type"] == "image")
        .collect::<Vec<_>>();
    assert!(!images.is_empty());
    assert!(images.len() < 8);
    assert!(truncated);
    let bytes = images
        .iter()
        .map(|block| {
            STANDARD
                .decode(
                    block["dataUrl"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("data:image/png;base64,")
                        .unwrap(),
                )
                .unwrap()
                .len()
        })
        .sum::<usize>();
    assert!(bytes <= 4 * 1024 * 1024);
}

#[test]
fn complete_png_is_normalized_without_metadata_and_corruption_is_rejected() {
    let bytes = raster(256, 128);
    let picture = normalize(&bytes, "png", false).unwrap();
    assert_eq!((picture.width, picture.height), (256, 128));
    assert!(crate::media_images::validate_generated_png(&picture.bytes).is_ok());
    assert!(!picture
        .bytes
        .windows(16)
        .any(|window| window == b"private-metadata"));
    assert_ne!(bytes, picture.bytes);
    let decoded = decode(&picture.bytes, "png").unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(0, 0).0, [52, 104, 192, 255]);
    assert_eq!(decoded.get_pixel(255, 127).0, [69, 133, 106, 180]);
    let mut corrupt = bytes.clone();
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 1;
    for invalid in [
        &corrupt[..],
        &bytes[..bytes.len() - 12],
        b"\x89PNG\r\n\x1a\n",
        b"<svg/>",
    ] {
        assert!(normalize(invalid, "png", false).is_err());
    }
    let mut trailing = bytes.clone();
    trailing.extend_from_slice(b"private trailing payload");
    assert!(normalize(&trailing, "png", false).is_err());
    assert!(normalize(&bytes, "jpg", false).is_err());
    assert!(normalize(&bytes, "svg", false).is_err());
}

#[test]
fn jpeg_orientation_is_applied_before_metadata_free_embedding() {
    let rgb = image::RgbImage::from_pixel(40, 20, image::Rgb([200, 40, 30]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&rgb)
        .unwrap();
    // A standard little-endian EXIF IFD containing Orientation=6 (90 degrees).
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend_from_slice(b"\xff\xe1");
    oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend_from_slice(exif);
    oriented.extend_from_slice(&jpeg[2..]);
    let picture = normalize(&oriented, "jpg", false).unwrap();
    assert_eq!((picture.width, picture.height), (20, 40));
    assert!(!picture.bytes.windows(4).any(|window| window == b"Exif"));
    let result: Value = serde_json::from_str(&inspect(&oriented, "jpeg").unwrap()).unwrap();
    assert_eq!(result["width"], 20);
    assert_eq!(result["height"], 40);
    assert_eq!(result["sha256"], hex::encode(Sha256::digest(&oriented)));
    assert!(normalize(&jpeg[..jpeg.len() - 2], "jpg", false).is_err());
    assert!(normalize(b"\xff\xd8\xff\xd9", "jpg", false).is_err());
}

#[test]
fn strict_byte_pixel_dimension_and_encoding_limits_apply() {
    assert!(normalize(&vec![0; MAX_IMAGE_BYTES + 1], "png", false).is_err());
    assert!(normalize(&raster(4097, 1), "png", false).is_err());
    assert!(normalize(&raster(4096, 1025), "png", false).is_err());
    let thumbnail = normalize(&raster(1024, 512), "png", true).unwrap();
    assert_eq!((thumbnail.width, thumbnail.height), (512, 256));
    let mut bounded = BoundedPng(Vec::new());
    assert!(bounded.write_all(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    assert!(bounded.0.is_empty());
}

#[test]
fn picture_deck_is_editable_passive_and_ui_only_with_preserved_sources() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let source_bytes = raster(256, 128);
    fs::write(workspace.join("chart.png"), &source_bytes).unwrap();
    let args = deck(&source_bytes);
    let prepared = office_authoring::prepare("create-presentation", &args, &workspace).unwrap();
    prepared.commit().unwrap();
    let output = fs::read(workspace.join("reports/pictures.pptx")).unwrap();
    assert!(artifacts::check_office(&output, "pptx").unwrap());
    assert_eq!(fs::read(workspace.join("chart.png")).unwrap(), source_bytes);
    assert!(office_authoring::prepare("create-presentation", &args, &workspace).is_err());
    let slide = String::from_utf8(package_part(&output, "ppt/slides/slide1.xml")).unwrap();
    assert!(slide.contains("descr=\"Blue &amp; green &lt;sample&gt;\""));
    assert!(slide.contains("r:embed=\"rId2\""));
    let embedded = package_part(&output, "ppt/media/image1.png");
    assert!(!embedded
        .windows(16)
        .any(|window| window == b"private-metadata"));
    let (preview, truncated) = office_preview::preview(&output, "pptx").unwrap();
    assert!(!truncated);
    let projection = serde_json::to_value(preview).unwrap();
    let image = projection["sections"][0]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "image")
        .unwrap();
    assert_eq!(image["alt"], "Blue & green <sample>");
    assert_eq!(
        STANDARD
            .decode(
                image["dataUrl"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("data:image/png;base64,")
                    .unwrap()
            )
            .unwrap(),
        embedded
    );
    let extraction = office_inspection::inspect(&output, "pptx").unwrap();
    assert!(!extraction.contains("base64"));
    assert!(!extraction.contains("dataUrl"));
    assert!(extraction.contains("Image omitted: Blue & green <sample>"));
    let extraction: Value = serde_json::from_str(&extraction).unwrap();
    assert_eq!(extraction["truncated"], true);
    let read = crate::tools::run_read_file(&json!({"path":"chart.png"}), &workspace).unwrap();
    let read: Value = serde_json::from_str(&read.output).unwrap();
    assert_eq!(read["sha256"], args["slides"][0]["image"]["sha256"]);
    assert!(!read.to_string().contains("base64"));
    if let Ok(directory) = std::env::var("MIVLET_OFFICE_QA_OUTPUT") {
        fs::create_dir_all(&directory).unwrap();
        fs::write(Path::new(&directory).join("pictures.pptx"), &output).unwrap();
        fs::write(
            Path::new(&directory).join("pictures-preview.json"),
            serde_json::to_vec(&projection).unwrap(),
        )
        .unwrap();
        fs::write(
            Path::new(&directory).join("picture-source.png"),
            &source_bytes,
        )
        .unwrap();
    }
}

#[test]
fn changed_sources_escape_paths_unknown_fields_and_dense_image_slides_fail_before_output() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let bytes = raster(16, 16);
    fs::write(workspace.join("chart.png"), &bytes).unwrap();
    fs::write(temporary.path().join("outside.png"), &bytes).unwrap();
    for (field, value) in [
        ("sha256", json!("0".repeat(64))),
        ("sha256", json!("a".repeat(63))),
        ("path", json!("../outside.png")),
        ("path", json!("/outside.png")),
        ("path", json!("C:/outside.png")),
        ("path", json!("https://example.test/x.png")),
        ("alt", json!("\u{0}")),
        ("alt", json!("")),
        ("script", json!("active")),
    ] {
        let mut args = deck(&bytes);
        args["slides"][0]["image"][field] = value;
        assert!(
            office_authoring::prepare("create-presentation", &args, &workspace).is_err(),
            "{field}"
        );
        assert!(!workspace.join("reports").exists());
    }
    let mut dense = deck(&bytes);
    dense["slides"][0]["body"] = json!("a".repeat(600));
    assert!(office_authoring::prepare("create-presentation", &dense, &workspace).is_err());
    let mut many = deck(&bytes);
    many["slides"] = json!(vec![many["slides"][0].clone(); 9]);
    assert!(office_authoring::prepare("create-presentation", &many, &workspace).is_err());
    fs::write(workspace.join("chart.png"), raster(20, 20)).unwrap();
    assert!(office_authoring::prepare("create-presentation", &deck(&bytes), &workspace).is_err());
    assert!(!workspace.join("reports").exists());
}

#[test]
fn captured_bytes_survive_later_source_changes_but_stop_prevents_placement() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let bytes = raster(16, 16);
    fs::write(workspace.join("chart.png"), &bytes).unwrap();
    let prepared =
        office_authoring::prepare("create-presentation", &deck(&bytes), &workspace).unwrap();
    fs::write(workspace.join("chart.png"), raster(20, 20)).unwrap();
    prepared.commit().unwrap();
    let output = fs::read(workspace.join("reports/pictures.pptx")).unwrap();
    let embedded = decode(&package_part(&output, "ppt/media/image1.png"), "png").unwrap();
    assert_eq!((embedded.width(), embedded.height()), (16, 16));
    let authority_root = tempfile::tempdir().unwrap();
    let authority =
        super::super::authority::ComputerAuthority::load(authority_root.path()).unwrap();
    let generation = authority.snapshot().unwrap().generation;
    let ticket = authority.begin_agent(generation).unwrap();
    fs::write(workspace.join("chart.png"), &bytes).unwrap();
    let mut args = deck(&bytes);
    args["path"] = json!("cancelled.pptx");
    let prepared = office_authoring::prepare("create-presentation", &args, &workspace).unwrap();
    authority.revoke(generation).unwrap();
    assert!(ticket.commit(|| prepared.commit()).is_err());
    assert!(!workspace.join("cancelled.pptx").exists());
    assert!(temporary.path().read_dir().unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("office-author-")));
}

#[cfg(windows)]
#[test]
fn linked_or_open_for_writing_sources_are_refused_before_snapshot() {
    use std::os::windows::fs::OpenOptionsExt;
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let bytes = raster(16, 16);
    fs::write(outside.join("chart.png"), &bytes).unwrap();
    let link = workspace.join("linked");
    let junction = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(junction.status.success());
    let input: ImageSource = serde_json::from_value(source(&bytes, "linked/chart.png")).unwrap();
    assert!(snapshot(&input, &workspace).is_err());
    fs::write(workspace.join("chart.png"), &bytes).unwrap();
    let writer = fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(workspace.join("chart.png"))
        .unwrap();
    let input: ImageSource = serde_json::from_value(source(&bytes, "chart.png")).unwrap();
    assert!(snapshot(&input, &workspace).is_err());
    drop(writer);
    assert!(snapshot(&input, &workspace).is_ok());
}
