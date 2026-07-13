//! Контейнер FIC v1 (FIC.md §3): magic, заголовок, таблица тайлов, лимиты.

use crate::error::DecodeError;

/// Сигнатура файла: не-ASCII первый байт ловит порчу текстовым режимом.
pub const MAGIC: [u8; 4] = [0x8F, b'F', b'I', b'C'];
/// Единственная поддерживаемая версия.
pub const VERSION: u8 = 1;
/// Длина фиксированного заголовка.
pub const HEADER_LEN: usize = 20;

/// Флаг lossless-режима.
pub const FLAG_LOSSLESS: u8 = 0b0000_0001;
/// Флаг наличия альфа-плоскости.
pub const FLAG_ALPHA: u8 = 0b0000_0010;
/// Флаг сабсэмплинга цветоразностей 4:2:0 (только lossy).
pub const FLAG_CHROMA420: u8 = 0b0000_0100;
const FLAGS_KNOWN: u8 = FLAG_LOSSLESS | FLAG_ALPHA | FLAG_CHROMA420;

/// Максимальная сторона изображения.
pub const MAX_DIM: u32 = 32_768;
/// Лимит пикселей по умолчанию (~67 Мп); переопределяется `DecodeLimits`.
pub const DEFAULT_MAX_PIXELS: u64 = 1 << 26;

/// Сторона тайла: 256 (log2 = 8). Тайлы независимы — база будущего
/// параллельного декодирования без изменения формата.
pub const TILE_SHIFT: u8 = 8;
pub const TILE: usize = 1 << TILE_SHIFT;

/// Разобранный заголовок FIC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub width: u32,
    pub height: u32,
    pub lossless: bool,
    pub alpha: bool,
    pub chroma420: bool,
    /// 1..=100 для lossy, 0 для lossless.
    pub quality: u8,
}

impl Header {
    pub fn serialize(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = VERSION;
        let mut flags = 0u8;
        if self.lossless {
            flags |= FLAG_LOSSLESS;
        }
        if self.alpha {
            flags |= FLAG_ALPHA;
        }
        if self.chroma420 {
            flags |= FLAG_CHROMA420;
        }
        out[5] = flags;
        out[6..10].copy_from_slice(&self.width.to_le_bytes());
        out[10..14].copy_from_slice(&self.height.to_le_bytes());
        out[14] = 8; // битовая глубина v1
        out[15] = self.quality;
        out[16] = TILE_SHIFT;
        // 17..20 — резерв, нули.
        out
    }

    /// Разбирает и валидирует заголовок. Вся дальнейшая аллокация декодера
    /// разрешена только после успешного выхода отсюда.
    pub fn parse(bytes: &[u8]) -> Result<Self, DecodeError> {
        let Some(head) = bytes.get(..HEADER_LEN) else {
            return Err(DecodeError::NotFic);
        };
        if head[0..4] != MAGIC {
            return Err(DecodeError::NotFic);
        }
        if head[4] != VERSION {
            return Err(DecodeError::UnsupportedVersion(head[4]));
        }
        let flags = head[5];
        if flags & !FLAGS_KNOWN != 0 {
            return Err(DecodeError::UnsupportedFeature("неизвестные биты флагов"));
        }
        let width = u32::from_le_bytes(head[6..10].try_into().expect("len 4"));
        let height = u32::from_le_bytes(head[10..14].try_into().expect("len 4"));
        if width == 0 || height == 0 || width > MAX_DIM || height > MAX_DIM {
            return Err(DecodeError::Corrupt("размеры вне допустимого диапазона"));
        }
        if head[14] != 8 {
            return Err(DecodeError::UnsupportedFeature("битовая глубина != 8"));
        }
        let lossless = flags & FLAG_LOSSLESS != 0;
        let quality = head[15];
        if lossless && quality != 0 {
            return Err(DecodeError::Corrupt("quality != 0 в lossless-режиме"));
        }
        if !lossless && !(1..=100).contains(&quality) {
            return Err(DecodeError::Corrupt("quality вне 1..=100"));
        }
        let chroma420 = flags & FLAG_CHROMA420 != 0;
        if lossless && chroma420 {
            return Err(DecodeError::Corrupt("сабсэмплинг несовместим с lossless"));
        }
        if head[16] != TILE_SHIFT {
            return Err(DecodeError::UnsupportedFeature("размер тайла != 256"));
        }
        if head[17..20] != [0, 0, 0] {
            return Err(DecodeError::UnsupportedFeature("ненулевой резерв заголовка"));
        }
        Ok(Self {
            width,
            height,
            lossless,
            alpha: flags & FLAG_ALPHA != 0,
            chroma420,
            quality,
        })
    }
}

/// Прямоугольник одного тайла в координатах изображения.
#[derive(Debug, Clone, Copy)]
pub struct TileRect {
    pub x0: usize,
    pub y0: usize,
    pub w: usize,
    pub h: usize,
}

/// Сетка тайлов: обход строго row-major — порядок общий для кодера и декодера.
pub fn tile_grid(width: u32, height: u32) -> Vec<TileRect> {
    let (w, h) = (width as usize, height as usize);
    let mut tiles = Vec::with_capacity(w.div_ceil(TILE) * h.div_ceil(TILE));
    for y0 in (0..h).step_by(TILE) {
        for x0 in (0..w).step_by(TILE) {
            tiles.push(TileRect { x0, y0, w: TILE.min(w - x0), h: TILE.min(h - y0) });
        }
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip() {
        let h = Header {
            width: 1920,
            height: 1080,
            lossless: false,
            alpha: true,
            chroma420: true,
            quality: 75,
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
    }

    #[test]
    fn rejects_bad_magic_and_version() {
        let h = Header {
            width: 1,
            height: 1,
            lossless: true,
            alpha: false,
            chroma420: false,
            quality: 0,
        };
        let mut bytes = h.serialize();
        bytes[0] = b'P';
        assert_eq!(Header::parse(&bytes), Err(DecodeError::NotFic));
        let mut bytes = h.serialize();
        bytes[4] = 2;
        assert_eq!(Header::parse(&bytes), Err(DecodeError::UnsupportedVersion(2)));
    }

    #[test]
    fn rejects_reserved_bits() {
        let h = Header {
            width: 1,
            height: 1,
            lossless: true,
            alpha: false,
            chroma420: false,
            quality: 0,
        };
        let mut bytes = h.serialize();
        bytes[5] |= 0b1000_0000;
        assert!(matches!(Header::parse(&bytes), Err(DecodeError::UnsupportedFeature(_))));
        let mut bytes = h.serialize();
        bytes[18] = 1;
        assert!(matches!(Header::parse(&bytes), Err(DecodeError::UnsupportedFeature(_))));
    }

    #[test]
    fn tile_grid_covers_image() {
        let tiles = tile_grid(600, 300);
        assert_eq!(tiles.len(), 3 * 2);
        let area: usize = tiles.iter().map(|t| t.w * t.h).sum();
        assert_eq!(area, 600 * 300);
    }
}
