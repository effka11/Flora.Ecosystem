//! Golden-вектора формата FIC: заморозка байтов битстрима.
//!
//! Два уровня гарантий:
//!
//! - **v1 (decode-заморозка).** Файлы `golden-v1-*.fic` закоммичены навсегда
//!   и никогда не регенерируются: декодер обязан читать их побайтно одинаково
//!   в любой будущей версии кодека. Это контракт обратной совместимости.
//! - **v2 (encode-заморозка).** Файлы `golden-v2-*.fic` фиксируют текущий
//!   выход кодера. Меняться они могут только осознанным решением (улучшение
//!   кодера): `FIC_UPDATE_GOLDEN=1 cargo test -p flora-image-codec --test
//!   golden` — и коммитятся вместе с изменением.

use flora_image_codec::{EncodeMode, ImageView, PixelFormat, decode, encode, read_info};
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
    if std::env::var_os("FIC_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().expect("data dir")).expect("mkdir");
        std::fs::write(&path, produced).expect("запись golden-вектора");
        return;
    }
    let expected = std::fs::read(&path)
        .unwrap_or_else(|_| panic!("нет golden-файла {name}; сгенерируй FIC_UPDATE_GOLDEN=1"));
    assert_eq!(
        expected, produced,
        "битстрим {name} разошёлся с golden-вектором: формат менять только осознанно"
    );
}

// --- v2: encode-заморозка текущего кодера --------------------------------------

#[test]
fn golden_v2_lossless_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fic = encode(&img, EncodeMode::Lossless).unwrap();
    assert_eq!(read_info(&fic).unwrap().version, 2);
    check_or_update("golden-v2-lossless.fic", &fic);
    // Lossless обязан вернуть источник побайтно.
    assert_eq!(decode(&fic).unwrap().data, data);
}

#[test]
fn golden_v2_palette_bitstream_frozen() {
    // Малоцветная графика: кодер обязан выбрать палитровый поток —
    // замораживаем и этот вид контейнера (блок палитры + плоскость индексов).
    let (w, h, data) = palette_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &data,
    };
    let fic = encode(&img, EncodeMode::Lossless).unwrap();
    assert!(read_info(&fic).unwrap().palette);
    check_or_update("golden-v2-palette.fic", &fic);
    assert_eq!(decode(&fic).unwrap().data, data);
}

#[test]
fn golden_v2_lossy_bitstream_frozen() {
    let (w, h, data) = golden_source();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data: &data,
    };
    let fic = encode(&img, EncodeMode::Lossy { quality: 75 }).unwrap();
    check_or_update("golden-v2-lossy-q75.fic", &fic);
}

#[test]
fn golden_v2_lossy_decode_is_deterministic() {
    // Детерминизм декодера (включая f32 DCT с константным базисом):
    // хеш пиксельного выхода зафиксирован. Проверяется на закоммиченном
    // файле — потоки обязаны декодироваться одинаково всегда.
    const EXPECTED_FNV1A: u64 = 0x2103_8208_73FC_2C44;
    if std::env::var_os("FIC_UPDATE_GOLDEN").is_some() {
        // Кодируем в процессе (не читаем файл: тесты идут параллельно).
        let (w, h, data) = golden_source();
        let img = ImageView {
            width: w,
            height: h,
            format: PixelFormat::Rgba8,
            data: &data,
        };
        let fic = encode(&img, EncodeMode::Lossy { quality: 75 }).unwrap();
        let out = decode(&fic).unwrap();
        println!("golden v2 decode fnv1a = {:#018X}", fnv1a(&out.data));
        return;
    }
    let fic = std::fs::read(data_path("golden-v2-lossy-q75.fic")).expect("нет golden-файла");
    let out = decode(&fic).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(
        fnv1a(&out.data),
        EXPECTED_FNV1A,
        "выход декодера недетерминирован"
    );
}

// --- v1: decode-заморозка (файлы никогда не регенерируются) ---------------------

#[test]
fn golden_v1_lossless_decodes_exactly_forever() {
    let fic = std::fs::read(data_path("golden-v1-lossless.fic")).expect("нет файла v1");
    assert_eq!(read_info(&fic).unwrap().version, 1);
    let (_, _, data) = golden_source();
    assert_eq!(
        decode(&fic).unwrap().data,
        data,
        "v1-поток обязан декодироваться побайтно точно в любой версии кодека"
    );
}

#[test]
fn golden_v1_palette_decodes_exactly_forever() {
    let fic = std::fs::read(data_path("golden-v1-palette.fic")).expect("нет файла v1");
    assert_eq!(read_info(&fic).unwrap().version, 1);
    let (_, _, data) = palette_source();
    assert_eq!(decode(&fic).unwrap().data, data);
}

#[test]
fn golden_v1_lossy_decodes_deterministically_forever() {
    // Хеш зафиксирован в момент заморозки v1 и не меняется никогда.
    const EXPECTED_FNV1A: u64 = 0x0571_1566_3CEA_8D7B;
    let fic = std::fs::read(data_path("golden-v1-lossy-q75.fic")).expect("нет файла v1");
    assert_eq!(read_info(&fic).unwrap().version, 1);
    let out = decode(&fic).unwrap();
    assert_eq!((out.width, out.height), (97, 61));
    assert_eq!(fnv1a(&out.data), EXPECTED_FNV1A, "декодирование v1 разошлось");
}
