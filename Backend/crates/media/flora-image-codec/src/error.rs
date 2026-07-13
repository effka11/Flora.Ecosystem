//! Ошибки кодека. Без внешних зависимостей (см. Cargo.toml: ядро — чистый std).

use std::fmt;

/// Ошибка кодирования: некорректный вход со стороны вызывающего кода.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// Нулевая сторона или превышение лимитов формата (`MAX_DIM`, `MAX_PIXELS`).
    InvalidDimensions { width: u32, height: u32 },
    /// Качество вне диапазона 1..=100.
    InvalidQuality(u8),
    /// Длина буфера пикселей не равна `width * height * bytes_per_pixel`.
    BufferSizeMismatch { expected: usize, actual: usize },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions { width, height } => {
                write!(f, "недопустимые размеры изображения: {width}x{height}")
            }
            Self::InvalidQuality(q) => write!(f, "quality={q}, допустимо 1..=100"),
            Self::BufferSizeMismatch { expected, actual } => {
                write!(f, "длина буфера пикселей {actual}, ожидалось {expected}")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

/// Ошибка декодирования: битстрим не является корректным FIC v1.
///
/// Контракт декодера: на **любых** входных байтах возвращается `Err`,
/// декодер не паникует и не аллоцирует память сверх лимитов.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Первые байты не совпадают с magic FIC.
    NotFic,
    /// Версия формата не поддерживается этой сборкой декодера.
    UnsupportedVersion(u8),
    /// Зарезервированные биты/байты ненулевые — поток из будущей ревизии.
    UnsupportedFeature(&'static str),
    /// Структурное повреждение потока; текст — диагностика для логов.
    Corrupt(&'static str),
    /// Заявленные размеры превышают лимиты декодера.
    TooLarge { width: u32, height: u32, max_pixels: u64 },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFic => write!(f, "не FIC-поток (magic не совпал)"),
            Self::UnsupportedVersion(v) => write!(f, "версия FIC {v} не поддерживается"),
            Self::UnsupportedFeature(what) => write!(f, "неподдерживаемая возможность: {what}"),
            Self::Corrupt(what) => write!(f, "повреждённый поток: {what}"),
            Self::TooLarge { width, height, max_pixels } => {
                write!(f, "{width}x{height} превышает лимит {max_pixels} пикселей")
            }
        }
    }
}

impl std::error::Error for DecodeError {}
