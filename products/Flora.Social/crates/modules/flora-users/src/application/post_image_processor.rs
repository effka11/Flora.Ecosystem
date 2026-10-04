//! Обработка аватаров Users → FRC-I (FRI).

use frc_i_integration::{FRC_I_MIME, IngestOptions, IntegrationError, ingest, is_frc_i};

const MAX_DIMENSION: u32 = 2048;
const MAX_PIXELS: u64 = 50_000_000;

#[derive(Debug)]
pub enum PostImageProcessError {
    InvalidFormat,
    TooManyPixels,
}

pub fn process_post_image(input: &[u8]) -> Result<(Vec<u8>, &'static str), PostImageProcessError> {
    let encoded = ingest(
        input,
        IngestOptions {
            max_dimension: MAX_DIMENSION,
            max_pixels: MAX_PIXELS,
            quality: 90,
        },
    )
    .map_err(|error| match error {
        IntegrationError::TooManyPixels => PostImageProcessError::TooManyPixels,
        _ => PostImageProcessError::InvalidFormat,
    })?;
    debug_assert!(is_frc_i(&encoded.bytes));
    Ok((encoded.bytes, FRC_I_MIME))
}
