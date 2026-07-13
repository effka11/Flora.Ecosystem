//! Устойчивость декодера: контракт «любые байты → Ok | Err, без паник
//! и без аллокаций сверх лимитов» (FIC.md §9).
//!
//! Тесты гоняются в debug-профиле CI, поэтому арифметические переполнения
//! в путях декодера приводили бы к панике и провалу.

use flora_image_codec::{DecodeError, DecodeLimits, decode, decode_with_limits};
use flora_image_codec::{EncodeMode, ImageView, PixelFormat, encode};

fn xorshift(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

fn sample_fic() -> Vec<u8> {
    let (w, h) = (90u32, 70u32);
    let data: Vec<u8> = (0..w * h * 3).map(|i| (i % 251) as u8).collect();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &data,
    };
    encode(&img, EncodeMode::Lossy { quality: 60 }).unwrap()
}

/// Представители каждого вида потока: DCT, планарный lossless, палитра
/// (текущая версия кодера) плюс закоммиченные v1/v2-потоки — пути
/// совместимости фуззятся наравне с текущим.
fn sample_streams() -> Vec<Vec<u8>> {
    let (w, h) = (90u32, 70u32);
    let gradient: Vec<u8> = (0..w * h * 3).map(|i| (i % 251) as u8).collect();
    let flat: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            if (i / 10) % 2 == 0 {
                [255u8, 0, 0]
            } else {
                [0u8, 0, 255]
            }
        })
        .collect();
    let g = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &gradient,
    };
    let f = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &flat,
    };
    let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    vec![
        encode(&g, EncodeMode::Lossy { quality: 60 }).unwrap(),
        encode(&g, EncodeMode::Lossless).unwrap(),
        encode(&f, EncodeMode::Lossless).unwrap(), // палитра (2 цвета)
        std::fs::read(data_dir.join("golden-v1-lossy-q75.fic")).expect("v1 lossy"),
        std::fs::read(data_dir.join("golden-v1-lossless.fic")).expect("v1 lossless"),
        std::fs::read(data_dir.join("golden-v1-palette.fic")).expect("v1 palette"),
        std::fs::read(data_dir.join("golden-v2-lossy-q75.fic")).expect("v2 lossy"),
        std::fs::read(data_dir.join("golden-v2-lossless.fic")).expect("v2 lossless"),
        std::fs::read(data_dir.join("golden-v2-palette.fic")).expect("v2 palette"),
    ]
}

#[test]
fn random_garbage_never_panics() {
    let mut seed = 0xC0FFEEu64;
    for len in [0usize, 1, 4, 19, 20, 21, 64, 300, 5000] {
        for _ in 0..200 {
            let garbage: Vec<u8> = (0..len)
                .map(|_| (xorshift(&mut seed) & 0xFF) as u8)
                .collect();
            let _ = decode(&garbage); // важно только отсутствие паники
        }
    }
}

#[test]
fn garbage_with_valid_magic_never_panics() {
    let mut seed = 0xBADF00Du64;
    for version in [1u8, 2, 3] {
        for _ in 0..500 {
            let len = 20 + (xorshift(&mut seed) % 400) as usize;
            let mut bytes: Vec<u8> = (0..len)
                .map(|_| (xorshift(&mut seed) & 0xFF) as u8)
                .collect();
            bytes[0..4].copy_from_slice(&[0x8F, b'F', b'I', b'C']);
            bytes[4] = version;
            let _ = decode(&bytes);
        }
    }
}

#[test]
fn every_truncation_of_valid_stream_errors_cleanly() {
    for fic in sample_streams() {
        for cut in 0..fic.len() {
            let err = decode(&fic[..cut]);
            assert!(
                err.is_err(),
                "обрезка до {cut} байт не должна декодироваться"
            );
        }
    }
}

#[test]
fn single_byte_flips_never_panic() {
    let mut seed = 0x5EEDu64;
    for fic in sample_streams() {
        for _ in 0..2000 {
            let mut mutated = fic.clone();
            let pos = (xorshift(&mut seed) as usize) % mutated.len();
            let bit = 1u8 << (xorshift(&mut seed) % 8);
            mutated[pos] ^= bit;
            let _ = decode(&mutated); // Ok (безобидный бит) или Err — но не паника
        }
    }
}

#[test]
fn appended_trailing_bytes_are_rejected() {
    let mut fic = sample_fic();
    fic.push(0);
    assert!(matches!(decode(&fic), Err(DecodeError::Corrupt(_))));
}

#[test]
fn huge_dimensions_rejected_before_allocation() {
    // Заголовок заявляет 32768x32768 (1 гигапиксель) — декодер обязан
    // отказаться по лимиту до каких-либо аллокаций под плоскости.
    let mut bytes = vec![0u8; 64];
    bytes[0..4].copy_from_slice(&[0x8F, b'F', b'I', b'C']);
    bytes[4] = 1;
    bytes[5] = 0b0000_0001;
    bytes[6..10].copy_from_slice(&32_768u32.to_le_bytes());
    bytes[10..14].copy_from_slice(&32_768u32.to_le_bytes());
    bytes[14] = 8;
    bytes[16] = 8;
    assert!(matches!(decode(&bytes), Err(DecodeError::TooLarge { .. })));
}

#[test]
fn custom_limits_are_enforced() {
    let fic = sample_fic(); // 90x70 = 6300 пикселей
    assert!(decode_with_limits(&fic, DecodeLimits { max_pixels: 6299 }).is_err());
    assert!(decode_with_limits(&fic, DecodeLimits { max_pixels: 6300 }).is_ok());
}

#[test]
fn declared_tile_lengths_cannot_overrun() {
    let mut fic = sample_fic();
    // Портим таблицу тайлов: длина первого тайла = u32::MAX.
    fic[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode(&fic).is_err());
}
