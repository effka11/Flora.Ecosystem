//! Полигон FRC-V: конформанс кодека на широком наборе классов контента.
//!
//! Каждый клип полигона (см. `common`) проходит полный цикл encode → decode:
//! - **паритет** — выход декодера бит-в-бит равен реконструкции энкодера
//!   на каждом кадре (главный инвариант формата);
//! - **качество** — PSNR/SSIM последовательности не ниже порога класса
//!   (пороги сняты с эталонного прогона с запасом: ловим деградацию, не шум);
//! - **размер** — bpp не выше потолка класса (ловим взрыв битрейта);
//! - **расписание ключей** — без ложных срабатываний детектора смены сцены.
//!
//! Отдельно: поведение на смене сцены, сходимость rate control, монотонность
//! по qp, детерминизм, паритет на всех пресетах скорости.
//!
//! Ручной бенчмарк:
//! `cargo test -p frc-v --release --test polygon -- --ignored --nocapture polygon_report`

mod common;

use common::*;
use frc_v::metrics::{Psnr, PsnrAccum, Ssim, SsimAccum, psnr, ssim};
use frc_v::{Decoder, Encoder, EncoderConfig, Frame};

/// Клип полигона с порогами качества.
struct Case {
    name: &'static str,
    frames: Vec<Frame>,
    /// Порог PSNR overall (dB) по последовательности при qp эталона.
    min_psnr: f64,
    /// Порог PSNR overall (dB) худшего кадра.
    min_frame_psnr: f64,
    /// Порог SSIM overall по последовательности.
    min_ssim: f64,
    /// Потолок битрейта, бит на пиксель.
    max_bpp: f64,
}

/// Эталонная конфигурация конформанса: qp 28, GOP 4, полный RDO.
const CONF_QP: u8 = 28;
const CONF_KEYINT: u32 = 4;

fn conf_cfg(w: usize, h: usize, keyint: u32, speed: u8) -> EncoderConfig {
    EncoderConfig {
        width: w as u32,
        height: h as u32,
        qp: CONF_QP,
        keyint,
        speed,
        ..EncoderConfig::default()
    }
}

