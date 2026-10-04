//! Интеграционный слой FRC-I для продуктов.
//!
//! Ядро [`frc_i`] остаётся portable. Этот crate — MIME, resize и FRI encode/decode
//! для storage; без dual-variant / WebP fallback.

use std::io::Cursor;

use frc_i::{DecodeLimits, EncodeMode, ImageView, PixelFormat};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageReader};
use thiserror::Error;

pub const FRC_I_MIME: &str = "image/x-flora-frc-i";
pub const FRC_I_EXTENSION: &str = "fri";
/// Legacy dual-variant envelope MIME (FRI primary + WebP). Only used by backfill.
pub const IMAGE_SET_MIME: &str = "application/vnd.flora.frc-i-image-set";

const FRC_I_MAGIC: [u8; 4] = [0x8f, b'F', b'R', b'I'];
const IMAGE_SET_MAGIC: [u8; 4] = [0x8f, b'F', b'I', b'S'];
const IMAGE_SET_VERSION: u8 = 1;
const IMAGE_SET_HEADER_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum IntegrationError {
    #[error("неизвестный или повреждённый формат изображения")]
    InvalidSource,
    #[error("изображение превышает лимит пикселей")]
    TooManyPixels,
    #[error("quality должен быть в диапазоне 1..=100")]
    InvalidQuality,
    #[error("повреждённый FRC-I image-set")]
    InvalidImageSet,
    #[error("ошибка FRC-I: {0}")]
    Frc(String),
    #[error("ошибка image adapter: {0}")]
    Image(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestOptions {
    pub max_dimension: u32,
    pub max_pixels: u64,
    pub quality: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedFri {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
}

pub fn is_frc_i(bytes: &[u8]) -> bool {
    bytes.starts_with(&FRC_I_MAGIC) && frc_i::read_info(bytes).is_ok()
}

pub fn is_image_set(bytes: &[u8]) -> bool {
    bytes.starts_with(&IMAGE_SET_MAGIC)
}

/// Extract the FRI primary from a legacy ImageSet envelope (no re-encode).
pub fn extract_image_set_primary(bytes: &[u8]) -> Result<Vec<u8>, IntegrationError> {
    if bytes.len() < IMAGE_SET_HEADER_LEN
        || bytes[..4] != IMAGE_SET_MAGIC
        || bytes[4] != IMAGE_SET_VERSION
        || bytes[5..8] != [0, 0, 0]
    {
        return Err(IntegrationError::InvalidImageSet);
    }
    let primary_len = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| IntegrationError::InvalidImageSet)?,
    ) as usize;
    let fallback_len = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|_| IntegrationError::InvalidImageSet)?,
    ) as usize;
    let payload_len = primary_len
        .checked_add(fallback_len)
        .ok_or(IntegrationError::InvalidImageSet)?;
    if IMAGE_SET_HEADER_LEN.checked_add(payload_len) != Some(bytes.len()) || primary_len == 0 {
        return Err(IntegrationError::InvalidImageSet);
    }
    let primary = bytes[IMAGE_SET_HEADER_LEN..IMAGE_SET_HEADER_LEN + primary_len].to_vec();
    if !is_frc_i(&primary) {
        return Err(IntegrationError::InvalidImageSet);
    }
    Ok(primary)
}

/// Convert any stored public-media blob to FRI bytes for backfill.
///
/// - already FRI → clone
/// - legacy ImageSet → extract primary FRI
/// - JPEG/PNG/WebP/(other decoder-supported) → [`ingest`]
pub fn coerce_to_fri(bytes: &[u8], options: IngestOptions) -> Result<Vec<u8>, IntegrationError> {
    if is_frc_i(bytes) {
        return Ok(bytes.to_vec());
    }
    if is_image_set(bytes) {
        return extract_image_set_primary(bytes);
    }
    Ok(ingest(bytes, options)?.bytes)
}

/// Encode a source image to a single FRC-I (FRI) stream.
pub fn ingest(input: &[u8], options: IngestOptions) -> Result<EncodedFri, IntegrationError> {
    let image = load_and_validate(input, options)?;
    encode_dynamic_image_fri(resize_max(image, options.max_dimension), options.quality)
}

