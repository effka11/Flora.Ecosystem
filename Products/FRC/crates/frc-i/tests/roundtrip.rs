//! Интеграционные тесты полного цикла encode → decode.

use frc_i::{
    DecodedImage, EncodeError, EncodeMode, ImageView, PixelFormat, decode, encode, encode_with_icc,
    encode_with_version, read_icc, read_info,
};

fn xorshift(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

fn bpp(format: PixelFormat) -> usize {
    match format {
        PixelFormat::Rgb8 => 3,
        PixelFormat::Rgba8 => 4,
    }
}

/// Детерминированное «фотоподобное» изображение: градиенты + структурный шум.
fn synthetic(width: u32, height: u32, format: PixelFormat) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut seed = 0xF102A2025u64 ^ (u64::from(width) << 32) ^ u64::from(height);
    let mut data = Vec::with_capacity(w * h * bpp(format));
    for y in 0..h {
        for x in 0..w {
            let n = (xorshift(&mut seed) % 32) as i32 - 16;
            let r = ((x * 255) / w.max(1)) as i32 + n / 2;
            let g = ((y * 255) / h.max(1)) as i32 + n / 3;
            let b = (((x + y) * 128) / (w + h).max(1)) as i32 + n;
            data.push(r.clamp(0, 255) as u8);
            data.push(g.clamp(0, 255) as u8);
            data.push(b.clamp(0, 255) as u8);
            if matches!(format, PixelFormat::Rgba8) {
                data.push(if x % 7 == 0 { 128 } else { 255 });
            }
        }
    }
    data
}

fn view(width: u32, height: u32, format: PixelFormat, data: &[u8]) -> ImageView<'_> {
    ImageView {
        width,
        height,
        format,
        data,
    }
}

fn psnr_rgb(a: &[u8], b: &[u8]) -> f64 {
    let mse: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(&x, &y)| {
            let d = f64::from(x) - f64::from(y);
            d * d
        })
        .sum::<f64>()
        / a.len() as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

#[test]
fn lossless_exact_various_sizes_rgb() {
    // Размеры вокруг границ тайла 256 и блока 8, плюс вырожденные.
    for &(w, h) in &[
        (1, 1),
        (3, 3),
        (8, 8),
        (13, 9),
        (255, 257),
        (256, 256),
        (300, 100),
        (511, 2),
    ] {
        let data = synthetic(w, h, PixelFormat::Rgb8);
        let fic = encode(&view(w, h, PixelFormat::Rgb8, &data), EncodeMode::Lossless).unwrap();
        let out = decode(&fic).unwrap();
        assert_eq!((out.width, out.height), (w, h));
        assert_eq!(out.format, PixelFormat::Rgb8);
        assert_eq!(out.data, data, "lossless не побайтный на {w}x{h}");
    }
}

#[test]
fn lossless_exact_rgba_alpha_preserved() {
    let (w, h) = (129, 65);
    let data = synthetic(w, h, PixelFormat::Rgba8);
    let fic = encode(&view(w, h, PixelFormat::Rgba8, &data), EncodeMode::Lossless).unwrap();
    let out = decode(&fic).unwrap();
    assert_eq!(out.format, PixelFormat::Rgba8);
    assert_eq!(out.data, data);
}

#[test]
fn lossless_flat_image_is_tiny() {
    let (w, h) = (512, 512);
    let data = vec![77u8; (w * h * 3) as usize];
    let fic = encode(&view(w, h, PixelFormat::Rgb8, &data), EncodeMode::Lossless).unwrap();
    let out = decode(&fic).unwrap();
    assert_eq!(out.data, data);
    // Однотонное изображение 786 КБ должно сжиматься на порядки.
    assert!(
        fic.len() < 4096,
        "плоское изображение заняло {} байт",
        fic.len()
    );
}

#[test]
fn lossy_writes_v5_with_deblock_at_low_quality() {
    let (w, h) = (320, 240);
    let data = synthetic(w, h, PixelFormat::Rgb8);
    let v = view(w, h, PixelFormat::Rgb8, &data);

    let info = read_info(&encode(&v, EncodeMode::Lossy { quality: 30 }).unwrap()).unwrap();
    assert_eq!(info.version, 5);
    assert!(info.deblock, "q<45 должен включать деблокинг");

    let info = read_info(&encode(&v, EncodeMode::Lossy { quality: 45 }).unwrap()).unwrap();
    assert_eq!(info.version, 5);
    assert!(!info.deblock, "q>=45 — без деблокинга");

    // Lossless не использует слой блоков и не требует нового декодера.
    let info = read_info(&encode(&v, EncodeMode::Lossless).unwrap()).unwrap();
    assert_eq!(info.version, 3);
}

