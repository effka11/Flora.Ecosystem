//! Golden-вектора формата FRC-I: заморозка байтов битстрима.
//!
//! Два уровня гарантий (FRC-I.md §10):
//!
//! - **Выпущенные версии (decode-заморозка).** Все закоммиченные `.fri`
//!   декодируются одинаково всегда; старые v1/v2/v6 не регенерируются.
//! - **Reference encoder.** Legacy v3/v4/v5 фиксируются через явную
//!   `encode_with_version` и могут служебно регенерироваться с
//!   `FRC_I_UPDATE_GOLDEN=1`. Замороженные lossy v7/v8/v9/v10 фиксируются через
//!   явные `encode_with_version`/`encode_with_icc_version` и неизменяемы:
//!   расхождение — ошибка реализации. Текущий frozen v10 также пишется
//!   публичными `encode`/`encode_with_icc`.

use frc_i::{
    EncodeMode, ImageView, PixelFormat, decode, encode, encode_with_icc, encode_with_icc_version,
    encode_with_version, read_icc, read_info,
};
use std::path::PathBuf;

/// Детерминированное тестовое изображение 97x61 RGBA: градиенты, границы, шум.
fn golden_source() -> (u32, u32, Vec<u8>) {
    let (w, h) = (97u32, 61u32);
    let mut seed = 0x0F1C_0001u64;
    let mut xorshift = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let n = (xorshift() % 24) as i32 - 12;
            let edge = i32::from(x > w / 2 && y > h / 3) * 90;
            data.push(((x * 2) as i32 + n + edge).clamp(0, 255) as u8);
            data.push(((y * 3) as i32 + n / 2).clamp(0, 255) as u8);
            data.push((((x + y) * 2) as i32 - n + edge / 2).clamp(0, 255) as u8);
            data.push(if (x / 8 + y / 8) % 2 == 0 { 255 } else { 200 });
        }
    }
    (w, h, data)
}

/// Источник v10 с root-local высокочастотной активностью разной силы.
/// Он обязан разводить симметричный AQ v9 и асимметричный AQ v10 не только
/// байтом версии, иначе encode-golden не защищал бы новые решения кодера.
fn golden_v10_source() -> (u32, u32, Vec<u8>) {
    let (w, h) = (193u32, 129u32);
    let root_cols = w.div_ceil(32);
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let root = x / 32 + (y / 32) * root_cols;
            let amplitude = 1 + (root * 7 % 24) as i32;
            let texture = if (x + y) & 1 == 0 {
                amplitude
            } else {
                -amplitude
            };
            let ramp = 36 + (x * 116 / w + y * 48 / h) as i32;
            data.push((ramp + texture).clamp(0, 255) as u8);
            data.push((ramp + 12 + texture).clamp(0, 255) as u8);
            data.push((ramp - 8 + texture).clamp(0, 255) as u8);
            data.push(if (x / 11 + y / 7) % 2 == 0 { 255 } else { 208 });
        }
    }
    (w, h, data)
}

/// Малоцветная графика 80x50 RGB — источник палитровых потоков.
fn palette_source() -> (u32, u32, Vec<u8>) {
    let (w, h) = (80u32, 50u32);
    let colors: [[u8; 3]; 4] = [[250, 250, 245], [16, 16, 24], [214, 40, 40], [0, 121, 107]];
    let data: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let (x, y) = (i % w, i / w);
            colors[((x / 10 + y / 10) % 4) as usize]
        })
        .collect();
    (w, h, data)
}

fn data_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data")
        .join(name)
}

/// FNV-1a — контрольная сумма пиксельного выхода без внешних зависимостей.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xCBF2_9CE4_8422_2325u64;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    hash
}

fn check_or_update(name: &str, produced: &[u8]) {
    let path = data_path(name);
    if std::env::var_os("FRC_I_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().expect("data dir")).expect("mkdir");
        std::fs::write(&path, produced).expect("запись golden-вектора");
        return;
    }
    let expected = std::fs::read(&path)
        .unwrap_or_else(|_| panic!("нет golden-файла {name}; сгенерируй FRC_I_UPDATE_GOLDEN=1"));
    assert_eq!(
        expected, produced,
        "битстрим {name} разошёлся с golden-вектором: формат менять только осознанно"
    );
}

fn check_frozen(name: &str, produced: &[u8]) {
    let expected = std::fs::read(data_path(name))
        .unwrap_or_else(|_| panic!("нет замороженного golden-файла {name}"));
    assert_eq!(
        expected, produced,
        "битстрим {name} разошёлся с замороженной версией: требуется новая версия формата"
    );
}

// --- v1: decode-заморозка (файлы никогда не регенерируются) ---------------------

