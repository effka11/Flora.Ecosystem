//! Архив совместимости декодера: исторические потоки FRV1 обязаны
//! декодироваться бит-в-бит вечно.
//!
//! В отличие от `golden.rs` (пины референсного энкодера — осознанно
//! регенерируются, когда меняются *решения* энкодера при неизменном формате),
//! архив **никогда не регенерируется**: сюда только добавляются новые эры.
//! Расхождение = несовместимое изменение декодера → требуется bump
//! `BITSTREAM_VERSION`, старые потоки при этом обязаны остаться читаемыми.
//!
//! Формат: `tests/data/archive/<era>_<name>.frv` + строки
//! `<era>_<name> <кадр> <fnv64>` в `archive.sums`.
//!
//! - **era1** — битстрим v2, энкодер v0.7 (intra+inter, до temporal-MV).

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use common::frame_fnv64;
use frc_v::Decoder;
use frc_v::container::FrcVReader;

fn archive_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/archive")
}

#[test]
fn archive_decode_pins() {
    let dir = archive_dir();
    let sums_text =
        std::fs::read_to_string(dir.join("archive.sums")).expect("tests/data/archive/archive.sums");

    // name → ожидаемые чексаммы кадров по порядку.
    let mut expected: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    for line in sums_text.lines().filter(|l| !l.trim().is_empty()) {
        let mut parts = line.split_whitespace();
        let name = parts.next().expect("vector name").to_string();
        let idx: usize = parts.next().expect("frame index").parse().expect("index");
        let sum = u64::from_str_radix(parts.next().expect("fnv64"), 16).expect("hex sum");
        let frames = expected.entry(name).or_default();
        assert_eq!(frames.len(), idx, "archive.sums frames must be sequential");
        frames.push(sum);
    }
    assert!(!expected.is_empty(), "archive must not be empty");

    for (name, sums) in &expected {
        let path = dir.join(format!("{name}.frv"));
        let bytes =
            std::fs::read(&path).unwrap_or_else(|e| panic!("{} missing: {e}", path.display()));
        let mut reader = FrcVReader::new(&bytes[..]).expect("archive container");
        let mut dec = Decoder::new();
        let mut i = 0usize;
        while let Some((_, payload)) = reader.read_frame().expect("archive frame read") {
            let frame = dec.decode_frame(&payload).expect("archive decode");
            assert_eq!(
                frame_fnv64(&frame),
                sums[i],
                "{name} frame {i}: decoder no longer reproduces the archived reconstruction \
                 (incompatible decoder change; bump BITSTREAM_VERSION and keep the old path)"
            );
            i += 1;
        }
        assert_eq!(i, sums.len(), "{name}: frame count mismatch");
    }
}