#[test]
fn lossy_quality_thresholds() {
    let (w, h) = (320, 240);
    let data = synthetic(w, h, PixelFormat::Rgb8);
    for (quality, min_psnr) in [(30u8, 26.0), (50, 28.0), (75, 30.0), (90, 33.0)] {
        let fic = encode(
            &view(w, h, PixelFormat::Rgb8, &data),
            EncodeMode::Lossy { quality },
        )
        .unwrap();
        let out = decode(&fic).unwrap();
        let p = psnr_rgb(&data, &out.data);
        assert!(p >= min_psnr, "q={quality}: PSNR {p:.1} < {min_psnr}");
    }
}

#[test]
fn lossy_size_monotonic_in_quality() {
    let (w, h) = (320, 240);
    let data = synthetic(w, h, PixelFormat::Rgb8);
    let sizes: Vec<usize> = [30u8, 70, 95]
        .iter()
        .map(|&q| {
            encode(
                &view(w, h, PixelFormat::Rgb8, &data),
                EncodeMode::Lossy { quality: q },
            )
            .unwrap()
            .len()
        })
        .collect();
    assert!(
        sizes[0] < sizes[1] && sizes[1] < sizes[2],
        "размеры не монотонны: {sizes:?}"
    );
}

#[test]
fn lossy_alpha_stays_lossless() {
    let (w, h) = (100, 60);
    let data = synthetic(w, h, PixelFormat::Rgba8);
    let fic = encode(
        &view(w, h, PixelFormat::Rgba8, &data),
        EncodeMode::Lossy { quality: 60 },
    )
    .unwrap();
    let out: DecodedImage = decode(&fic).unwrap();
    assert_eq!(out.format, PixelFormat::Rgba8);
    for (i, (src, dec)) in data
        .chunks_exact(4)
        .zip(out.data.chunks_exact(4))
        .enumerate()
    {
        assert_eq!(src[3], dec[3], "альфа исказилась в пикселе {i}");
    }
}

#[test]
fn info_matches_encode_parameters() {
    let (w, h) = (64, 32);
    let data = synthetic(w, h, PixelFormat::Rgba8);
    let v = view(w, h, PixelFormat::Rgba8, &data);

    let info = read_info(&encode(&v, EncodeMode::Lossless).unwrap()).unwrap();
    assert!(info.lossless && info.has_alpha && !info.chroma420);
    assert_eq!(info.quality, None);
    assert_eq!((info.width, info.height), (w, h));

    let info = read_info(&encode(&v, EncodeMode::Lossy { quality: 70 }).unwrap()).unwrap();
    assert!(
        !info.lossless && info.chroma420,
        "q=70 должен включать 4:2:0"
    );
    assert_eq!(info.quality, Some(70));

    let info = read_info(&encode(&v, EncodeMode::Lossy { quality: 95 }).unwrap()).unwrap();
    assert!(!info.chroma420, "q=95 должен кодировать 4:4:4");
}

#[test]
fn palette_image_is_exact_and_tiny() {
    // 6 цветов на 200x200 — классическая пиктограмма/логотип.
    let (w, h) = (200u32, 200u32);
    let colors: [[u8; 3]; 6] = [
        [255, 255, 255],
        [20, 20, 30],
        [200, 40, 40],
        [40, 160, 90],
        [30, 90, 200],
        [250, 200, 40],
    ];
    let data: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let x = i % w;
            let y = i / w;
            colors[((x / 25 + y / 25) % 6) as usize]
        })
        .collect();
    let img = view(w, h, PixelFormat::Rgb8, &data);

    let fic_ll = encode(&img, EncodeMode::Lossless).unwrap();
    assert_eq!(decode(&fic_ll).unwrap().data, data);
    assert!(
        fic_ll.len() < 2500,
        "палитровое изображение заняло {} байт",
        fic_ll.len()
    );

    // Lossy-запрос на малоцветной графике тоже обязан вернуть точный
    // палитровый поток, раз он меньше DCT.
    let fic_lossy = encode(&img, EncodeMode::Lossy { quality: 75 }).unwrap();
    assert_eq!(
        decode(&fic_lossy).unwrap().data,
        data,
        "палитра в lossy должна быть точной"
    );
    assert!(fic_lossy.len() <= fic_ll.len());
}