#[test]
fn golden_v1_lossless_decodes_exactly_forever() {
    let fri = std::fs::read(data_path("golden-v1-lossless.fri")).expect("нет файла v1");
    assert_eq!(read_info(&fri).unwrap().version, 1);
    let (_, _, data) = golden_source();
    assert_eq!(
        decode(&fri).unwrap().data,
        data,
        "v1-поток обязан декодироваться побайтно точно в любой версии кодека"
    );
}

#[test]
fn golden_v1_palette_decodes_exactly_forever() {
    let fri = std::fs::read(data_path("golden-v1-palette.fri")).expect("нет файла v1");
    assert_eq!(read_info(&fri).unwrap().version, 1);
    let (_, _, data) = palette_source();
    assert_eq!(decode(&fri).unwrap().data, data);
}

#[test]
fn golden_v1_lossy_decodes_deterministically_forever() {
    const EXPECTED_FNV1A: u64 = 0x0571_1566_3CEA_8D7B;
    let fri = std::fs::read(data_path("golden-v1-lossy-q75.fri")).expect("нет файла v1");
    assert_eq!(read_info(&fri).unwrap().version, 1);
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "декодирование v1 разошлось"
    );
}

// --- v2: decode-заморозка (файлы никогда не регенерируются) ---------------------

#[test]
fn golden_v2_lossless_decodes_exactly_forever() {
    seed_v2_golden_if_requested();
    let fri = std::fs::read(data_path("golden-v2-lossless.fri")).expect("нет файла v2");
    assert_eq!(read_info(&fri).unwrap().version, 2);
    let (_, _, data) = golden_source();
    assert_eq!(decode(&fri).unwrap().data, data);
}

#[test]
fn golden_v2_palette_decodes_exactly_forever() {
    seed_v2_golden_if_requested();
    let fri = std::fs::read(data_path("golden-v2-palette.fri")).expect("нет файла v2");
    assert_eq!(read_info(&fri).unwrap().version, 2);
    let (_, _, data) = palette_source();
    assert_eq!(decode(&fri).unwrap().data, data);
}

#[test]
fn golden_v2_lossy_decodes_deterministically_forever() {
    seed_v2_golden_if_requested();
    let fri = std::fs::read(data_path("golden-v2-lossy-q75.fri")).expect("нет файла v2");
    assert_eq!(read_info(&fri).unwrap().version, 2);
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    if std::env::var_os("FRC_I_SEED_V2_GOLDEN").is_some() {
        println!("golden v2 decode fnv1a = {:#018X}", fnv1a(&out.data));
        return;
    }
    const EXPECTED_FNV1A: u64 = 0x5EBE_4105_EC9F_4358;
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "декодирование v2 разошлось"
    );
}

/// Однократная генерация v2 decode-freeze (потеряны при ребрендинге FIC→FRC-I).
fn seed_v2_golden_if_requested() {
    if !std::env::var_os("FRC_I_SEED_V2_GOLDEN").is_some() {
        return;
    }
    let names = [
        ("golden-v2-lossless.fri", {
            let (w, h, data) = golden_source();
            let img = ImageView {
                width: w,
                height: h,
                format: PixelFormat::Rgba8,
                data: &data,
            };
            frc_i::encode_with_version(&img, EncodeMode::Lossless, 2).unwrap()
        }),
        ("golden-v2-palette.fri", {
            let (w, h, data) = palette_source();
            let img = ImageView {
                width: w,
                height: h,
                format: PixelFormat::Rgb8,
                data: &data,
            };
            frc_i::encode_with_version(&img, EncodeMode::Lossless, 2).unwrap()
        }),
        ("golden-v2-lossy-q75.fri", {
            let (w, h, data) = golden_source();
            let img = ImageView {
                width: w,
                height: h,
                format: PixelFormat::Rgba8,
                data: &data,
            };
            frc_i::encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 2).unwrap()
        }),
    ];
    for (name, bytes) in names {
        let path = data_path(name);
        std::fs::create_dir_all(path.parent().expect("data dir")).expect("mkdir");
        std::fs::write(&path, bytes).expect("запись v2 golden");
    }
}

// --- v3: encode-заморозка текущего кодера --------------------------------------

#[test]
fn golden_v3_lossless_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode(&img, EncodeMode::Lossless).unwrap();
    assert_eq!(read_info(&fri).unwrap().version, 3);
    check_or_update("golden-v3-lossless.fri", &fri);
    // Lossless обязан вернуть источник побайтно.
    assert_eq!(decode(&fri).unwrap().data, data);
}

