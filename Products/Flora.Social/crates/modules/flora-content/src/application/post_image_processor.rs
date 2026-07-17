//! Обработка изображений Content → FRC-I (FRI).

use frc_i_integration::{FRC_I_MIME, IngestOptions, IntegrationError, ingest, is_frc_i};

const MAX_DIMENSION: u32 = 2048;
const MAX_PIXELS: u64 = 50_000_000;

#[derive(Debug)]
pub enum PostImageProcessError {
    InvalidFormat,
    TooManyPixels,
}

pub fn process_post_image(input: &[u8]) -> Result<(Vec<u8>, &'static str), PostImageProcessError> {
    process(input, 75)
}

pub fn process_avatar_image(input: &[u8]) -> Result<(Vec<u8>, &'static str), PostImageProcessError> {
    process(input, 85)
}

fn process(
    input: &[u8],
    quality: u8,
) -> Result<(Vec<u8>, &'static str), PostImageProcessError> {
    let encoded = ingest(
        input,
        IngestOptions {
            max_dimension: MAX_DIMENSION,
            max_pixels: MAX_PIXELS,
            quality,
        },
    )
    .map_err(|error| match error {
        IntegrationError::TooManyPixels => PostImageProcessError::TooManyPixels,
        _ => PostImageProcessError::InvalidFormat,
    })?;
    debug_assert!(is_frc_i(&encoded.bytes));
    Ok((encoded.bytes, FRC_I_MIME))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    #[test]
    fn writes_fri_only() {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[20, 40, 60, 255], 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        let (stored, mime) = process_post_image(&png).unwrap();
        assert_eq!(mime, FRC_I_MIME);
        assert!(is_frc_i(&stored));
    }
}
