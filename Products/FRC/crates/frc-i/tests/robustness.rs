//! Устойчивость декодера: контракт «любые байты → Ok | Err, без паник
//! и без аллокаций сверх лимитов» (FRC-I.md §9).
//!
//! Тесты гоняются в debug-профиле CI, поэтому арифметические переполнения
//! в путях декодера приводили бы к панике и провалу.

use frc_i::{DecodeError, DecodeLimits, decode, decode_with_limits};
use frc_i::{
    EncodeMode, ImageView, PixelFormat, encode, encode_with_icc, encode_with_version, read_icc,
};

fn xorshift(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

fn sample_fri() -> Vec<u8> {
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
/// (текущая версия кодера).
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
    vec![
        encode(&g, EncodeMode::Lossy { quality: 60 }).unwrap(),
        encode(&g, EncodeMode::Lossy { quality: 30 }).unwrap(), // v4 (деблокинг)
        encode(&g, EncodeMode::Lossless).unwrap(),
        encode(&f, EncodeMode::Lossless).unwrap(), // палитра (2 цвета)
        encode_with_icc(&g, EncodeMode::Lossy { quality: 60 }, &[1, 2, 3, 4]).unwrap(), // v6
        encode_with_version(&g, EncodeMode::Lossy { quality: 60 }, 7).unwrap(), // v7 (адаптивный)
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
    for version in [1u8, 2, 3, 4, 5, 6, 7] {
        for _ in 0..500 {
            let len = 20 + (xorshift(&mut seed) % 400) as usize;
            let mut bytes: Vec<u8> = (0..len)
                .map(|_| (xorshift(&mut seed) & 0xFF) as u8)
                .collect();
            bytes[0..4].copy_from_slice(&[0x8F, b'F', b'R', b'I']);
            bytes[4] = version;
            let _ = decode(&bytes);
        }
    }
}

#[test]
fn every_truncation_of_valid_stream_errors_cleanly() {
    for fri in sample_streams() {
        for cut in 0..fri.len() {
            let err = decode(&fri[..cut]);
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
    for fri in sample_streams() {
        for _ in 0..2000 {
            let mut mutated = fri.clone();
            let pos = (xorshift(&mut seed) as usize) % mutated.len();
            let bit = 1u8 << (xorshift(&mut seed) % 8);
            mutated[pos] ^= bit;
            let _ = decode(&mutated); // Ok (безобидный бит) или Err — но не паника
        }
    }
}

#[test]
fn appended_trailing_bytes_are_rejected() {
    let mut fri = sample_fri();
    fri.push(0);
    assert!(matches!(decode(&fri), Err(DecodeError::Corrupt(_))));
}

#[test]
fn huge_dimensions_rejected_before_allocation() {
    // Заголовок заявляет 32768x32768 (1 гигапиксель) — декодер обязан
    // отказаться по лимиту до каких-либо аллокаций под плоскости.
    let mut bytes = vec![0u8; 64];
    bytes[0..4].copy_from_slice(&[0x8F, b'F', b'R', b'I']);
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
    let fri = sample_fri(); // 90x70 = 6300 пикселей
    assert!(decode_with_limits(&fri, DecodeLimits { max_pixels: 6299 }).is_err());
    assert!(decode_with_limits(&fri, DecodeLimits { max_pixels: 6300 }).is_ok());
}

#[test]
fn metadata_block_cannot_claim_giant_length() {
    // total_len блока метаданных = u32::MAX: декодер обязан отвергнуть
    // по потолку MAX_METADATA, не пытаясь читать/аллоцировать 4 ГиБ.
    let (w, h) = (16u32, 16u32);
    let data: Vec<u8> = (0..w * h * 3).map(|i| (i % 251) as u8).collect();
    let img = ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgb8,
        data: &data,
    };
    let mut fri = encode_with_icc(&img, EncodeMode::Lossless, &[9u8; 16]).unwrap();
    fri[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(decode(&fri), Err(DecodeError::Corrupt(_))));
    assert!(matches!(read_icc(&fri), Err(DecodeError::Corrupt(_))));
}

#[test]
fn declared_tile_lengths_cannot_overrun() {
    let mut fri = sample_fri();
    // Портим таблицу тайлов: длина первого тайла = u32::MAX.
    fri[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode(&fri).is_err());
}
