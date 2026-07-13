//! # FVC — Flora Video Codec
//!
//! Референсная реализация битстрима **FVC1** (спека: `docs/codecs/FVC.md`).
//! v0.1: intra-only (все кадры ключевые), YUV 4:2:0, 8 бит.
//!
//! Гарантии:
//! - декодер **бит-точно** воспроизводит реконструкцию энкодера (проверяется тестами);
//! - декодер **не паникует** на произвольном входе (повреждённый/обрезанный поток → `Err`
//!   либо мусорное, но безопасное изображение);
//! - нормативные пути не используют плавающую точку — результат детерминирован на всех
//!   платформах, включая wasm32.
//!
//! Ядро сознательно не имеет внешних зависимостей.

mod dec;
mod ec;
mod enc;
mod frame;
mod header;
mod lf;
pub mod metrics;
mod predict;
mod quant;
mod scan;
mod tables;
mod tokens;
mod transform;

pub mod ivf;
pub mod y4m;

pub use dec::Decoder;
pub use enc::Encoder;
pub use frame::{Frame, Plane};

/// FourCC потока FVC1 (контейнер IVF).
pub const FOURCC: [u8; 4] = *b"FVC1";
/// Версия битстрима, кодируемая в заголовке каждого кадра.
pub const BITSTREAM_VERSION: u8 = 1;

/// Максимальный линейный размер кадра, принимаемый кодеком.
pub const MAX_DIMENSION: u32 = 16384;

/// Размер суперблока.
pub(crate) const SB_SIZE: usize = 64;
/// Минимальный размер листа разбиения (люма).
pub(crate) const MIN_BLOCK: usize = 8;

/// Ошибки кодека.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Некорректная конфигурация энкодера (размеры, qp).
    InvalidConfig(&'static str),
    /// Битстрим повреждён или не является потоком FVC1.
    InvalidBitstream(&'static str),
    /// Кадр не соответствует конфигурации (размеры плоскостей).
    InvalidFrame(&'static str),
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::InvalidConfig(m) => write!(f, "invalid encoder config: {m}"),
            Error::InvalidBitstream(m) => write!(f, "invalid FVC1 bitstream: {m}"),
            Error::InvalidFrame(m) => write!(f, "invalid frame: {m}"),
        }
    }
}

impl core::error::Error for Error {}

/// Конфигурация энкодера FVC1 v0.1 (intra-only).
#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    /// Ширина в пикселях. Кратна 8, `2..=MAX_DIMENSION`.
    pub width: u32,
    /// Высота в пикселях. Кратна 8, `2..=MAX_DIMENSION`.
    pub height: u32,
    /// Базовый параметр квантования, `0..=63` (шаг удваивается каждые +8).
    pub qp: u8,
    /// Деблокинг-фильтр (уровень выводится из qp).
    pub loop_filter: bool,
}

impl EncoderConfig {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.width == 0 || self.height == 0 {
            return Err(Error::InvalidConfig("dimensions must be non-zero"));
        }
        if self.width > MAX_DIMENSION || self.height > MAX_DIMENSION {
            return Err(Error::InvalidConfig("dimension exceeds MAX_DIMENSION"));
        }
        if self.width % 8 != 0 || self.height % 8 != 0 {
            return Err(Error::InvalidConfig("dimensions must be multiples of 8 in v0.1"));
        }
        if self.qp > 63 {
            return Err(Error::InvalidConfig("qp must be in 0..=63"));
        }
        Ok(())
    }
}