/// Манифест полигона: 12 клипов, покрывающих классы контента и движения.
fn manifest() -> Vec<Case> {
    vec![
        Case {
            name: "flat_static",
            frames: make_clip(
                &Flat {
                    y: 96,
                    cb: 118,
                    cr: 142,
                },
                96,
                64,
                4,
                Motion::Static,
            ),
            min_psnr: 46.0,
            min_frame_psnr: 44.0,
            min_ssim: 0.98,
            max_bpp: 0.05,
        },
        Case {
            name: "gradient_pan_subpel",
            frames: make_clip(
                &Gradient { mw: 512, mh: 384 },
                128,
                96,
                8,
                Motion::Pan { vx_q: 3, vy_q: 1 },
            ),
            min_psnr: 40.0,
            min_frame_psnr: 38.0,
            min_ssim: 0.94,
            max_bpp: 0.30,
        },
        Case {
            name: "checker_pan_int",
            frames: make_clip(
                &Checker { cell_q: 56 },
                128,
                96,
                8,
                Motion::Pan { vx_q: 8, vy_q: 4 },
            ),
            min_psnr: 30.0,
            min_frame_psnr: 28.0,
            min_ssim: 0.90,
            max_bpp: 0.60,
        },
        Case {
            name: "rings_zoom_in",
            frames: make_clip(
                &Rings { cx: 256, cy: 192 },
                128,
                96,
                8,
                Motion::Zoom { rate_q16: 300 },
            ),
            // Зум — дивергентное поле движения, трансляционная MC его не
            // моделирует: листья уходят в интру, класс дорогой по природе.
            min_psnr: 28.0,
            min_frame_psnr: 26.0,
            min_ssim: 0.85,
            max_bpp: 1.40,
        },
        Case {
            name: "terrain_pan",
            frames: make_clip(
                &Terrain { seed: 0x7E44 },
                160,
                96,
                8,
                Motion::Pan { vx_q: 6, vy_q: 2 },
            ),
            min_psnr: 32.0,
            min_frame_psnr: 30.0,
            min_ssim: 0.85,
            max_bpp: 0.80,
        },
        Case {
            name: "terrain_rotate",
            frames: make_clip(
                &Terrain { seed: 0x0D1E },
                128,
                128,
                8,
                Motion::Rotate { rate_q16: 655 }, // 0.01 рад/кадр
            ),
            min_psnr: 32.0,
            min_frame_psnr: 30.0,
            min_ssim: 0.85,
            max_bpp: 0.80,
        },
        Case {
            name: "text_static",
            // Плотный псевдотекст — высокочастотная интра; GOP 4 ⇒ 2 ключа
            // на 5 кадров, класс дорогой (эталон ~1.0 bpp).
            frames: make_clip(&TextLike { seed: 0x7E77 }, 192, 128, 5, Motion::Static),
            min_psnr: 26.0,
            min_frame_psnr: 24.0,
            min_ssim: 0.85,
            max_bpp: 1.15,
        },
        Case {
            name: "text_scroll",
            frames: make_clip(
                &TextLike { seed: 0x5C11 },
                192,
                128,
                8,
                Motion::Pan { vx_q: 0, vy_q: 6 },
            ),
            min_psnr: 26.0,
            min_frame_psnr: 24.0,
            min_ssim: 0.85,
            max_bpp: 1.00,
        },
        Case {
            name: "noise_pan",
            frames: make_clip(
                &NoiseP {
                    seed: 0x0F0F,
                    amp: 44,
                },
                96,
                96,
                6,
                Motion::Pan { vx_q: 4, vy_q: 0 },
            ),
            min_psnr: 20.0,
            min_frame_psnr: 18.0,
            min_ssim: 0.25,
            max_bpp: 4.00,
        },
        Case {
            name: "plasma_jitter",
            frames: make_clip(
                &Plasma,
                128,
                96,
                8,
                Motion::Jitter {
                    seed: 0xBAD5EED,
                    amp_q: 6,
                },
            ),
            min_psnr: 34.0,
            min_frame_psnr: 32.0,
            min_ssim: 0.90,
            max_bpp: 0.60,
        },
        Case {
            name: "objects_over_terrain",
            frames: make_object_clip(
                &Terrain { seed: 0x0BB0 },
                &[
                    MovingObject {
                        x0_q: 80,
                        y0_q: 96,
                        vx_q: 14,
                        vy_q: 6,
                        w_q: 128,
                        h_q: 96,
                        luma: 220,
                        cb: 90,
                        cr: 170,
                    },
                    MovingObject {
                        x0_q: 400,
                        y0_q: 300,
                        vx_q: -10,
                        vy_q: 4,
                        w_q: 160,
                        h_q: 120,
                        luma: 60,
                        cb: 160,
                        cr: 90,
                    },
                    MovingObject {
                        x0_q: 300,
                        y0_q: 60,
                        vx_q: 4,
                        vy_q: 10,
                        w_q: 72,
                        h_q: 72,
                        luma: 150,
                        cb: 128,
                        cr: 128,
                    },
                ],
                160,
                128,
                8,
            ),
            min_psnr: 30.0,
            min_frame_psnr: 28.0,
            min_ssim: 0.85,
            max_bpp: 0.90,
        },
        Case {
            name: "chroma_checker_pan",
            frames: make_clip(
                &ChromaCheck { cell_q: 64 },
                96,
                64,
                6,
                Motion::Pan { vx_q: 5, vy_q: 2 },
            ),
            min_psnr: 32.0,
            min_frame_psnr: 30.0,
            min_ssim: 0.90,
            max_bpp: 0.80,
        },
        Case {
            name: "fade_terrain",
            frames: {
                let mut f = make_clip(
                    &Terrain { seed: 0xFADE },
                    128,
                    96,
                    8,
                    Motion::Pan { vx_q: 2, vy_q: 1 },
                );
                apply_fade(&mut f, -6);
                f
            },
            min_psnr: 32.0,
            min_frame_psnr: 30.0,
            min_ssim: 0.85,
            max_bpp: 0.80,
        },
    ]
}