#[test]
fn golden_v3_palette_bitstream_frozen() {
    // Малоцветная графика: кодер обязан выбрать палитровый поток —
    // замораживаем и этот вид контейнера (блок палитры + плоскость индексов).
    let (w, h, data) = palette_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &data,
    };
    let fri = encode(&img, EncodeMode::Lossless).unwrap();
    assert!(read_info(&fri).unwrap().palette);
    check_or_update("golden-v3-palette.fri", &fri);
    assert_eq!(decode(&fri).unwrap().data, data);
}

#[test]
fn golden_v3_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 3).unwrap();
    assert_eq!(read_info(&fri).unwrap().version, 3);
    check_or_update("golden-v3-lossy-q75.fri", &fri);
}

// --- v4: encode-заморозка (деблокинг, q < 45) ----------------------------------

#[test]
fn golden_v4_lossy_deblock_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 30 }, 4).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 4);
    assert!(info.deblock, "v4 q=30 должен включать деблокинг");
    check_or_update("golden-v4-lossy-q30.fri", &fri);
}

#[test]
fn golden_v4_lossy_decode_is_deterministic() {
    // Детерминизм декодера с деблокингом: хеш пиксельного выхода зафиксирован.
    const EXPECTED_FNV1A: u64 = 0x7CA1_876A_CD04_7FD4;
    if std::env::var_os("FRC_I_UPDATE_GOLDEN").is_some() {
        let (w, h, data) = golden_source();
        let img = ImageView {
            width: w,
            height: h,
            format: PixelFormat::Rgba8,
            data: &data,
        };
        let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 30 }, 4).unwrap();
        let out = decode(&fri).unwrap();
        println!("golden v4 decode fnv1a = {:#018X}", fnv1a(&out.data));
        return;
    }
    let fri = std::fs::read(data_path("golden-v4-lossy-q30.fri")).expect("нет golden-файла");
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера v4 недетерминирован"
    );
}

// --- v5: encode-заморозка (суперблоки 16×16) ------------------------------------

#[test]
fn golden_v5_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 5).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 5);
    assert!(!info.deblock, "q=75 без деблокинга");
    check_or_update("golden-v5-lossy-q75.fri", &fri);
}

#[test]
fn golden_v5_lossy_decode_is_deterministic() {
    const EXPECTED_FNV1A: u64 = 0xD44B_8BBB_4520_2C1B;
    if std::env::var_os("FRC_I_UPDATE_GOLDEN").is_some() {
        let (w, h, data) = golden_source();
        let img = ImageView {
            width: w,
            height: h,
            format: PixelFormat::Rgba8,
            data: &data,
        };
        let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 5).unwrap();
        let out = decode(&fri).unwrap();
        println!("golden v5 decode fnv1a = {:#018X}", fnv1a(&out.data));
        return;
    }
    let fri = std::fs::read(data_path("golden-v5-lossy-q75.fri")).expect("нет golden-файла");
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера v5 недетерминирован"
    );
}

// --- v6: decode-заморозка (блок метаданных: ICC) --------------------------------

/// Детерминированный псевдо-ICC-профиль для golden-вектора.
fn golden_icc() -> Vec<u8> {
    (0..256u32).map(|i| (i * 31 % 253) as u8).collect()
}

#[test]
fn golden_v6_lossy_icc_decodes_forever() {
    const EXPECTED_FNV1A: u64 = 0xD44B_8BBB_4520_2C1B;
    let icc = golden_icc();
    let fri = std::fs::read(data_path("golden-v6-lossy-icc-q75.fri")).expect("нет golden-файла v6");
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 6, "ICC требует v6");
    assert!(info.metadata);
    let out = decode(&fri).unwrap();
    assert_eq!(out.icc.as_deref(), Some(icc.as_slice()));
    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    assert_eq!(fnv1a(&out.data), EXPECTED_FNV1A);
}

// --- v7: encode-заморозка (адаптивная lossy-линия v7.9a) ------------------------

#[test]
fn golden_v7_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 7).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 7);
    assert!(!info.metadata);
    check_frozen("golden-v7-lossy-q75.fri", &fri);

    let decoded = decode(&fri).unwrap();
    const EXPECTED_FNV1A: u64 = 0x296E_04F9_9FB4_FEEE;
    assert_eq!(fnv1a(&decoded.data), EXPECTED_FNV1A);
}

#[test]
fn golden_v7_lossy_icc_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let icc = golden_icc();
    let fri = encode_with_icc_version(&img, EncodeMode::Lossy { quality: 75 }, &icc, 7).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 7);
    assert!(info.metadata);
    check_frozen("golden-v7-lossy-icc-q75.fri", &fri);

    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    let decoded = decode(&fri).unwrap();
    assert_eq!(decoded.icc.as_deref(), Some(icc.as_slice()));
    const EXPECTED_FNV1A: u64 = 0x296E_04F9_9FB4_FEEE;
    assert_eq!(fnv1a(&decoded.data), EXPECTED_FNV1A);
}

