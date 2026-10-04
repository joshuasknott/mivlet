//! Native raster snapshots for passive Office pictures. Caller-selected paths
//! stay confined to the agent workspace; only decoded, metadata-free PNG leaves.
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
};

pub(super) const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PIXELS: u64 = 4 * 1024 * 1024;
const INVALID: &str =
    "Use a complete PNG or JPEG image, at most 4 MB, 4096 pixels per side and four million pixels.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImageSource {
    path: String,
    sha256: String,
    pub(super) alt: String,
}

pub(super) struct Picture {
    pub(super) bytes: Vec<u8>,
    pub(super) width: u32,
    pub(super) height: u32,
}

fn format(extension: &str) -> Result<ImageFormat, String> {
    match extension {
        "png" => Ok(ImageFormat::Png),
        "jpg" | "jpeg" => Ok(ImageFormat::Jpeg),
        _ => Err(INVALID.into()),
    }
}

fn decode(bytes: &[u8], extension: &str) -> Result<DynamicImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(INVALID.into());
    }
    let format = format(extension)?;
    if format == ImageFormat::Png {
        // Existing strict CRC/end validation also rejects APNG and trailing data.
        crate::media_images::validate_generated_png(bytes).map_err(|_| INVALID)?;
    } else if !bytes.starts_with(b"\xff\xd8\xff") || !bytes.ends_with(b"\xff\xd9") {
        return Err(INVALID.into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(32 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| INVALID)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_PIXELS
        || decoder.total_bytes() > 32 * 1024 * 1024
    {
        return Err(INVALID.into());
    }
    let orientation = decoder.orientation().map_err(|_| INVALID)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(|_| INVALID)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

struct BoundedPng(Vec<u8>);
impl Write for BoundedPng {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_IMAGE_BYTES {
            return Err(std::io::Error::other("Office image exceeds its byte limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(decoded: DynamicImage) -> Result<Picture, String> {
    let image = decoded.to_rgba8();
    let (width, height) = image.dimensions();
    let mut output = BoundedPng(Vec::new());
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder
            .write_header()
            .map_err(|_| INVALID)?
            .write_image_data(image.as_raw())
            .map_err(|_| INVALID)?;
    }
    Ok(Picture {
        bytes: output.0,
        width,
        height,
    })
}

pub(super) fn snapshot(source: &ImageSource, root: &Path) -> Result<Picture, String> {
    super::office_authoring::validate_document_text(&source.alt, 240)?;
    if source.sha256.len() != 64
        || !source
            .sha256
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(
            "Use the exact image SHA-256 returned by read-file or its input/output receipt.".into(),
        );
    }
    let extension = super::artifacts::allowed_path(&source.path)?;
    format(extension)?;
    let path = crate::tools::confine_path(&source.path, root)?;
    let bytes = super::artifacts::read_bounded_limit(root, &path, MAX_IMAGE_BYTES as u64)?;
    if hex::encode(Sha256::digest(&bytes)) != source.sha256 {
        return Err(
            "The image changed after inspection. Read it again and approve the new digest.".into(),
        );
    }
    normalize(&bytes, extension, false)
}

pub(super) fn normalize(bytes: &[u8], extension: &str, thumbnail: bool) -> Result<Picture, String> {
    catch_unwind(AssertUnwindSafe(|| {
        let decoded = decode(bytes, extension)?;
        encode(if thumbnail {
            decoded.thumbnail(decoded.width().min(512), decoded.height().min(512))
        } else {
            decoded
        })
    }))
    .map_err(|_| INVALID.to_string())?
}

/// A read-only tool result contains dimensions and an exact digest, never raster
/// bytes, metadata, host paths or a claimed visual interpretation.
pub(crate) fn inspect(bytes: &[u8], extension: &str) -> Result<String, String> {
    let dimensions = catch_unwind(AssertUnwindSafe(|| {
        decode(bytes, extension).map(|image| (image.width(), image.height()))
    }))
    .map_err(|_| INVALID.to_string())??;
    serde_json::to_string(&serde_json::json!({
        "format": extension, "bytes": bytes.len(), "sha256": hex::encode(Sha256::digest(bytes)),
        "width": dimensions.0, "height": dimensions.1,
        "notice": "Raster validated; no visual interpretation. Use this exact digest for presentation images."
    })).map_err(|_| "The image inspection result is invalid.".into())
}

#[cfg(test)]
#[path = "office_images_tests.rs"]
mod tests;