/// Результат прогона клипа.
struct RunStats {
    bytes: usize,
    keyframes: usize,
    psnr: Psnr,
    ssim: Ssim,
    worst_frame_psnr: f64,
}

/// Полный цикл клипа: паритет на каждом кадре + метрики.
fn run_clip(frames: &[Frame], cfg: EncoderConfig) -> RunStats {
    let mut enc = Encoder::new(cfg).expect("valid polygon config");
    let mut dec = Decoder::new();
    let mut pa = PsnrAccum::default();
    let mut sa = SsimAccum::default();
    let mut bytes = 0usize;
    let mut keyframes = 0usize;
    let mut worst = f64::INFINITY;
    for (i, src) in frames.iter().enumerate() {
        let packet = enc.encode_frame(src).expect("polygon encode");
        bytes += packet.data.len();
        keyframes += usize::from(packet.keyframe);
        let out = dec.decode_frame(&packet.data).expect("polygon decode");
        assert_eq!(
            &out,
            enc.last_recon(),
            "decoder/encoder parity broken at frame {i}"
        );
        let p = psnr(src, &out);
        worst = worst.min(p.overall);
        pa.add(src, &out);
        sa.add(src, &out);
    }
    RunStats {
        bytes,
        keyframes,
        psnr: pa.result(),
        ssim: sa.result(),
        worst_frame_psnr: worst,
    }
}

fn bpp(bytes: usize, w: usize, h: usize, n: usize) -> f64 {
    bytes as f64 * 8.0 / (w * h * n) as f64
}

/// Конформанс: паритет, пороги качества, потолок размера, расписание ключей —
/// по всем клипам манифеста.
#[test]
fn polygon_conformance() {
    for case in manifest() {
        let (w, h) = (case.frames[0].width(), case.frames[0].height());
        let n = case.frames.len();
        let stats = run_clip(&case.frames, conf_cfg(w, h, CONF_KEYINT, 0));
        let got_bpp = bpp(stats.bytes, w, h, n);
        let expected_keys = n.div_ceil(CONF_KEYINT as usize);
        assert_eq!(
            stats.keyframes, expected_keys,
            "{}: spurious/missing keyframes (scene-cut false positive?)",
            case.name
        );
        assert!(
            stats.psnr.overall >= case.min_psnr,
            "{}: PSNR {:.2} dB < {:.2}",
            case.name,
            stats.psnr.overall,
            case.min_psnr
        );
        assert!(
            stats.worst_frame_psnr >= case.min_frame_psnr,
            "{}: worst frame PSNR {:.2} dB < {:.2}",
            case.name,
            stats.worst_frame_psnr,
            case.min_frame_psnr
        );
        assert!(
            stats.ssim.overall >= case.min_ssim,
            "{}: SSIM {:.4} < {:.4}",
            case.name,
            stats.ssim.overall,
            case.min_ssim
        );
        assert!(
            got_bpp <= case.max_bpp,
            "{}: {:.3} bpp > cap {:.3}",
            case.name,
            got_bpp,
            case.max_bpp
        );
    }
}

/// Паритет на всех пресетах скорости для трёх характерных клипов.
#[test]
fn polygon_speed_parity() {
    let clips: Vec<(&str, Vec<Frame>)> = vec![
        (
            "terrain_pan",
            make_clip(
                &Terrain { seed: 0x51D3 },
                128,
                96,
                6,
                Motion::Pan { vx_q: 6, vy_q: 2 },
            ),
        ),
        (
            "text_scroll",
            make_clip(
                &TextLike { seed: 0x0AB1 },
                128,
                96,
                6,
                Motion::Pan { vx_q: 0, vy_q: 6 },
            ),
        ),
        (
            "rings_zoom",
            make_clip(
                &Rings { cx: 256, cy: 192 },
                128,
                96,
                6,
                Motion::Zoom { rate_q16: 300 },
            ),
        ),
    ];
    for (name, frames) in &clips {
        for speed in 0..=2u8 {
            // Паритет проверяется внутри run_clip на каждом кадре.
            let stats = run_clip(frames, conf_cfg(128, 96, 3, speed));
            assert!(
                stats.psnr.overall > 20.0,
                "{name} speed {speed}: sanity PSNR {:.2}",
                stats.psnr.overall
            );
        }
    }
}

