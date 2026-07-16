//! # FRC-I — Flora Relativistic Codec — Image
//!
//! Нативный фото-кодек экосистемы Flora (семейство FRC, `Documents/codecs/CODECS.md`).
//! Нормативная спецификация битстрима — `Documents/codecs/FRC-I.md`. Кодер пишет v3;
//! decode-заморозка текущей линии — golden-вектора в `tests/` (`.fri`).
//!
//! Два режима в одном контейнере:
//! - **lossless** — обратимый YCoCg-R (либо identity-RGB, либо палитра до
//!   256 цветов — кодер выбирает лучшее), MED-предиктор, контексты по
//!   градиентам, raw-fallback как потолок худшего случая;
//! - **lossy** — YCbCr, опциональный 4:2:0, направленная intra-предикция
//!   блоков (DC/V/H/TM + диагонали D45/D135), DCT 8x8 остатка, перцептивное
//!   квантование с dead-zone, RD-выбор моды.
//!
//! Энтропийное ядро общее: rANS (12-битные вероятности) + hybrid-uint токены.
//! Изображение делится на независимые тайлы 256x256; тайлы кодируются и
//! декодируются параллельно (feature `threads`, включена по умолчанию;
//! для wasm собирать с `--no-default-features`).
//!
//! Свойства реализации: чистый std (без зависимостей), `unsafe` запрещён,
//! декодер не паникует на произвольных байтах и не аллоцирует память
//! сверх `DecodeLimits`. Байты кодера не зависят от числа потоков.
//!
//! ```
//! use frc_i::{encode, decode, EncodeMode, ImageView, PixelFormat};
//!
//! let pixels: Vec<u8> = vec![200, 30, 90, 10, 20, 30, 40, 50, 60, 70, 80, 90];
//! let img = ImageView { width: 2, height: 2, format: PixelFormat::Rgb8, data: &pixels };
//! let fri = encode(&img, EncodeMode::Lossless).unwrap();
//! let out = decode(&fri).unwrap();
//! assert_eq!(out.data, pixels);
//! ```

mod arith;
mod bits;
mod cdef;
mod color;
mod dct;
mod deblock;
mod decode;
mod encode;
mod error;
mod format;
mod lossless;
mod lossy;
mod parallel;
mod plane;
mod predict;
mod rans;
mod section;
mod tokens;

pub use error::{DecodeError, EncodeError};

/// Новейшая версия битстрима, которую читает эта сборка
/// (см. `Documents/codecs/FRC-I.md`): v3 lossless, v5 lossy по умолчанию,
/// v6 при ICC, v7 экспериментально (`encode_with_version` / `--bitstream 7`).
pub const BITSTREAM_VERSION: u8 = format::VERSION_MAX;

/// Низкоуровневые примитивы энтропийного кодирования для семейства FRC:
/// flora-video-codec использует их для intra-кадров. API нестабилен,
/// вне `Backend/crates/media/` не использовать.
pub mod entropy {
    pub use crate::bits::{BitReader, BitWriter};
    pub use crate::rans::{FreqTable, PROB_BITS, PROB_SCALE, RansDecoder, encode_symbols};
    pub use crate::tokens::{ALPHABET, detokenize, tokenize, unzigzag, zigzag};
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
    /// ICC-профиль из блока метаданных (v6+), байты как есть.
    pub icc: Option<Vec<u8>>,
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
        Self {
            max_pixels: format::DEFAULT_MAX_PIXELS,
        }
    }
}

/// Метаданные потока без декодирования тела.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    /// Версия битстрима (1..=6).
    pub version: u8,
    pub width: u32,
    pub height: u32,
    pub lossless: bool,
    pub has_alpha: bool,
    pub chroma420: bool,
    /// Lossless без цветового преобразования (плоскости R, G, B).
    pub identity: bool,
    /// Палитровый lossless (до 256 цветов).
    pub palette: bool,
    /// Деблокинг-фильтр на выходе декодера (v4+, только lossy).
    pub deblock: bool,
    /// Блок метаданных присутствует (v6+; ICC читается `read_icc`).
    pub metadata: bool,
    /// `None` для lossless, иначе 1..=100.
    pub quality: Option<u8>,
}

/// Кодирует изображение в FRC-I (v5 для lossy, v3 для lossless).
pub fn encode(img: &ImageView<'_>, mode: EncodeMode) -> Result<Vec<u8>, EncodeError> {
    encode::encode(img, mode)
}

/// Кодирует с вложением ICC-профиля (битстрим v6: блок метаданных).
/// Профиль возвращается декодером в `DecodedImage::icc` и читается
/// без декодирования пикселей через [`read_icc`].
pub fn encode_with_icc(
    img: &ImageView<'_>,
    mode: EncodeMode,
    icc: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    encode::encode_with_icc(img, mode, icc)
}

#[doc(hidden)]
pub fn encode_with_version(
    img: &ImageView<'_>,
    mode: EncodeMode,
    version: u8,
) -> Result<Vec<u8>, EncodeError> {
    encode::encode_with_version(img, mode, version)
}

/// Декодирует FRC-I-поток с лимитами по умолчанию (~67 Мп).
pub fn decode(bytes: &[u8]) -> Result<DecodedImage, DecodeError> {
    decode::decode(bytes, DecodeLimits::default())
}

/// Декодирует FRC-I-поток с явными лимитами.
pub fn decode_with_limits(bytes: &[u8], limits: DecodeLimits) -> Result<DecodedImage, DecodeError> {
    decode::decode(bytes, limits)
}

/// Читает заголовок FRC-I без декодирования тела (для `info`/probe).
pub fn read_info(bytes: &[u8]) -> Result<ImageInfo, DecodeError> {
    let h = format::Header::parse(bytes)?;
    Ok(ImageInfo {
        version: h.version,
        width: h.width,
        height: h.height,
        lossless: h.lossless,
        has_alpha: h.alpha,
        chroma420: h.chroma420,
        identity: h.identity,
        palette: h.palette,
        deblock: h.deblock,
        metadata: h.metadata,
        quality: (!h.lossless).then_some(h.quality),
    })
}

/// Читает ICC-профиль без декодирования пикселей (`None`, если его нет).
pub fn read_icc(bytes: &[u8]) -> Result<Option<Vec<u8>>, DecodeError> {
    decode::read_icc(bytes)
}