// --- v8: encode-заморозка (целочисленный lossy-YCoCg) ---------------------------

#[test]
fn golden_v8_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 8).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 8);
    assert!(!info.metadata);
    check_frozen("golden-v8-lossy-q75.fri", &fri);

    const EXPECTED_FNV1A: u64 = 0x5A62_D97B_BF23_431E;
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера v8 недетерминирован"
    );
}

#[test]
fn golden_v8_lossy_icc_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let icc = golden_icc();
    let fri = encode_with_icc_version(&img, EncodeMode::Lossy { quality: 75 }, &icc, 8).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 8);
    assert!(info.metadata);
    check_frozen("golden-v8-lossy-icc-q75.fri", &fri);
    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    let decoded = decode(&fri).unwrap();
    assert_eq!(decoded.icc.as_deref(), Some(icc.as_slice()));
}

// --- v9: encode-заморозка (per-root delta-Q) -------------------------------------

#[test]
fn golden_v9_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 9).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 9);
    assert!(!info.metadata);
    check_frozen("golden-v9-lossy-q75.fri", &fri);

    const EXPECTED_FNV1A: u64 = 0x13BA_2A93_673C_50A4;
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера v9 недетерминирован"
    );
}

#[test]
fn golden_v9_lossy_icc_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let icc = golden_icc();
    let fri = encode_with_icc_version(&img, EncodeMode::Lossy { quality: 75 }, &icc, 9).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 9);
    assert!(info.metadata);
    check_frozen("golden-v9-lossy-icc-q75.fri", &fri);
    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    let decoded = decode(&fri).unwrap();
    assert_eq!(decoded.icc.as_deref(), Some(icc.as_slice()));
}

// --- v10: encode-заморозка (асимметричный AQ поверх wire v9) --------------------

#[test]
fn golden_v10_lossy_bitstream_frozen() {
    let (w, h, data) = golden_v10_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fri = encode(&img, EncodeMode::Lossy { quality: 75 }).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 10, "публичный lossy-кодер должен писать v10");
    assert!(!info.metadata);
    check_frozen("golden-v10-lossy-q75.fri", &fri);
    let mut relabeled_v9 = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 9).unwrap();
    relabeled_v9[4] = 10;
    assert_ne!(
        fri, relabeled_v9,
        "v10 golden обязан фиксировать новые AQ-решения, а не только version byte"
    );
    assert_eq!(
        fri,
        encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 10).unwrap(),
        "публичный encode() обязан совпадать с явным v10"
    );
}

#[test]
fn golden_v10_lossy_decode_is_deterministic() {
    const EXPECTED_FNV1A: u64 = 0x571A_3448_1467_32A5;
    let fri = std::fs::read(data_path("golden-v10-lossy-q75.fri")).expect("нет golden-файла v10");
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (193, 129));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера v10 недетерминирован"
    );
}

#[test]
fn golden_v10_lossy_icc_bitstream_frozen() {
    let (w, h, data) = golden_v10_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let icc = golden_icc();
    let fri = encode_with_icc(&img, EncodeMode::Lossy { quality: 75 }, &icc).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 10);
    assert!(info.metadata);
    check_frozen("golden-v10-lossy-icc-q75.fri", &fri);
    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    let decoded = decode(&fri).unwrap();
    assert_eq!(decoded.icc.as_deref(), Some(icc.as_slice()));
}

#[test]
fn golden_v3_lossy_decode_is_deterministic() {
    // Детерминизм декодера (включая f32 DCT с константным базисом):
    // хеш пиксельного выхода зафиксирован. Проверяется на закоммиченном
    // файле — потоки обязаны декодироваться одинаково всегда.
    const EXPECTED_FNV1A: u64 = 0x6FE6_6A87_AB82_3EFE;
    if std::env::var_os("FRC_I_UPDATE_GOLDEN").is_some() {
        // Кодируем в процессе (не читаем файл: тесты идут параллельно).
        let (w, h, data) = golden_source();
        let img = ImageView {
            width: w,
            height: h,
            format: PixelFormat::Rgba8,
            data: &data,
        };
        let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 3).unwrap();
        let out = decode(&fri).unwrap();
        println!("golden v3 decode fnv1a = {:#018X}", fnv1a(&out.data));
        return;
    }
    let fri = std::fs::read(data_path("golden-v3-lossy-q75.fri")).expect("нет golden-файла");
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера недетерминирован"
    );
}