/// Жёсткая склейка сцен: детектор форсирует ключевой кадр на стыке,
/// качество первого кадра новой сцены не проваливается; с выключенным
/// детектором ключа нет (и качество на стыке хуже либо равно).
#[test]
fn polygon_scene_cut_detection() {
    let (w, h) = (128usize, 96usize);
    let cut_at = 5usize;
    let frames = concat(
        make_clip(
            &Terrain { seed: 0xCA7 },
            w,
            h,
            cut_at,
            Motion::Pan { vx_q: 4, vy_q: 2 },
        ),
        make_clip(
            &Checker { cell_q: 72 },
            w,
            h,
            5,
            Motion::Pan { vx_q: 6, vy_q: 0 },
        ),
    );

    let encode_all = |scene_cut: bool| {
        let mut enc = Encoder::new(EncoderConfig {
            scene_cut,
            ..conf_cfg(w, h, 100, 0)
        })
        .expect("valid config");
        let mut dec = Decoder::new();
        let mut keys = Vec::new();
        let mut cut_frame_psnr = 0.0f64;
        for (i, src) in frames.iter().enumerate() {
            let packet = enc.encode_frame(src).expect("encode");
            keys.push(packet.keyframe);
            let out = dec.decode_frame(&packet.data).expect("decode");
            assert_eq!(&out, enc.last_recon(), "parity at frame {i}");
            if i == cut_at {
                cut_frame_psnr = psnr(src, &out).overall;
            }
        }
        (keys, cut_frame_psnr)
    };

    let (keys_on, psnr_on) = encode_all(true);
    let (keys_off, psnr_off) = encode_all(false);

    assert!(keys_on[0] && keys_off[0]);
    assert!(
        keys_on[cut_at],
        "scene cut must force a keyframe at the cut"
    );
    assert_eq!(
        keys_on.iter().filter(|&&k| k).count(),
        2,
        "exactly initial + cut keyframes expected: {keys_on:?}"
    );
    assert!(
        keys_off.iter().filter(|&&k| k).count() == 1,
        "detector disabled must not force keys: {keys_off:?}"
    );
    assert!(
        psnr_on >= psnr_off - 0.01,
        "cut frame quality with detector ({psnr_on:.2} dB) must not be worse than without ({psnr_off:.2} dB)"
    );
    assert!(psnr_on > 26.0, "cut frame quality too low: {psnr_on:.2} dB");
}

/// Детектор не срабатывает на плавных изменениях: панорама, фейд, шум, дрожание.
#[test]
fn polygon_scene_cut_no_false_positives() {
    let (w, h) = (96usize, 64usize);
    let mut clips: Vec<(&str, Vec<Frame>)> = vec![
        (
            "pan",
            make_clip(
                &Terrain { seed: 1 },
                w,
                h,
                6,
                Motion::Pan { vx_q: 10, vy_q: 4 },
            ),
        ),
        (
            "noise",
            make_clip(
                &NoiseP { seed: 2, amp: 44 },
                w,
                h,
                6,
                Motion::Pan { vx_q: 4, vy_q: 0 },
            ),
        ),
        (
            "jitter",
            make_clip(&Plasma, w, h, 6, Motion::Jitter { seed: 3, amp_q: 8 }),
        ),
    ];
    let mut fade = make_clip(&Terrain { seed: 4 }, w, h, 8, Motion::Static);
    apply_fade(&mut fade, -7);
    clips.push(("fade", fade));

    for (name, frames) in &clips {
        let mut enc = Encoder::new(conf_cfg(w, h, 100, 1)).expect("valid config");
        for (i, src) in frames.iter().enumerate() {
            let packet = enc.encode_frame(src).expect("encode");
            assert_eq!(
                packet.keyframe,
                i == 0,
                "{name}: false scene-cut trigger at frame {i}"
            );
        }
    }
}

