//! Only local picture relationships and independently decoded raster thumbnails.
use super::{part, relationship_path, Block, Budget, Node};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::{Cursor, Read};

pub(super) fn extract(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    picture: &Node,
    slide_path: &str,
    budget: &mut Budget,
) -> Option<Block> {
    if budget.image_count >= 8 || budget.image_bytes >= 4 * 1024 * 1024 {
        return None;
    }
    budget.image_count += 1;
    // Crops, hidden pictures, actions, transformations and grouped/media pictures
    // cannot be represented honestly by this simple content projection.
    if !picture.find("srcRect").is_empty()
        || !picture.find("hlinkClick").is_empty()
        || picture
            .find("cNvPr")
            .iter()
            .any(|node| matches!(node.attribute("hidden"), "1" | "true"))
        || picture.find("xfrm").iter().any(|node| {
            ["rot", "flipH", "flipV"]
                .iter()
                .any(|key| !matches!(node.attribute(key), "" | "0" | "false"))
        })
    {
        return None;
    }
    let blips = picture.find("blip");
    if blips.len() != 1 || !blips[0].attribute("link").is_empty() {
        return None;
    }
    let id = blips[0].attribute("embed");
    let (base, file) = slide_path.rsplit_once('/')?;
    let relations = part(archive, &format!("{base}/_rels/{file}.rels"))?;
    let candidates = relations.find("Relationship");
    let matches = candidates
        .iter()
        .filter(|node| node.attribute("Id") == id)
        .collect::<Vec<_>>();
    if id.is_empty() || matches.len() != 1 {
        return None;
    }
    let relation = matches[0];
    if !relation.attribute("TargetMode").is_empty()
        || relation.attribute("Type")
            != "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
    {
        return None;
    }
    let path = relationship_path(relation.attribute("Target"), base)?;
    if !path.starts_with("ppt/media/") {
        return None;
    }
    let extension = path.rsplit_once('.')?.1;
    if !matches!(extension, "png" | "jpg" | "jpeg") {
        return None;
    }
    let mut entry = archive.by_name(&path).ok()?;
    let limit = super::super::office_images::MAX_IMAGE_BYTES;
    if entry.size() == 0 || entry.size() > limit as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    entry
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let thumbnail = super::super::office_images::normalize(&bytes, extension, true).ok()?;
    if budget.image_bytes.saturating_add(thumbnail.bytes.len()) > 4 * 1024 * 1024 {
        return None;
    }
    budget.image_bytes += thumbnail.bytes.len();
    let alt = picture
        .find("cNvPr")
        .first()
        .map(|node| node.attribute("descr"))
        .filter(|alt| !alt.is_empty())
        .unwrap_or("Slide image");
    Some(Block::Image {
        data_url: format!(
            "data:image/png;base64,{}",
            STANDARD.encode(&thumbnail.bytes)
        ),
        alt: budget.text(alt),
        width: thumbnail.width,
        height: thumbnail.height,
    })
}
