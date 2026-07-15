//! Конвертация загруженных фото поста в WebP — паритет `PostImageProcessor.cs`.

use std::io::Cursor;

use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageReader};

const MAX_DIMENSION: u32 = 2048;
const MAX_PIXELS: u64 = 50_000_000;

pub enum PostImageProcessError {
    InvalidFormat,
    TooManyPixels,
}

pub fn process_post_image(input: &[u8]) -> Result<(Vec<u8>, &'static str), PostImageProcessError> {
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|_| PostImageProcessError::InvalidFormat)?;
    if reader.format().is_none() {
        return Err(PostImageProcessError::InvalidFormat);
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| PostImageProcessError::InvalidFormat)?;
    if (width as u64).saturating_mul(height as u64) > MAX_PIXELS {
        return Err(PostImageProcessError::TooManyPixels);
    }

    let img = image::load_from_memory(input).map_err(|_| PostImageProcessError::InvalidFormat)?;
    let resized = resize_max(img);

    let rgba = resized.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = Vec::new();
    WebPEncoder::new_lossless(&mut out)
        .encode(&rgba, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|_| PostImageProcessError::InvalidFormat)?;

    Ok((out, "image/webp"))
}

fn resize_max(img: DynamicImage) -> DynamicImage {
    if img.width() <= MAX_DIMENSION && img.height() <= MAX_DIMENSION {
        return img;
    }
    img.thumbnail(MAX_DIMENSION, MAX_DIMENSION)
}