#[test]
fn palette_rgba_preserves_alpha_exactly() {
    let (w, h) = (64u32, 64u32);
    let data: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let on = (i / 8) % 2 == 0;
            if on { [200, 30, 90, 255] } else { [0, 0, 0, 0] }
        })
        .collect();
    let img = view(w, h, PixelFormat::Rgba8, &data);
    let fic = encode(&img, EncodeMode::Lossless).unwrap();
    let out = decode(&fic).unwrap();
    assert_eq!(out.format, PixelFormat::Rgba8);
    assert_eq!(out.data, data);
}

#[test]
fn incompressible_noise_bounded_by_raw_fallback() {
    // Худший случай: независимый шум в каналах. Raw-fallback гарантирует
    // потолок ~1 байт/канал; допускаем 3% служебных данных.
    let (w, h) = (256u32, 256u32);
    let mut seed = 0xA5A5_5A5Au64;
    let data: Vec<u8> = (0..w * h * 3)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed & 0xFF) as u8
        })
        .collect();
    let img = view(w, h, PixelFormat::Rgb8, &data);
    let fic = encode(&img, EncodeMode::Lossless).unwrap();
    assert_eq!(decode(&fic).unwrap().data, data);
    let raw = (w * h * 3) as usize;
    assert!(
        fic.len() <= raw + raw / 32,
        "шум занял {} байт при потолке {} + 3%",
        fic.len(),
        raw
    );
}

#[test]
fn icc_roundtrip_all_modes() {
    let (w, h) = (64, 48);
    let icc: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();

    // Lossy: v6, пиксели декодируются, профиль возвращается байт-в-байт.
    let data = synthetic(w, h, PixelFormat::Rgb8);
    let v = view(w, h, PixelFormat::Rgb8, &data);
    let fri = encode_with_icc(&v, EncodeMode::Lossy { quality: 75 }, &icc).unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 6);
    assert!(info.metadata);
    assert_eq!(read_icc(&fri).unwrap().as_deref(), Some(icc.as_slice()));
    let out = decode(&fri).unwrap();
    assert_eq!(out.icc.as_deref(), Some(icc.as_slice()));
    assert_eq!((out.width, out.height), (w, h));

    // Lossless: тоже v6, пиксели побайтно точны.
    let fri = encode_with_icc(&v, EncodeMode::Lossless, &icc).unwrap();
    assert_eq!(read_info(&fri).unwrap().version, 6);
    let out = decode(&fri).unwrap();
    assert_eq!(out.data, data);
    assert_eq!(out.icc.as_deref(), Some(icc.as_slice()));

    // Палитровый lossless (малоцветная графика) сохраняет метаданные.
    let flat = vec![77u8; (w * h * 3) as usize];
    let fri = encode_with_icc(
        &view(w, h, PixelFormat::Rgb8, &flat),
        EncodeMode::Lossless,
        &icc,
    )
    .unwrap();
    let info = read_info(&fri).unwrap();
    assert_eq!(info.version, 6);
    assert!(info.palette && info.metadata);
    let out = decode(&fri).unwrap();
    assert_eq!(out.data, flat);
    assert_eq!(out.icc.as_deref(), Some(icc.as_slice()));

    // Без ICC ничего не меняется: v5/v3, icc = None.
    let fri = encode(&v, EncodeMode::Lossy { quality: 75 }).unwrap();
    assert_eq!(read_icc(&fri).unwrap(), None);
    assert_eq!(decode(&fri).unwrap().icc, None);
}

