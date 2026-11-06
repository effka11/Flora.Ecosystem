//! Слой ручек `tuning-env` (frc-i-v14-plan.md §6.1): без feature env
//! игнорируется; с feature ручки v14 действуют, а замороженные версии
//! остаются байт-в-байт прежними.
//!
//! Edition 2024 запрещает `set_var` (и workspace запрещает `unsafe`), поэтому
//! проверки env идут в дочернем процессе того же тест-бинарника: родитель
//! задаёт окружение через `Command::env`.

use frc_i::{
    EncodeMode, ImageView, PixelFormat, decode, encode, encode_with_version, encode_with_version_ts,
};

fn source(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut data = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let n = if (x + y) & 1 == 0 { 30 } else { -30 };
            let ramp = 90 + (x * 40 / w.max(1) + y * 20 / h.max(1)) as i32;
            data.push((ramp + n).clamp(0, 255) as u8);
            data.push((ramp + 10 + n).clamp(0, 255) as u8);
            data.push((ramp - 6 + n).clamp(0, 255) as u8);
            data.push(255);
        }
    }
    data
}

fn view(w: u32, h: u32, data: &[u8]) -> ImageView<'_> {
    ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data,
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Запускает ignored-тест `name` в дочернем процессе этого же бинарника.
fn run_child(name: &str, vars: &[(&str, &str)]) -> String {
    let exe = std::env::current_exe().expect("current_exe");
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["--exact", name, "--ignored", "--nocapture"]);
    for (key, value) in vars {
        cmd.env(key, value);
    }
    let output = cmd.output().expect("spawn child test");
    assert!(
        output.status.success(),
        "дочерний тест {name} упал: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf-8 stdout");
    let line = stdout
        .lines()
        .find_map(|l| l.strip_prefix("PROBE:"))
        .unwrap_or_else(|| panic!("нет PROBE в выводе {name}: {stdout}"));
    line.trim().to_string()
}

#[cfg(not(feature = "tuning-env"))]
#[test]
fn env_is_ignored_without_feature() {
    let clean = run_child("child_probe_v14", &[]);
    let with_env = run_child(
        "child_probe_v14",
        &[
            ("FRC_I_RD_ACBIAS", "0.10"),
            ("FRC_I_TS_ENABLE", "0"),
            ("FRC_I_TS_L0", "0.5"),
            ("FRC_I_CHROMA420_QMAX", "10"),
        ],
    );
    assert_eq!(
        clean, with_env,
        "без feature tuning-env окружение не должно влиять на байты"
    );
}

#[cfg(feature = "tuning-env")]
#[test]
fn v13_ignores_v14_knobs() {
    let clean = run_child("child_probe_v13", &[]);
    let with_env = run_child(
        "child_probe_v13",
        &[
            ("FRC_I_RD_ACBIAS", "0.10"),
            ("FRC_I_RD_LAMBDA", "0.90"),
            ("FRC_I_TS_ENABLE", "0"),
            ("FRC_I_CHROMA420_QMAX", "10"),
        ],
    );
    assert_eq!(
        clean, with_env,
        "ручки линии v14 не должны течь в замороженный v13"
    );
}

#[cfg(feature = "tuning-env")]
#[test]
fn ts_enable_zero_matches_neutral_side() {
    run_child(
        "child_assert_ts_disabled_neutral",
        &[("FRC_I_TS_ENABLE", "0")],
    );
}

#[cfg(feature = "tuning-env")]
#[test]
fn registry_lists_plan_knobs() {
    let registry = frc_i::tuning_env_registry();
    for knob in [
        "FRC_I_TS_ENABLE",
        "FRC_I_TS_TABLE",
        "FRC_I_CS_ENABLE",
        "FRC_I_RD_ACBIAS",
        "FRC_I_CHROMA420_QMAX",
        "FRC_I_DEBLOCK_QMAX",
        "FRC_I_DQ_LUMA",
    ] {
        assert!(registry.contains(&knob), "нет ручки {knob} в реестре");
    }
}

// --- дочерние зонды (запускаются только через `run_child`) -------------------

#[test]
#[ignore = "child process probe"]
fn child_probe_v14() {
    let data = source(96, 64);
    let img = view(96, 64, &data);
    let fri = encode(&img, EncodeMode::Lossy { quality: 75 }).unwrap();
    println!("PROBE:{}", hex(&fri));
}

#[test]
#[ignore = "child process probe"]
fn child_probe_v13() {
    let data = source(96, 64);
    let img = view(96, 64, &data);
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 13).unwrap();
    println!("PROBE:{}", hex(&fri));
}

#[test]
#[ignore = "child process probe"]
fn child_assert_ts_disabled_neutral() {
    let data = source(96, 64);
    let img = view(96, 64, &data);
    let disabled = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 14).unwrap();
    let neutral =
        encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &[0]).unwrap();
    assert_eq!(
        disabled, neutral,
        "FRC_I_TS_ENABLE=0 обязан давать все ts = 0"
    );
    assert!(decode(&disabled).is_ok());
    println!("PROBE:ok");
}