pub fn encode_dynamic_image_fri(
    image: DynamicImage,
    quality: u8,
) -> Result<EncodedFri, IntegrationError> {
    if !(1..=100).contains(&quality) {
        return Err(IntegrationError::InvalidQuality);
    }
    let has_alpha = image.color().has_alpha();
    let width = image.width();
    let height = image.height();
    let (pixels, format) = if has_alpha {
        (image.to_rgba8().into_raw(), PixelFormat::Rgba8)
    } else {
        (image.to_rgb8().into_raw(), PixelFormat::Rgb8)
    };
    let view = ImageView {
        width,
        height,
        format,
        data: &pixels,
    };
    let bytes = frc_i::encode(&view, EncodeMode::Lossy { quality })
        .map_err(|e| IntegrationError::Frc(e.to_string()))?;
    Ok(EncodedFri {
        bytes,
        width,
        height,
        has_alpha,
    })
}

pub fn decode_frc_i_to_png(
    bytes: &[u8],
    limits: DecodeLimits,
) -> Result<Vec<u8>, IntegrationError> {
    let decoded = frc_i::decode_with_limits(bytes, limits)
        .map_err(|e| IntegrationError::Frc(e.to_string()))?;
    let color = match decoded.format {
        PixelFormat::Rgb8 => ExtendedColorType::Rgb8,
        PixelFormat::Rgba8 => ExtendedColorType::Rgba8,
    };
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
        .write_image(&decoded.data, decoded.width, decoded.height, color)
        .map_err(image_error)?;
    Ok(png)
}

fn load_and_validate(
    input: &[u8],
    options: IngestOptions,
) -> Result<DynamicImage, IntegrationError> {
    if !(1..=100).contains(&options.quality) {
        return Err(IntegrationError::InvalidQuality);
    }
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|_| IntegrationError::InvalidSource)?;
    if reader.format().is_none() {
        return Err(IntegrationError::InvalidSource);
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| IntegrationError::InvalidSource)?;
    if u64::from(width).saturating_mul(u64::from(height)) > options.max_pixels {
        return Err(IntegrationError::TooManyPixels);
    }
    image::load_from_memory(input).map_err(image_error)
}

fn resize_max(image: DynamicImage, max_dimension: u32) -> DynamicImage {
    if max_dimension == 0 || (image.width() <= max_dimension && image.height() <= max_dimension) {
        image
    } else {
        image.thumbnail(max_dimension, max_dimension)
    }
}

fn image_error(error: image::ImageError) -> IntegrationError {
    IntegrationError::Image(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_png() -> Vec<u8> {
        let pixels = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&pixels, 2, 2, ExtendedColorType::Rgba8)
            .unwrap();
        png
    }

    #[test]
    fn ingest_builds_fri_only() {
        let encoded = ingest(
            &tiny_png(),
            IngestOptions {
                max_dimension: 2048,
                max_pixels: 50_000_000,
                quality: 75,
            },
        )
        .unwrap();
        assert!(is_frc_i(&encoded.bytes));
    }

    #[test]
    fn decode_fri_to_png_roundtrips_dimensions() {
        let encoded = ingest(
            &tiny_png(),
            IngestOptions {
                max_dimension: 1,
                max_pixels: 50_000_000,
                quality: 85,
            },
        )
        .unwrap();
        let png = decode_frc_i_to_png(&encoded.bytes, DecodeLimits::default()).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1, 1));
    }

    #[test]
    fn coerce_extracts_fri_from_legacy_image_set() {
        let fri = ingest(
            &tiny_png(),
            IngestOptions {
                max_dimension: 2048,
                max_pixels: 50_000_000,
                quality: 75,
            },
        )
        .unwrap()
        .bytes;
        let fallback = b"RIFF\x08\0\0\0WEBP";
        let mut set = Vec::new();
        set.extend_from_slice(&IMAGE_SET_MAGIC);
        set.push(IMAGE_SET_VERSION);
        set.extend_from_slice(&[0, 0, 0]);
        set.extend_from_slice(&(fri.len() as u32).to_le_bytes());
        set.extend_from_slice(&(fallback.len() as u32).to_le_bytes());
        set.extend_from_slice(&fri);
        set.extend_from_slice(fallback);
        let coerced = coerce_to_fri(
            &set,
            IngestOptions {
                max_dimension: 2048,
                max_pixels: 50_000_000,
                quality: 75,
            },
        )
        .unwrap();
        assert_eq!(coerced, fri);
        assert!(is_frc_i(&coerced));
    }
}
