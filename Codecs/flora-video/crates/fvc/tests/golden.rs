//! Golden-вектора заморозки битстрима FVC1 v1 (паттерн FIC).
//!
//! Пины:
//! 1. **Энкодер**: на эталонном входе выдаёт байт-в-байт зафиксированный поток
//!    (файлы `tests/data/*.fvc`, нативный контейнер — заморожен вместе с битстримом).
//! 2. **Декодер**: восстанавливает зафиксированные потоки в реконструкцию
//!    с зафиксированными FNV-1a-64 чексаммами (`tests/data/golden.sums`).
//!
//! Любое расхождение — несовместимое изменение формата: требуется bump
//! `BITSTREAM_VERSION` и осознанная регенерация:
//! `FVC_UPDATE_GOLDEN=1 cargo test -p fvc --test golden`.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use fvc::container::{FvcHeader, FvcReader, FvcWriter};
use fvc::{Decoder, Encoder, EncoderConfig, Frame};

fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data")
}

fn update_mode() -> bool {
    std::env::var_os("FVC_UPDATE_GOLDEN").is_some_and(|v| v == "1")
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

/// FNV-1a 64 всех плоскостей кадра.
fn frame_fnv64(f: &Frame) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for plane in [f.y.data(), f.cb.data(), f.cr.data()] {
        for &b in plane {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// Эталонный кадр: детерминированные структуры + LCG-шум.
fn golden_frame(w: usize, h: usize, seed: u64) -> Frame {
    let mut f = Frame::new(w, h);
    let mut rng = Lcg(seed);
    for y in 0..h {
        for x in 0..w {
            let g = (x * 200 / w + y * 40 / h) as i64;
            let block = if (x / 12 + y / 9) % 3 == 0 { 45 } else { 0 };
            let noise = (rng.next() % 7) as i64 - 3;
            f.y.set(x, y, (30 + g + block + noise).clamp(0, 255) as u8);
        }
    }
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            f.cb.set(x, y, (90 + x * 60 / (w / 2)) as u8);
            f.cr.set(x, y, (170 - y * 70 / (h / 2)) as u8);
        }
    }
    f
}

/// Кадр, сдвинутый на (dx, dy) с репликацией краёв (движение для P-кадров).
fn shift(base: &Frame, dx: i32, dy: i32) -> Frame {
    let (w, h) = (base.width(), base.height());
    let mut f = Frame::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let sx = (x as i32 - dx).clamp(0, w as i32 - 1) as usize;
            let sy = (y as i32 - dy).clamp(0, h as i32 - 1) as usize;
            f.y.set(x, y, base.y.get(sx, sy));
        }
    }
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            let sx = (x as i32 - dx / 2).clamp(0, (w / 2) as i32 - 1) as usize;
            let sy = (y as i32 - dy / 2).clamp(0, (h / 2) as i32 - 1) as usize;
            f.cb.set(x, y, base.cb.get(sx, sy));
            f.cr.set(x, y, base.cr.get(sx, sy));
        }
    }
    f
}

struct Vector {
    name: &'static str,
    cfg: EncoderConfig,
    frames: Vec<Frame>,
}

fn vectors() -> Vec<Vector> {
    let intra_base = golden_frame(64, 64, 0xF10);
    let gop_base = golden_frame(96, 64, 0xF11);
    vec![
        Vector {
            name: "intra_q32_64x64",
            cfg: EncoderConfig {
                width: 64,
                height: 64,
                qp: 32,
                keyint: 1,
                ..EncoderConfig::default()
            },
            frames: vec![intra_base.clone(), shift(&intra_base, 1, 0)],
        },
        Vector {
            name: "gop2_q28_96x64",
            cfg: EncoderConfig {
                width: 96,
                height: 64,
                qp: 28,
                keyint: 2,
                ..EncoderConfig::default()
            },
            frames: vec![
                gop_base.clone(),
                shift(&gop_base, 2, 1),
                shift(&gop_base, 4, 2),
                shift(&gop_base, 5, 3),
            ],
        },
        Vector {
            name: "gop9_q40_nofilter_72x48",
            cfg: EncoderConfig {
                width: 72,
                height: 48,
                qp: 40,
                loop_filter: false,
                keyint: 9,
                ..EncoderConfig::default()
            },
            frames: (0..5)
                .map(|i| shift(&golden_frame(72, 48, 0xF12), 3 * i, -i))
                .collect(),
        },
    ]
}

