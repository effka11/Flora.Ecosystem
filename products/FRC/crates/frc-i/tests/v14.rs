//! Контракт битстрима v14 (frc-i.md §7.22): нейтральность `ts = 0`,
//! валидность всех четырёх индексов частотной формы, активность решения
//! и независимость от числа тайлов.

use frc_i::{
    EncodeMode, ImageView, PixelFormat, decode, encode_with_version, encode_with_version_ts,
    read_info,
};

fn texture(width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut data = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let n = if (x + y) & 1 == 0 { 36 } else { -36 };
            let ramp = 84 + (x * 40 / w.max(1) + y * 24 / h.max(1)) as i32;
            data.push((ramp + n).clamp(0, 255) as u8);
            data.push((ramp + 12 + n).clamp(0, 255) as u8);
            data.push((ramp - 8 + n).clamp(0, 255) as u8);
            data.push(if (x / 11 + y / 7) % 2 == 0 { 255 } else { 208 });
        }
    }
    data
}

fn view<'a>(w: u32, h: u32, data: &'a [u8]) -> ImageView<'a> {
    ImageView {
        width: w,
        height: h,
        format: PixelFormat::Rgba8,
        data,
    }
}

fn psnr_rgb(a: &[u8], b: &[u8], bpp: usize) -> f64 {
    let mut sum = 0f64;
    let mut n = 0usize;
    for (pa, pb) in a.chunks_exact(bpp).zip(b.chunks_exact(bpp)) {
        for c in 0..3 {
            let d = f64::from(pa[c]) - f64::from(pb[c]);
            sum += d * d;
            n += 1;
        }
    }
    let mse = sum / n as f64;
    10.0 * (255.0 * 255.0 / mse).log10()
}

#[test]
fn v14_roundtrip_and_info() {
    let data = texture(193, 129);
    let img = view(193, 129, &data);
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 14).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 14);
    assert_eq!((info.width, info.height), (193, 129));
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (193, 129));
    assert!(psnr_rgb(&data, &out.data, 4) > 20.0);
}

#[test]
fn v14_neutral_ts_matches_v13_pixels() {
    let data = texture(193, 129);
    let img = view(193, 129, &data);
    let v14 = encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &[0]).unwrap();
    let v13 = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 13).unwrap();
    assert_eq!(read_info(&v14).unwrap().version, 14);
    assert_eq!(
        decode(&v14).unwrap().data,
        decode(&v13).unwrap().data,
        "нейтральный v14 (все ts = 0) обязан давать пиксели v13"
    );
}

#[test]
fn v14_all_ts_indices_decode_and_change_pixels() {
    let data = texture(193, 129);
    let img = view(193, 129, &data);
    let mut pixels = Vec::new();
    for ts in 0u8..=3 {
        let fri =
            encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &[ts]).unwrap();
        assert_eq!(read_info(&fri).unwrap().version, 14);
        let out = decode(&fri).unwrap();
        assert_eq!((out.width, out.height), (193, 129));
        pixels.push(out.data);
    }
    for ts in 1..4 {
        assert_ne!(
            pixels[0], pixels[ts],
            "ts = {ts} обязан менять пиксели относительно плоской формы"
        );
    }
}

#[test]
fn v14_stream_differs_from_relabelled_v13() {
    let data = texture(193, 129);
    let img = view(193, 129, &data);
    let v14 = encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &[2]).unwrap();
    let mut v13 = encode_with_version(&img, EncodeMode::Lossy { quality: 75 }, 13).unwrap();
    v13[4] = 14;
    assert_ne!(
        v14[5..],
        v13[5..],
        "активный TS-символ обязан расходить поток за пределами байта версии"
    );
}

#[test]
fn v14_multiple_tiles_roundtrip() {
    let (w, h) = (300u32, 210u32);
    let data = texture(w, h);
    let img = view(w, h, &data);
    let fri = encode_with_version(&img, EncodeMode::Lossy { quality: 70 }, 14).unwrap();
    assert_eq!(read_info(&fri).unwrap().version, 14);
    let out = decode(&fri).unwrap();
    assert_eq!((out.width, out.height), (w, h));
    assert_eq!(out.data.len(), (w * h * 4) as usize);
}

#[test]
fn v14_pattern_is_cyclic_over_roots() {
    let data = texture(193, 129);
    let img = view(193, 129, &data);
    let pattern = [0u8, 1, 2, 3, 3, 2, 1];
    let a = encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &pattern).unwrap();
    let expanded: Vec<u8> = (0..35).map(|i| pattern[i % pattern.len()]).collect();
    let b = encode_with_version_ts(&img, EncodeMode::Lossy { quality: 75 }, 14, &expanded).unwrap();
    assert_eq!(a, b, "паттерн применяется циклично по корням luma");
    assert!(decode(&a).is_ok());
}
