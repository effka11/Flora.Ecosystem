//! Контейнер FRC-I (FRC-I.md §2): magic, заголовок, палитра, таблица тайлов, лимиты.

use crate::error::DecodeError;

/// Сигнатура файла: не-ASCII первый байт ловит порчу текстовым режимом.
pub const MAGIC: [u8; 4] = [0x8F, b'F', b'R', b'I'];
/// Версия, которую пишет кодер для lossless (слой блоков не используется).
pub const VERSION_CURRENT: u8 = 3;
/// Версия с деблокинг-фильтром (флаг-бит 5); флаг ставится при `quality < 45`.
pub const VERSION_DEBLOCK: u8 = 4;
/// Legacy-версия с адаптивными суперблоками 16×16.
pub const VERSION_SUPERBLOCK: u8 = 5;
/// Версия с блоком метаданных (флаг-бит 6): ICC-профиль и будущие чанки.
pub const VERSION_METADATA: u8 = VERSION_SUPERBLOCK + 1;
/// Версия с адаптивной энтропией lossy-секций (линия v7, FRC-I.md §11.3):
/// range-кодер + адаптивные модели вместо статического rANS; таблиц частот
/// в DCT-секциях нет. Замороженная линия v7.9a.
pub const VERSION_ADAPTIVE: u8 = 7;
/// Версия v8 (FRC-I.md §11.4): целочисленный lossy-YCoCg с пошаговым
/// квантованием плоскостей Y/Co/Cg. Дерево блоков и энтропия идентичны v7;
/// прямоугольные партиции отклонены до freeze (бюджет encode ≥ 11 Мп/с).
/// Заморожена.
pub const VERSION_YCOCG: u8 = 8;
/// Исторический алиас: имя осталось от прототипа с rect; в wire v8 rect нет.
#[doc(hidden)]
pub const VERSION_RECT: u8 = VERSION_YCOCG;
/// Версия v9 (FRC-I.md §11.5): перцептивная адаптивная квантизация —
/// каждый корень 32×32 каждой плоскости сигналит индекс delta-Q (0..=7),
/// масштабирующий матрицу квантования плоскости множителем 2^((dq−4)/6)
/// (целочисленный Q6). Дерево блоков, энтропия и цвет — как в v8. Заморожена.
pub const VERSION_PERCEPTUAL: u8 = 9;
/// Версия v10 (FRC-I.md §7.18, §11.6): wire и семантика декодера идентичны
/// v9 (per-root delta-Q поверх дерева/энтропии/цвета v8). Новая версия
/// фиксирует асимметричный референсный AQ: уточнение гладких/структурных
/// корней сильнее огрубления текстур. Заморожена.
pub const VERSION_ASYMMETRIC_AQ: u8 = 10;
/// Версия v11 (FRC-I.md §7.19, §11.7): иерархический delta-Q — wire v9/v10
/// плюс refinement-символ δ ∈ −2..+2 (алфавит 5, контекст DQR) перед каждым
/// дочерним узлом 16×16 расщеплённого корня 32×32; эффективная ступень
/// узла = clamp(root_dq + δ, 0, 7), матрицы ступени действуют на всё
/// поддерево узла. Whole-корни оверхеда не несут. Публичный lossy-кодер
/// пишет v11.
pub const VERSION_HIER_AQ: u8 = 11;
/// Максимальная версия, которую читает этот декодер.
pub const VERSION_MAX: u8 = VERSION_HIER_AQ;
/// Минимальная версия, которую декодер обязан читать всегда.
pub const VERSION_MIN: u8 = 1;
/// Длина фиксированного заголовка.
pub const HEADER_LEN: usize = 20;

/// Флаг lossless-режима.
pub const FLAG_LOSSLESS: u8 = 0b0000_0001;
/// Флаг наличия альфа-канала в выходе декодера.
pub const FLAG_ALPHA: u8 = 0b0000_0010;
/// Флаг сабсэмплинга цветоразностей 4:2:0 (только lossy).
pub const FLAG_CHROMA420: u8 = 0b0000_0100;
/// Lossless без цветового преобразования: плоскости R, G, B как есть
/// (кодер выбирает, когда YCoCg-R не окупается — например, слабо
/// коррелированные каналы или шум).
pub const FLAG_IDENTITY: u8 = 0b0000_1000;
/// Палитровый lossless: блок палитры после заголовка, одна плоскость индексов.
pub const FLAG_PALETTE: u8 = 0b0001_0000;
/// Деблокинг-фильтр на выходе декодера (только lossy, только v4+).
pub const FLAG_DEBLOCK: u8 = 0b0010_0000;
/// Блок метаданных (TLV-чанки) после заголовка (только v6+).
pub const FLAG_METADATA: u8 = 0b0100_0000;
const FLAGS_KNOWN_V3: u8 =
    FLAG_LOSSLESS | FLAG_ALPHA | FLAG_CHROMA420 | FLAG_IDENTITY | FLAG_PALETTE;