/// Кодирует вектор в нативный контейнер (байты).
fn encode_vector(v: &Vector) -> Vec<u8> {
    let mut enc = Encoder::new(v.cfg).expect("valid golden config");
    let header = FvcHeader {
        width: v.cfg.width as u16,
        height: v.cfg.height as u16,
        fps_num: 30,
        fps_den: 1,
        frame_count: 0,
    };
    let mut w = FvcWriter::new(Cursor::new(Vec::new()), header).expect("in-memory write");
    for (i, f) in v.frames.iter().enumerate() {
        let packet = enc.encode_frame(f).expect("golden encode");
        w.write_frame(i as u64, &packet.data)
            .expect("in-memory write");
    }
    w.finalize().expect("in-memory finalize").into_inner()
}

/// Декодирует контейнер, возвращает чексаммы кадров.
fn decode_checksums(bytes: &[u8]) -> Vec<u64> {
    let mut r = FvcReader::new(bytes).expect("golden container");
    let mut dec = Decoder::new();
    let mut sums = Vec::new();
    while let Some((_, payload)) = r.read_frame().expect("golden frame read") {
        let frame = dec.decode_frame(&payload).expect("golden decode");
        sums.push(frame_fnv64(&frame));
    }
    sums
}

#[test]
fn golden_vectors() {
    let dir = data_dir();
    let sums_path = dir.join("golden.sums");

    if update_mode() {
        std::fs::create_dir_all(&dir).expect("create data dir");
        let mut sums_text = String::new();
        for v in vectors() {
            let bytes = encode_vector(&v);
            std::fs::write(dir.join(format!("{}.fvc", v.name)), &bytes).expect("write golden");
            for (i, sum) in decode_checksums(&bytes).iter().enumerate() {
                sums_text.push_str(&format!("{} {} {:016x}\n", v.name, i, sum));
            }
        }
        std::fs::write(&sums_path, sums_text).expect("write sums");
        eprintln!("golden vectors regenerated in {}", dir.display());
        return;
    }

    let sums_text = std::fs::read_to_string(&sums_path)
        .expect("tests/data/golden.sums missing — run with FVC_UPDATE_GOLDEN=1 once");
    for v in vectors() {
        let path = dir.join(format!("{}.fvc", v.name));
        let stored = std::fs::read(&path).unwrap_or_else(|_| {
            panic!(
                "{} missing — run with FVC_UPDATE_GOLDEN=1 once",
                path.display()
            )
        });

        // Пин 1: энкодер детерминированно воспроизводит замороженный поток.
        let encoded = encode_vector(&v);
        assert_eq!(
            encoded, stored,
            "{}: encoder output diverged from frozen bitstream (bitstream change requires \
             BITSTREAM_VERSION bump + conscious regeneration)",
            v.name
        );

        // Пин 2: декодер восстанавливает замороженные чексаммы.
        let sums = decode_checksums(&stored);
        for (i, sum) in sums.iter().enumerate() {
            let expected_line = format!("{} {} {:016x}", v.name, i, sum);
            assert!(
                sums_text.lines().any(|l| l == expected_line),
                "{} frame {}: reconstruction checksum {:016x} not in golden.sums",
                v.name,
                i,
                sum
            );
        }
        // Число кадров тоже зафиксировано.
        let prefix = format!("{} ", v.name);
        let expected_count = sums_text.lines().filter(|l| l.starts_with(&prefix)).count();
        assert_eq!(
            sums.len(),
            expected_count,
            "{}: frame count mismatch",
            v.name
        );
    }
}
