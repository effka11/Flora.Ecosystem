//! # FVC — Flora Video Codec
//!
//! Референсная реализация битстрима **FVC1** (спека: `docs/codecs/FVC.md`).
//! v1: YUV 4:2:0 8 бит, ключевые (intra) и P-кадры (компенсация движения
//! ¼ пикселя от предыдущего кадра).
//!
//! Гарантии:
//! - декодер **бит-точно** воспроизводит реконструкцию энкодера (проверяется тестами);
//! - декодер **не паникует** на произвольном входе (повреждённый/обрезанный поток → `Err`
//!   либо мусорное, но безопасное изображение);
//! - нормативные пути не используют плавающую точку — результат детерминирован на всех
//!   платформах, включая wasm32.
//!
//! Ядро сознательно не имеет внешних зависимостей.

mod block;
mod dec;
mod ec;
mod enc;
mod frame;
mod header;
mod lf;
mod mc;
pub mod metrics;
mod predict;
mod quant;
mod scan;
mod syntax;
mod tables;
mod tokens;
mod transform;

pub mod container;
pub mod ivf;
pub mod y4m;

pub use dec::Decoder;
pub use enc::{EncodedFrame, Encoder};
pub use frame::{Frame, Plane};

/// FourCC потока FVC1 (контейнер IVF).
pub const FOURCC: [u8; 4] = *b"FVC1";
/// Версия битстрима, кодируемая в заголовке каждого кадра
/// (2 = формат v1 c inter-кадрами; 1 был у intra-only черновика v0.1).
pub const BITSTREAM_VERSION: u8 = 2;

/// Максимальный линейный размер кадра, принимаемый кодеком.
pub const MAX_DIMENSION: u32 = 16384;

/// Размер суперблока.
pub(crate) const SB_SIZE: usize = 64;
/// Минимальный размер листа разбиения (люма).
pub(crate) const MIN_BLOCK: usize = 8;

/// Позиция и размер квадратного блока в плоскости (люма-координаты).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Blk {
    pub x: usize,
    pub y: usize,
    pub n: usize,
}

impl Blk {
    /// Квадрант i quadtree-разбиения (0 TL, 1 TR, 2 BL, 3 BR).
    #[inline]
    pub fn child(self, i: usize) -> Blk {
        let half = self.n / 2;
        Blk {
            x: self.x + if i % 2 == 1 { half } else { 0 },
            y: self.y + if i >= 2 { half } else { 0 },
            n: half,
        }
    }

    /// Соответствующий блок хрома-плоскости (4:2:0).
    #[inline]
    pub fn chroma(self) -> Blk {
        Blk {
            x: self.x / 2,
            y: self.y / 2,
            n: self.n / 2,
        }
    }
}

/// Классификация узла quadtree (нормативная геометрия, общая для энкодера и декодера).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodePlacement {
    /// Начало блока за границей кадра — узел не существует (без синтаксиса).
    Outside,
    /// Блок частично выходит за кадр — принудительное разбиение (без флага).
    MustSplit,
    /// Минимальный размер — всегда лист (без флага).
    Leaf,
    /// Полностью внутри и крупнее минимума — флаг разбиения кодируется.
    Choice,
}

#[inline]
pub(crate) fn place_node(b: Blk, w: usize, h: usize) -> NodePlacement {
    if b.x >= w || b.y >= h {
        return NodePlacement::Outside;
    }
    if b.x + b.n > w || b.y + b.n > h {
        // Размеры кадра кратны 8, поэтому блок 8×8 не может пересекать границу.
        debug_assert!(b.n > MIN_BLOCK);
        return NodePlacement::MustSplit;
    }
    if b.n == MIN_BLOCK {
        NodePlacement::Leaf
    } else {
        NodePlacement::Choice
    }
}

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

/// Конфигурация энкодера FVC1.
#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    /// Ширина в пикселях. Кратна 8, `8..=MAX_DIMENSION`.
    pub width: u32,
    /// Высота в пикселях. Кратна 8, `8..=MAX_DIMENSION`.
    pub height: u32,
    /// Базовый параметр квантования, `0..=63` (шаг удваивается каждые +8).
    /// Ключевые кадры кодируются с qp − 4 (якорь качества для GOP).
    pub qp: u8,
    /// Деблокинг-фильтр (уровень выводится из qp).
    pub loop_filter: bool,
    /// Интервал ключевых кадров: 1 = все кадры ключевые, N — ключ каждые N кадров.
    pub keyint: u32,
}

impl EncoderConfig {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.width == 0 || self.height == 0 {
            return Err(Error::InvalidConfig("dimensions must be non-zero"));
        }
        if self.width > MAX_DIMENSION || self.height > MAX_DIMENSION {
            return Err(Error::InvalidConfig("dimension exceeds MAX_DIMENSION"));
        }
        if !self.width.is_multiple_of(8) || !self.height.is_multiple_of(8) {
            return Err(Error::InvalidConfig("dimensions must be multiples of 8"));
        }
        if self.qp > 63 {
            return Err(Error::InvalidConfig("qp must be in 0..=63"));
        }
        if self.keyint == 0 {
            return Err(Error::InvalidConfig("keyint must be >= 1"));
        }
        Ok(())
    }
}