const FLAGS_KNOWN_V4: u8 = FLAGS_KNOWN_V3 | FLAG_DEBLOCK;
const FLAGS_KNOWN_V6: u8 = FLAGS_KNOWN_V4 | FLAG_METADATA;

/// Тип чанка метаданных: ICC-профиль (байты профиля как есть).
pub const CHUNK_ICC: u8 = 1;
/// Потолок суммарного размера блока метаданных (DoS-защита декодера).
pub const MAX_METADATA: usize = 8 << 20;

/// Максимальная сторона изображения.
pub const MAX_DIM: u32 = 32_768;
/// Лимит пикселей по умолчанию (~67 Мп); переопределяется `DecodeLimits`.
pub const DEFAULT_MAX_PIXELS: u64 = 1 << 26;
/// Максимум записей палитры.
pub const MAX_PALETTE: usize = 256;

/// Сторона тайла: 256 (log2 = 8). Тайлы независимы — база будущего
/// параллельного декодирования без изменения формата.
pub const TILE_SHIFT: u8 = 8;
pub const TILE: usize = 1 << TILE_SHIFT;

/// Разобранный заголовок FRC-I.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Версия битстрима (1..=11); раскладка заголовка у всех одинаковая.
    pub version: u8,
    pub width: u32,
    pub height: u32,
    pub lossless: bool,
    pub alpha: bool,
    pub chroma420: bool,
    pub identity: bool,
    pub palette: bool,
    /// Деблокинг-фильтр на выходе декодера (v4+, только lossy).
    pub deblock: bool,
    /// Блок метаданных после заголовка (v6+; ICC и будущие чанки).
    pub metadata: bool,
    /// 1..=100 для lossy, 0 для lossless.
    pub quality: u8,
}

