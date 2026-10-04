//! Shared native validation for transient composer images. Provider adapters
//! choose only their wire shape or temporary-file staging.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;

const MAX_USER_IMAGES: usize = 4;
const MAX_USER_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_USER_IMAGE_DIMENSION: u32 = 8192;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserImageInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) media_type: String,
    pub(crate) size_bytes: usize,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) data_url: String,
}

pub(crate) struct ValidatedImage {
    pub(crate) media_type: String,
    pub(crate) extension: &'static str,
    pub(crate) bytes: Vec<u8>,
}

/// Historical pixels never accompany a new request or replay.
pub(crate) fn current_images<'a>(
    messages: impl Iterator<Item = (&'a str, &'a [UserImageInput])>,
) -> Result<Vec<ValidatedImage>, String> {
    let messages: Vec<_> = messages.collect();
    let last_user = messages.iter().rposition(|(role, _)| *role == "user");
    for (index, (_, images)) in messages.iter().enumerate() {
        if !images.is_empty() && Some(index) != last_user {
            return Err("Images may be attached only to the current user message.".into());
        }
    }
    validate_images(last_user.map(|index| messages[index].1).unwrap_or_default())
}

fn validate_images(images: &[UserImageInput]) -> Result<Vec<ValidatedImage>, String> {
    if images.len() > MAX_USER_IMAGES {
        return Err(format!(
            "Attach no more than {MAX_USER_IMAGES} images to one message."
        ));
    }
    let total_bytes = images.iter().try_fold(0usize, |total, image| {
        total
            .checked_add(image.size_bytes)
            .ok_or("Attached image sizes are invalid.")
    })?;
    if total_bytes > MAX_USER_IMAGE_BYTES {
        return Err("Attached images must total no more than 1 MB.".into());
    }
    images
        .iter()
        .map(|image| {
            if image.id.trim().is_empty()
                || image.id.len() > 160
                || image.name.trim().is_empty()
                || image.name.len() > 256
                || image.size_bytes == 0
                || image.size_bytes > MAX_USER_IMAGE_BYTES
                || image.width == 0
                || image.height == 0
                || image.width > MAX_USER_IMAGE_DIMENSION
                || image.height > MAX_USER_IMAGE_DIMENSION
            {
                return Err("An attached image has invalid metadata.".into());
            }
            let (header, extension) = match image.media_type.as_str() {
                "image/png" => ("data:image/png;base64,", "png"),
                "image/jpeg" => ("data:image/jpeg;base64,", "jpg"),
                "image/webp" => ("data:image/webp;base64,", "webp"),
                _ => return Err("Attach only PNG, JPEG, or WebP images.".into()),
            };
            if image.data_url.len() > 1_500_000 {
                return Err("An attached image exceeds the supported request size.".into());
            }
            let payload = image
                .data_url
                .strip_prefix(header)
                .ok_or("An attached image has an invalid local payload.")?;
            let bytes = STANDARD
                .decode(payload)
                .map_err(|_| "An attached image has an invalid local payload.")?;
            if bytes.len() != image.size_bytes
                || image_dimensions(&bytes, &image.media_type) != Some((image.width, image.height))
            {
                return Err("An attached image does not match its declared format or size.".into());
            }
            Ok(ValidatedImage {
                media_type: image.media_type.clone(),
                extension,
                bytes,
            })
        })
        .collect()
}

fn image_dimensions(bytes: &[u8], media_type: &str) -> Option<(u32, u32)> {
    match media_type {
        "image/png" => png_dimensions(bytes),
        "image/jpeg" => jpeg_dimensions(bytes),
        "image/webp" => webp_dimensions(bytes),
        _ => None,
    }
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut offset = 2usize;
    while offset < bytes.len() {
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize;
        if length < 2 || offset.checked_add(length)? > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 7 {
                return None;
            }
            let height = u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?) as u32;
            return (width > 0 && height > 0).then_some((width, height));
        }
        offset += length;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 30 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    if declared.checked_add(8)? > bytes.len() {
        return None;
    }
    match &bytes[12..16] {
        b"VP8X" => {
            let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            Some((width, height))
        }
        b"VP8 " if bytes.len() >= 30 && &bytes[23..26] == b"\x9d\x01\x2a" => {
            let width = (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3fff) as u32;
            let height = (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3fff) as u32;
            (width > 0 && height > 0).then_some((width, height))
        }
        b"VP8L" if bytes[20] == 0x2f => {
            let width = 1 + u32::from(bytes[21]) + (u32::from(bytes[22] & 0x3f) << 8);
            let height = 1
                + u32::from(bytes[22] >> 6)
                + (u32::from(bytes[23]) << 2)
                + (u32::from(bytes[24] & 0x0f) << 10);
            Some((width, height))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image() -> UserImageInput {
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        UserImageInput {
            id: "one".into(),
            name: "pixel.png".into(),
            media_type: "image/png".into(),
            size_bytes: bytes.len(),
            width: 1,
            height: 1,
            data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        }
    }
    #[test]
    fn shared_limits_reject_count_total_payload_metadata_and_non_current_images() {
        let mut images = vec![image(); 5];
        assert!(validate_images(&images).is_err());
        images.truncate(2);
        images[0].size_bytes = MAX_USER_IMAGE_BYTES;
        assert!(validate_images(&images).is_err());
        let mut images = vec![image()];
        images[0].data_url = "https://example.invalid/image.png".into();
        assert!(validate_images(&images).is_err());
        images[0] = image();
        images[0].data_url.push('!');
        assert!(validate_images(&images).is_err());
        images[0] = image();
        images[0].height = 8193;
        assert!(validate_images(&images).is_err());
        images[0] = image();
        images[0].size_bytes += 1;
        assert!(validate_images(&images).is_err());
        let historical = vec![image()];
        assert!(
            current_images([("user", historical.as_slice()), ("user", &[])].into_iter()).is_err()
        );
        assert!(current_images([("assistant", historical.as_slice())].into_iter()).is_err());
        let validated = current_images([("user", historical.as_slice())].into_iter()).unwrap();
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].bytes.len(), historical[0].size_bytes);
    }
}