#[test]
fn v7_adaptive_roundtrip_and_density() {
    // Линия v7 (адаптивная энтропия) доступна только по явному запросу
    // версии; публичный encode() продолжает писать v5 до стабилизации.
    let (w, h) = (320, 240);
    let data = synthetic(w, h, PixelFormat::Rgb8);
    let v = view(w, h, PixelFormat::Rgb8, &data);
    for quality in [30u8, 50, 75, 90] {
        let v5 = encode(&v, EncodeMode::Lossy { quality }).unwrap();
        let v7 = encode_with_version(&v, EncodeMode::Lossy { quality }, 7).unwrap();
        assert_eq!(read_info(&v7).unwrap().version, 7);

        // v7.6 меняет дерево/transform, post-filter и chroma reconstruction,
        // поэтому quality не обязан совпадать с v5; порог ловит крупный срыв.
        let out5 = decode(&v5).unwrap();
        let out7 = decode(&v7).unwrap();
        let p5 = psnr_rgb(&data, &out5.data);
        let p7 = psnr_rgb(&data, &out7.data);
        assert!(
            p7 + 0.75 >= p5,
            "q={quality}: v7.6 потерял слишком много fidelity: {p5:.2} → {p7:.2} dB"
        );

        // Линия v7 обязана оставаться компактнее v5
        // (Kodak v7.6: ~−19.2% BD-rate).
        assert!(
            v7.len() < v5.len(),
            "q={quality}: v7 {} байт не меньше v5 {}",
            v7.len(),
            v5.len()
        );
        assert!(
            (v5.len() - v7.len()) * 100 >= v5.len(), // ≥ 1%
            "q={quality}: выигрыш v7 слишком мал: {} → {}",
            v5.len(),
            v7.len()
        );
    }
}

#[test]
fn v7_non_multiple_of_16_dimensions() {
    for &(w, h) in &[(1u32, 1u32), (7, 5), (17, 33), (100, 60), (257, 255)] {
        let data = synthetic(w, h, PixelFormat::Rgb8);
        let v = view(w, h, PixelFormat::Rgb8, &data);
        let fri = encode_with_version(&v, EncodeMode::Lossy { quality: 75 }, 7).unwrap();
        let out = decode(&fri).unwrap();
        assert_eq!((out.width, out.height), (w, h), "размеры {w}x{h}");
    }
}

#[test]
fn v7_switches_to_chroma_444_after_quality_85() {
    let (w, h) = (96, 64);
    let data = synthetic(w, h, PixelFormat::Rgb8);
    let image = view(w, h, PixelFormat::Rgb8, &data);

    let v7_85 = encode_with_version(&image, EncodeMode::Lossy { quality: 85 }, 7).unwrap();
    let v7_86 = encode_with_version(&image, EncodeMode::Lossy { quality: 86 }, 7).unwrap();
    assert!(read_info(&v7_85).unwrap().chroma420);
    assert!(!read_info(&v7_86).unwrap().chroma420);

    // Замороженная линия v5 сохраняет прежний порог 85.
    let v5_85 = encode(&image, EncodeMode::Lossy { quality: 85 }).unwrap();
    assert!(read_info(&v5_85).unwrap().chroma420);
}

#[test]
fn v7_alpha_stays_lossless() {
    let (w, h) = (100, 60);
    let data = synthetic(w, h, PixelFormat::Rgba8);
    let fri = encode_with_version(
        &view(w, h, PixelFormat::Rgba8, &data),
        EncodeMode::Lossy { quality: 60 },
        7,
    )
    .unwrap();
    let out = decode(&fri).unwrap();
    for (i, (src, dec)) in data
        .chunks_exact(4)
        .zip(out.data.chunks_exact(4))
        .enumerate()
    {
        assert_eq!(src[3], dec[3], "альфа исказилась в пикселе {i}");
    }
}

#[test]
fn icc_input_validation() {
    let data = synthetic(8, 8, PixelFormat::Rgb8);
    let v = view(8, 8, PixelFormat::Rgb8, &data);
    assert!(matches!(
        encode_with_icc(&v, EncodeMode::Lossless, &[]),
        Err(EncodeError::InvalidIcc(_))
    ));
}

#[test]
fn encode_input_validation() {
    let data = vec![0u8; 12];
    assert!(matches!(
        encode(
            &view(2, 2, PixelFormat::Rgb8, &data[..11]),
            EncodeMode::Lossless
        ),
        Err(EncodeError::BufferSizeMismatch {
            expected: 12,
            actual: 11
        })
    ));
    assert!(matches!(
        encode(&view(0, 2, PixelFormat::Rgb8, &[]), EncodeMode::Lossless),
        Err(EncodeError::InvalidDimensions { .. })
    ));
    assert!(matches!(
        encode(
            &view(2, 2, PixelFormat::Rgb8, &data),
            EncodeMode::Lossy { quality: 0 }
        ),
        Err(EncodeError::InvalidQuality(0))
    ));
    assert!(matches!(
        encode(
            &view(2, 2, PixelFormat::Rgb8, &data),
            EncodeMode::Lossy { quality: 101 }
        ),
        Err(EncodeError::InvalidQuality(101))
    ));
}