impl Header {
    pub fn serialize(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = self.version;
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
        if self.identity {
            flags |= FLAG_IDENTITY;
        }
        if self.palette {
            flags |= FLAG_PALETTE;
        }
        if self.deblock {
            flags |= FLAG_DEBLOCK;
        }
        if self.metadata {
            flags |= FLAG_METADATA;
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
            return Err(DecodeError::NotFrcI);
        };
        if head[0..4] != MAGIC {
            return Err(DecodeError::NotFrcI);
        }
        let version = head[4];
        if !(VERSION_MIN..=VERSION_MAX).contains(&version) {
            return Err(DecodeError::UnsupportedVersion(version));
        }
        let flags = head[5];
        let known = if version >= VERSION_METADATA {
            FLAGS_KNOWN_V6
        } else if version >= VERSION_DEBLOCK {
            FLAGS_KNOWN_V4
        } else {
            FLAGS_KNOWN_V3
        };
        if flags & !known != 0 {
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
        let identity = flags & FLAG_IDENTITY != 0;
        let palette = flags & FLAG_PALETTE != 0;
        let chroma420 = flags & FLAG_CHROMA420 != 0;
        let quality = head[15];
        if lossless && quality != 0 {
            return Err(DecodeError::Corrupt("quality != 0 в lossless-режиме"));
        }
        if !lossless && !(1..=100).contains(&quality) {
            return Err(DecodeError::Corrupt("quality вне 1..=100"));
        }
        if (identity || palette) && !lossless {
            return Err(DecodeError::Corrupt(
                "identity/palette допустимы только в lossless",
            ));
        }
        if identity && palette {
            return Err(DecodeError::Corrupt("identity и palette взаимоисключающи"));
        }
        if lossless && chroma420 {
            return Err(DecodeError::Corrupt("сабсэмплинг несовместим с lossless"));
        }
        let deblock = flags & FLAG_DEBLOCK != 0;
        if deblock && lossless {
            return Err(DecodeError::Corrupt("деблокинг несовместим с lossless"));
        }
        if head[16] != TILE_SHIFT {
            return Err(DecodeError::UnsupportedFeature("размер тайла != 256"));
        }
        if head[17..20] != [0, 0, 0] {
            return Err(DecodeError::UnsupportedFeature(
                "ненулевой резерв заголовка",
            ));
        }
        Ok(Self {
            version,
            width,
            height,
            lossless,
            alpha: flags & FLAG_ALPHA != 0,
            chroma420,
            identity,
            palette,
            deblock,
            metadata: flags & FLAG_METADATA != 0,
            quality,
        })
    }

    /// Байт на запись палитры: RGBA при альфе, иначе RGB.
    pub fn palette_entry_len(&self) -> usize {
        if self.alpha { 4 } else { 3 }
    }
}

// --- блок метаданных (v6+) ---------------------------------------------------
//
// Раскладка: `total_len: u32 LE`, затем ровно `total_len` байт TLV-чанков:
// `type: u8`, `len: u32 LE`, `data[len]`. Неизвестные типы декодер пропускает
// (метаданные не влияют на пиксели); повторный тип — ошибка.

/// Сериализует блок метаданных. Вызывающий гарантирует непустой список
/// чанков и суммарный размер в пределах `MAX_METADATA`.
pub fn build_metadata_block(chunks: &[(u8, &[u8])]) -> Vec<u8> {
    let total: usize = chunks.iter().map(|(_, d)| 5 + d.len()).sum();
    debug_assert!(!chunks.is_empty() && total <= MAX_METADATA);
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(total as u32).to_le_bytes());
    for (ty, data) in chunks {
        out.push(*ty);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

/// Разобранные метаданные потока.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    /// ICC-профиль (байты как есть), если присутствует.
    pub icc: Option<Vec<u8>>,
}

/// Разбирает блок метаданных с позиции `offset`; возвращает метаданные и
/// число потреблённых байт. Неизвестные чанки пропускаются.
pub fn parse_metadata_block(bytes: &[u8], offset: usize) -> Result<(Metadata, usize), DecodeError> {
    let total = bytes
        .get(offset..offset + 4)
        .map(|b| u32::from_le_bytes(b.try_into().expect("len 4")) as usize)
        .ok_or(DecodeError::Corrupt("обрыв блока метаданных"))?;
    if total == 0 || total > MAX_METADATA {
        return Err(DecodeError::Corrupt("недопустимый размер метаданных"));
    }
    let body = bytes
        .get(offset + 4..offset + 4 + total)
        .ok_or(DecodeError::Corrupt("обрыв блока метаданных"))?;
    let mut meta = Metadata::default();
    let mut pos = 0usize;
    while pos < body.len() {
        let Some(head) = body.get(pos..pos + 5) else {
            return Err(DecodeError::Corrupt("обрыв чанка метаданных"));
        };
        let ty = head[0];
        let len = u32::from_le_bytes(head[1..5].try_into().expect("len 4")) as usize;
        let Some(data) = body.get(pos + 5..pos + 5 + len) else {
            return Err(DecodeError::Corrupt("обрыв чанка метаданных"));
        };
        if ty == CHUNK_ICC {
            if meta.icc.is_some() {
                return Err(DecodeError::Corrupt("повторный ICC-чанк"));
            }
            if len == 0 {
                return Err(DecodeError::Corrupt("пустой ICC-чанк"));
            }
            meta.icc = Some(data.to_vec());
        }
        pos += 5 + len;
    }
    Ok((meta, 4 + total))
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
            tiles.push(TileRect {
                x0,
                y0,
                w: TILE.min(w - x0),
                h: TILE.min(h - y0),
            });
        }
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Header {
        Header {
            version: VERSION_CURRENT,
            width: 1,
            height: 1,
            lossless: true,
            alpha: false,
            chroma420: false,
            identity: false,
            palette: false,
            deblock: false,
            metadata: false,
            quality: 0,
        }
    }