/// Rate control сходится к целевому битрейту на длинном клипе (±25%)
/// и масштабируется с целью.
#[test]
fn polygon_rate_control_convergence() {
    let (w, h) = (128usize, 96usize);
    let frames = make_clip(
        &Terrain { seed: 0x2C },
        w,
        h,
        48,
        Motion::Pan { vx_q: 5, vy_q: 2 },
    );
    let fps = 30.0;
    let run = |kbps: u32| {
        let mut enc = Encoder::new(EncoderConfig {
            width: w as u32,
            height: h as u32,
            qp: 32,
            keyint: 16,
            target_kbps: Some(kbps),
            fps_num: 30,
            fps_den: 1,
            speed: 1,
            ..EncoderConfig::default()
        })
        .expect("valid RC config");
        let mut bytes = 0usize;
        for src in &frames {
            bytes += enc.encode_frame(src).expect("encode").data.len();
        }
        bytes as f64 * 8.0 * fps / frames.len() as f64 / 1000.0
    };
    // Цели внутри достижимого конверта клипа: у 128×96-terrain qp 0 даёт
    // ~530 кбит/с — выше просить бессмысленно (RC упрётся в потолок качества).
    for target in [120u32, 360] {
        let got = run(target);
        let err = (got - f64::from(target)).abs() / f64::from(target);
        assert!(
            err <= 0.25,
            "target {target} kbps: achieved {got:.0} kbps (err {:.0}%)",
            err * 100.0
        );
    }
    assert!(
        run(360) > run(120) * 1.8,
        "bitrate must scale with the target"
    );
}

/// Монотонность по qp на двух классах: размер строго убывает, PSNR не растёт.
#[test]
fn polygon_qp_monotonicity() {
    let clips: Vec<(&str, Vec<Frame>)> = vec![
        (
            "terrain",
            make_clip(
                &Terrain { seed: 0xA1 },
                128,
                96,
                4,
                Motion::Pan { vx_q: 4, vy_q: 2 },
            ),
        ),
        (
            "text",
            make_clip(&TextLike { seed: 0xB2 }, 128, 96, 4, Motion::Static),
        ),
    ];
    for (name, frames) in &clips {
        let mut prev_bytes = usize::MAX;
        let mut prev_psnr = f64::INFINITY;
        for &qp in &[12u8, 28, 44] {
            let mut enc = Encoder::new(EncoderConfig {
                qp,
                ..conf_cfg(128, 96, 4, 0)
            })
            .expect("valid config");
            let mut dec = Decoder::new();
            let mut bytes = 0usize;
            let mut pa = PsnrAccum::default();
            for src in frames {
                let packet = enc.encode_frame(src).expect("encode");
                bytes += packet.data.len();
                let out = dec.decode_frame(&packet.data).expect("decode");
                pa.add(src, &out);
            }
            let p = pa.result().overall;
            assert!(bytes < prev_bytes, "{name} qp={qp}: size must shrink");
            assert!(p < prev_psnr + 0.01, "{name} qp={qp}: psnr must not grow");
            prev_bytes = bytes;
            prev_psnr = p;
        }
    }
}

/// Полигонные клипы кодируются детерминированно.
#[test]
fn polygon_determinism() {
    let frames = make_clip(
        &Terrain { seed: 0xD3 },
        96,
        64,
        5,
        Motion::Pan { vx_q: 3, vy_q: 1 },
    );
    let run = || {
        let mut enc = Encoder::new(conf_cfg(96, 64, 3, 0)).expect("valid config");
        frames
            .iter()
            .map(|f| enc.encode_frame(f).expect("encode").data)
            .collect::<Vec<_>>()
    };
    assert_eq!(run(), run());
}

