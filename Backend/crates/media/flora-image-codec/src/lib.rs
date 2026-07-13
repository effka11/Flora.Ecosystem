//! # FIC — Flora Image Codec
//!
//! Нативный фото-кодек экосистемы Flora (семейство FMC, `docs/codecs/CODECS.md`).
//! Нормативная спецификация битстрима — `docs/codecs/FIC.md`; формат v1
//! заморожен golden-векторами в `tests/`.
//!
//! Два режима в одном контейнере:
//! - **lossless** — обратимый YCoCg-R, MED-предиктор, контексты по градиентам;
//! - **lossy** — YCbCr, опциональный 4:2:0, DCT 8x8, перцептивное квантование.
//!
//! Энтропийное ядро общее: rANS (12-битные вероятности) + hybrid-uint токены.
//! Изображение делится на независимые тайлы 256x256.
//!
//! Свойства реализации: чистый std (без зависимостей), `unsafe` запрещён,
//! декодер не паникует на произвольных байтах и не аллоцирует память
//! сверх `DecodeLimits`.
//!
//! ```
//! use flora_image_codec::{encode, decode, EncodeMode, ImageView, PixelFormat};
//!
//! let pixels: Vec<u8> = vec![200, 30, 90, 10, 20, 30, 40, 50, 60, 70, 80, 90];
//! let img = ImageView { width: 2, height: 2, format: PixelFormat::Rgb8, data: &pixels };
//! let fic = encode(&img, EncodeMode::Lossless).unwrap();
//! let out = decode(&fic).unwrap();
//! assert_eq!(out.data, pixels);
//! ```

mod bits;
mod color;
mod dct;
mod decode;
mod encode;
mod error;
mod format;
mod lossless;
mod lossy;
mod plane;
mod predict;
mod rans;
mod section;
mod tokens;

pub use error::{DecodeError, EncodeError};

/// Низкоуровневые примитивы энтропийного кодирования для семейства FMC:
/// flora-video-codec использует их для intra-кадров. API нестабилен,
/// вне `Backend/crates/media/` не использовать.
pub mod entropy {
    pub use crate::bits::{BitReader, BitWriter};
    pub use crate::rans::{encode_symbols, FreqTable, RansDecoder, PROB_BITS, PROB_SCALE};
    pub use crate::tokens::{detokenize, tokenize, unzigzag, zigzag, ALPHABET};
}

/// Формат пикселей интерливленного буфера.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// 3 байта на пиксель: R, G, B.
    Rgb8,
    /// 4 байта на пиксель: R, G, B, A. Альфа кодируется без потерь всегда.
    Rgba8,
}

/// Входное изображение для кодера (память принадлежит вызывающему).
#[derive(Debug, Clone, Copy)]
pub struct ImageView<'a> {
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    /// Интерливленные пиксели, длина строго `width * height * bpp`.
    pub data: &'a [u8],
}

/// Результат декодирования.
#[derive(Debug, Clone)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub data: Vec<u8>,
}

/// Режим кодирования.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeMode {
    /// Побайтно точное восстановление; цель — меньше PNG.
    Lossless,
    /// Перцептивное сжатие; `quality` 1..=100 (при `quality <= 85`
    /// автоматически включается сабсэмплинг цветоразностей 4:2:0).
    Lossy { quality: u8 },
}

/// Лимиты декодера против злонамеренных заголовков.
#[derive(Debug, Clone, Copy)]
pub struct DecodeLimits {
    /// Максимум пикселей (`width * height`), которые декодер согласен аллоцировать.
    pub max_pixels: u64,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self { max_pixels: format::DEFAULT_MAX_PIXELS }
    }
}

/// Метаданные потока без декодирования тела.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub lossless: bool,
    pub has_alpha: bool,
    pub chroma420: bool,
    /// `None` для lossless, иначе 1..=100.
    pub quality: Option<u8>,
}

/// Кодирует изображение в FIC v1.
pub fn encode(img: &ImageView<'_>, mode: EncodeMode) -> Result<Vec<u8>, EncodeError> {
    encode::encode(img, mode)
}

/// Декодирует FIC-поток с лимитами по умолчанию (~67 Мп).
pub fn decode(bytes: &[u8]) -> Result<DecodedImage, DecodeError> {
    decode::decode(bytes, DecodeLimits::default())
}

/// Декодирует FIC-поток с явными лимитами.
pub fn decode_with_limits(
    bytes: &[u8],
    limits: DecodeLimits,
) -> Result<DecodedImage, DecodeError> {
    decode::decode(bytes, limits)
}

/// Читает заголовок FIC без декодирования тела (для `info`/probe).
pub fn read_info(bytes: &[u8]) -> Result<ImageInfo, DecodeError> {
    let h = format::Header::parse(bytes)?;
    Ok(ImageInfo {
        width: h.width,
        height: h.height,
        lossless: h.lossless,
        has_alpha: h.alpha,
        chroma420: h.chroma420,
        quality: (!h.lossless).then_some(h.quality),
    })
}