    #[test]
    fn header_roundtrip() {
        let h = Header {
            width: 1920,
            height: 1080,
            lossless: false,
            alpha: true,
            chroma420: true,
            quality: 75,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
        let h = Header {
            palette: true,
            alpha: true,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
        let h = Header {
            identity: true,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
        // v1-заголовок читается (обратная совместимость навсегда).
        let h = Header {
            version: 1,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
        // v4 с деблокингом (lossy).
        let h = Header {
            version: VERSION_DEBLOCK,
            lossless: false,
            deblock: true,
            chroma420: true,
            quality: 30,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
        // v6 с метаданными (любой режим).
        let h = Header {
            version: VERSION_METADATA,
            metadata: true,
            ..base()
        };
        assert_eq!(Header::parse(&h.serialize()).unwrap(), h);
    }

    #[test]
    fn metadata_flag_rules() {
        // Бит 6 в v5 — неизвестный флаг.
        let mut bytes = Header {
            version: VERSION_SUPERBLOCK,
            lossless: false,
            quality: 75,
            ..base()
        }
        .serialize();
        bytes[5] |= FLAG_METADATA;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedFeature(_))
        ));
    }

    #[test]
    fn metadata_block_roundtrip_and_bounds() {
        let icc = vec![0xAAu8; 300];
        let block = build_metadata_block(&[(CHUNK_ICC, &icc)]);
        let (meta, used) = parse_metadata_block(&block, 0).unwrap();
        assert_eq!(used, block.len());
        assert_eq!(meta.icc.as_deref(), Some(icc.as_slice()));

        // Неизвестный чанк пропускается, ICC после него читается.
        let block = build_metadata_block(&[(200, b"future"), (CHUNK_ICC, &icc)]);
        let (meta, _) = parse_metadata_block(&block, 0).unwrap();
        assert_eq!(meta.icc.as_deref(), Some(icc.as_slice()));

        // Повторный ICC — порча.
        let block = build_metadata_block(&[(CHUNK_ICC, &icc), (CHUNK_ICC, &icc)]);
        assert!(matches!(
            parse_metadata_block(&block, 0),
            Err(DecodeError::Corrupt(_))
        ));

        // Обрыв тела и завышенный total_len.
        let block = build_metadata_block(&[(CHUNK_ICC, &icc)]);
        assert!(parse_metadata_block(&block[..block.len() - 1], 0).is_err());
        let mut bad = block.clone();
        bad[0..4].copy_from_slice(&(u32::MAX).to_le_bytes());
        assert!(parse_metadata_block(&bad, 0).is_err());
        // Нулевой total_len — тоже порча (флаг без содержимого).
        assert!(parse_metadata_block(&[0, 0, 0, 0], 0).is_err());
        // Чанк с len, выходящим за тело блока.
        let mut bad = block;
        let cut = bad.len() - 6;
        bad.truncate(cut);
        bad[0..4].copy_from_slice(&((cut - 4) as u32).to_le_bytes());
        assert!(parse_metadata_block(&bad, 0).is_err());
    }

    #[test]
    fn deblock_flag_rules() {
        // Бит 5 в v3 — неизвестный флаг.
        let mut bytes = Header {
            lossless: false,
            quality: 30,
            ..base()
        }
        .serialize();
        bytes[5] |= FLAG_DEBLOCK;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedFeature(_))
        ));
        // Деблокинг в lossless — противоречие (даже в v4).
        let mut bytes = Header {
            version: VERSION_DEBLOCK,
            ..base()
        }
        .serialize();
        bytes[5] |= FLAG_DEBLOCK;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::Corrupt(_))
        ));
    }

    #[test]
    fn rejects_bad_magic_and_version() {
        let mut bytes = base().serialize();
        bytes[0] = b'P';
        assert_eq!(Header::parse(&bytes), Err(DecodeError::NotFrcI));
        let mut bytes = base().serialize();
        bytes[4] = VERSION_MAX + 1;
        assert_eq!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedVersion(VERSION_MAX + 1))
        );
        let mut bytes = base().serialize();
        bytes[4] = 0;
        assert_eq!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedVersion(0))
        );
    }

    #[test]
    fn rejects_reserved_bits_and_bad_combos() {
        let mut bytes = base().serialize();
        bytes[5] |= 0b1000_0000;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedFeature(_))
        ));

        let mut bytes = base().serialize();
        bytes[18] = 1;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::UnsupportedFeature(_))
        ));

        // identity в lossy — противоречие.
        let mut bytes = base().serialize();
        bytes[5] = FLAG_IDENTITY; // без FLAG_LOSSLESS
        bytes[15] = 50;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::Corrupt(_))
        ));

        // identity + palette одновременно.
        let mut bytes = base().serialize();
        bytes[5] = FLAG_LOSSLESS | FLAG_IDENTITY | FLAG_PALETTE;
        assert!(matches!(
            Header::parse(&bytes),
            Err(DecodeError::Corrupt(_))
        ));
    }

    #[test]
    fn tile_grid_covers_image() {
        let tiles = tile_grid(600, 300);
        assert_eq!(tiles.len(), 3 * 2);
        let area: usize = tiles.iter().map(|t| t.w * t.h).sum();
        assert_eq!(area, 600 * 300);
    }
}