/// Санити генераторов: детерминизм, диапазоны, различие классов.
#[test]
fn polygon_generators_sanity() {
    let a = make_clip(
        &Terrain { seed: 7 },
        64,
        64,
        3,
        Motion::Pan { vx_q: 5, vy_q: 3 },
    );
    let b = make_clip(
        &Terrain { seed: 7 },
        64,
        64,
        3,
        Motion::Pan { vx_q: 5, vy_q: 3 },
    );
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(
            frame_fnv64(x),
            frame_fnv64(y),
            "generators must be deterministic"
        );
    }
    // Кадры движутся (соседние различаются), классы различаются между собой.
    assert_ne!(frame_fnv64(&a[0]), frame_fnv64(&a[1]));
    let text = make_clip(&TextLike { seed: 7 }, 64, 64, 1, Motion::Static);
    assert_ne!(frame_fnv64(&a[0]), frame_fnv64(&text[0]));
    // Средняя люма в разумном диапазоне (генератор не выродился в чёрное/белое).
    for f in [&a[0], &text[0]] {
        let m = plane_mean(&f.y);
        assert!((20..=240).contains(&m), "plane mean {m}");
    }
    // Субпиксельная панорама: сдвиг на 3 q за кадр — кадры не равны и не
    // являются целопиксельным сдвигом друг друга.
    let g = make_clip(
        &Gradient { mw: 256, mh: 256 },
        64,
        64,
        2,
        Motion::Pan { vx_q: 3, vy_q: 0 },
    );
    let mut int_shift = Frame::new(64, 64);
    for y in 0..64 {
        for x in 0..64 {
            int_shift.y.set(x, y, g[0].y.get((x + 1).min(63), y));
        }
    }
    assert_ne!(g[1].y.data(), int_shift.y.data(), "pan must be sub-pixel");
}

/// Ручной отчёт-бенчмарк полигона (запускать в release, см. шапку файла).
#[test]
#[ignore = "ручной бенчмарк полигона"]
fn polygon_report() {
    println!(
        "{:<24} {:>5} {:>9} {:>7} {:>8} {:>8} {:>8} {:>7} {:>8}",
        "clip", "speed", "bytes", "bpp", "PSNR-Y", "PSNR", "SSIM", "keys", "enc-fps"
    );
    for case in manifest() {
        let (w, h) = (case.frames[0].width(), case.frames[0].height());
        let n = case.frames.len();
        for speed in 0..=2u8 {
            let started = std::time::Instant::now();
            let stats = run_clip(&case.frames, conf_cfg(w, h, CONF_KEYINT, speed));
            let dt = started.elapsed().as_secs_f64();
            println!(
                "{:<24} {:>5} {:>9} {:>7.3} {:>8.2} {:>8.2} {:>8.4} {:>7} {:>8.2}",
                case.name,
                speed,
                stats.bytes,
                bpp(stats.bytes, w, h, n),
                stats.psnr.y,
                stats.psnr.overall,
                stats.ssim.overall,
                stats.keyframes,
                n as f64 / dt
            );
        }
    }
    // Сводка по SSIM-tune (спека §13): включение не должно ронять SSIM.
    let frames = make_clip(
        &Terrain { seed: 0x55 },
        128,
        96,
        6,
        Motion::Pan { vx_q: 4, vy_q: 2 },
    );
    for tune in [false, true] {
        let mut enc = Encoder::new(EncoderConfig {
            ssim_tune: tune,
            ..conf_cfg(128, 96, 3, 0)
        })
        .expect("valid config");
        let mut sa = SsimAccum::default();
        let mut bytes = 0;
        for src in &frames {
            let p = enc.encode_frame(src).expect("encode");
            bytes += p.data.len();
            sa.add(src, enc.last_recon());
        }
        println!(
            "ssim_tune={tune}: {bytes} bytes, SSIM {:.4}",
            sa.result().overall
        );
    }
    let _ = ssim(&frames[0], &frames[1]); // метрика доступна из полигона
}
