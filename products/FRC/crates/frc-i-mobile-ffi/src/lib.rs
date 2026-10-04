//! File-oriented native bridge used by the Expo local module.

use std::ffi::{CStr, c_char};
use std::path::Path;

use frc_i::{DecodeLimits, PixelFormat};
use frc_i_integration::{IngestOptions, decode_frc_i_to_png, ingest};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbImage, RgbaImage};

pub const MOBILE_FFI_OK: i32 = 0;
pub const MOBILE_FFI_INVALID_ARGUMENT: i32 = -1;
pub const MOBILE_FFI_IO: i32 = -2;
pub const MOBILE_FFI_CODEC: i32 = -3;

fn encode_file(input: &Path, output: &Path, quality: u8) -> i32 {
    if !(1..=100).contains(&quality) {
        return MOBILE_FFI_INVALID_ARGUMENT;
    }
    let source = match std::fs::read(input) {
        Ok(bytes) => bytes,
        Err(_) => return MOBILE_FFI_IO,
    };
    let fri = match ingest(
        &source,
        IngestOptions {
            max_dimension: 2048,
            max_pixels: 50_000_000,
            quality,
        },
    ) {
        Ok(encoded) => encoded,
        Err(_) => return MOBILE_FFI_CODEC,
    };
    write_atomic(output, &fri.bytes)
}

fn decode_file(input: &Path, output: &Path) -> i32 {
    let source = match std::fs::read(input) {
        Ok(bytes) => bytes,
        Err(_) => return MOBILE_FFI_IO,
    };
    let png = match decode_frc_i_to_png(&source, DecodeLimits::default()) {
        Ok(bytes) => bytes,
        Err(_) => return MOBILE_FFI_CODEC,
    };
    write_atomic(output, &png)
}

/// Декодирует FRI, масштабирует под показ (только вниз, пропорции сохраняются)
/// и пишет JPEG (без альфы) либо PNG (с альфой). Возврат — код формата
/// (0 = JPEG, 1 = PNG) при успехе, иначе один из `MOBILE_FFI_*`.
fn decode_file_scaled(input: &Path, output: &Path, max_dimension: u32, quality: u8) -> i32 {
    if max_dimension == 0 {
        return MOBILE_FFI_INVALID_ARGUMENT;
    }
    let source = match std::fs::read(input) {
        Ok(bytes) => bytes,
        Err(_) => return MOBILE_FFI_IO,
    };
    let decoded = match frc_i::decode(&source) {
        Ok(image) => image,
        Err(_) => return MOBILE_FFI_CODEC,
    };
    let has_alpha = matches!(decoded.format, PixelFormat::Rgba8);
    // quality относится только к JPEG-пути; для PNG (альфа) он игнорируется.
    if !has_alpha && !(1..=100).contains(&quality) {
        return MOBILE_FFI_INVALID_ARGUMENT;
    }
    let image = if has_alpha {
        match RgbaImage::from_raw(decoded.width, decoded.height, decoded.data) {
            Some(buffer) => DynamicImage::ImageRgba8(buffer),
            None => return MOBILE_FFI_CODEC,
        }
    } else {
        match RgbImage::from_raw(decoded.width, decoded.height, decoded.data) {
            Some(buffer) => DynamicImage::ImageRgb8(buffer),
            None => return MOBILE_FFI_CODEC,
        }
    };
    // thumbnail() масштабирует и вверх при отсутствии явной проверки — держим
    // изображения меньше max_dimension нетронутыми (см. frc-i-integration::resize_max).
    let scaled = if image.width() <= max_dimension && image.height() <= max_dimension {
        image
    } else {
        image.thumbnail(max_dimension, max_dimension)
    };
    let (bytes, format_code) = if has_alpha {
        let buffer = scaled.to_rgba8();
        let mut bytes = Vec::new();
        let encoded =
            PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
                .write_image(
                    &buffer,
                    scaled.width(),
                    scaled.height(),
                    ExtendedColorType::Rgba8,
                );
        if encoded.is_err() {
            return MOBILE_FFI_CODEC;
        }
        (bytes, 1)
    } else {
        let buffer = scaled.to_rgb8();
        let mut bytes = Vec::new();
        let encoded = JpegEncoder::new_with_quality(&mut bytes, quality).write_image(
            &buffer,
            scaled.width(),
            scaled.height(),
            ExtendedColorType::Rgb8,
        );
        if encoded.is_err() {
            return MOBILE_FFI_CODEC;
        }
        (bytes, 0)
    };
    match write_atomic(output, &bytes) {
        MOBILE_FFI_OK => format_code,
        error => error,
    }
}

/// Читает ширину/высоту из 20-байтового заголовка FRI без декодирования тела.
fn read_info(input: &Path) -> Result<(u32, u32), i32> {
    let source = std::fs::read(input).map_err(|_| MOBILE_FFI_IO)?;
    let info = frc_i::read_info(&source).map_err(|_| MOBILE_FFI_CODEC)?;
    Ok((info.width, info.height))
}

fn write_atomic(output: &Path, bytes: &[u8]) -> i32 {
    let temporary = output.with_extension("flora-frc-i.tmp");
    if std::fs::write(&temporary, bytes).is_err() {
        return MOBILE_FFI_IO;
    }
    if std::fs::rename(&temporary, output).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return MOBILE_FFI_IO;
    }
    MOBILE_FFI_OK
}

unsafe fn path_from_c<'a>(value: *const c_char) -> Option<&'a Path> {
    if value.is_null() {
        return None;
    }
    // SAFETY: caller promises a valid NUL-terminated UTF-8 string.
    let value = unsafe { CStr::from_ptr(value) }.to_str().ok()?;
    Some(Path::new(value))
}

/// # Safety
/// Paths must be valid NUL-terminated UTF-8 strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_mobile_encode_file(
    input: *const c_char,
    output: *const c_char,
    quality: u8,
) -> i32 {
    // SAFETY: forwarded C ABI contract.
    let Some(input) = (unsafe { path_from_c(input) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    // SAFETY: forwarded C ABI contract.
    let Some(output) = (unsafe { path_from_c(output) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    encode_file(input, output, quality)
}

/// # Safety
/// Paths must be valid NUL-terminated UTF-8 strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_mobile_decode_file(
    input: *const c_char,
    output: *const c_char,
) -> i32 {
    // SAFETY: forwarded C ABI contract.
    let Some(input) = (unsafe { path_from_c(input) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    // SAFETY: forwarded C ABI contract.
    let Some(output) = (unsafe { path_from_c(output) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    decode_file(input, output)
}

/// # Safety
/// Paths must be valid NUL-terminated UTF-8 strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_mobile_decode_file_scaled(
    input: *const c_char,
    output: *const c_char,
    max_dimension: u32,
    quality: u8,
) -> i32 {
    // SAFETY: forwarded C ABI contract.
    let Some(input) = (unsafe { path_from_c(input) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    // SAFETY: forwarded C ABI contract.
    let Some(output) = (unsafe { path_from_c(output) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    decode_file_scaled(input, output, max_dimension, quality)
}

/// # Safety
/// `input` must be a valid NUL-terminated UTF-8 string; `out_width` and
/// `out_height` must be valid, non-null, properly aligned pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_mobile_read_info(
    input: *const c_char,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    // SAFETY: forwarded C ABI contract.
    let Some(input) = (unsafe { path_from_c(input) }) else {
        return MOBILE_FFI_INVALID_ARGUMENT;
    };
    if out_width.is_null() || out_height.is_null() {
        return MOBILE_FFI_INVALID_ARGUMENT;
    }
    match read_info(input) {
        Ok((width, height)) => {
            // SAFETY: caller guarantees valid, non-null, aligned pointers (checked above).
            unsafe {
                *out_width = width;
                *out_height = height;
            }
            MOBILE_FFI_OK
        }
        Err(code) => code,
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::JNIEnv;
    use jni::objects::{JClass, JIntArray, JString};
    use jni::sys::jint;

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florafrci_FloraFrcINative_encodeFile(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        input: JString<'_>,
        output: JString<'_>,
        quality: jint,
    ) -> jint {
        let Ok(input) = env.get_string(&input) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        let Ok(output) = env.get_string(&output) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        encode_file(
            Path::new(input.to_str().unwrap_or_default()),
            Path::new(output.to_str().unwrap_or_default()),
            quality.clamp(0, 255) as u8,
        )
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florafrci_FloraFrcINative_decodeFile(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        input: JString<'_>,
        output: JString<'_>,
    ) -> jint {
        let Ok(input) = env.get_string(&input) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        let Ok(output) = env.get_string(&output) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        decode_file(
            Path::new(input.to_str().unwrap_or_default()),
            Path::new(output.to_str().unwrap_or_default()),
        )
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florafrci_FloraFrcINative_decodeFileScaled(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        input: JString<'_>,
        output: JString<'_>,
        max_dimension: jint,
        quality: jint,
    ) -> jint {
        let Ok(input) = env.get_string(&input) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        let Ok(output) = env.get_string(&output) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        decode_file_scaled(
            Path::new(input.to_str().unwrap_or_default()),
            Path::new(output.to_str().unwrap_or_default()),
            max_dimension.max(0) as u32,
            quality.clamp(0, 255) as u8,
        )
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_florafrci_FloraFrcINative_readInfo(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        input: JString<'_>,
        out: JIntArray<'_>,
    ) -> jint {
        let Ok(input) = env.get_string(&input) else {
            return MOBILE_FFI_INVALID_ARGUMENT;
        };
        match read_info(Path::new(input.to_str().unwrap_or_default())) {
            Ok((width, height)) => {
                let values = [width as i32, height as i32];
                if env.set_int_array_region(&out, 0, &values).is_err() {
                    return MOBILE_FFI_IO;
                }
                MOBILE_FFI_OK
            }
            Err(code) => code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageFormat;

    #[test]
    fn native_file_cycle() {
        let root = std::env::temp_dir().join(format!("frc-i-mobile-ffi-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("input.png");
        let encoded = root.join("output.fri");
        let decoded = root.join("decoded.png");
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[10, 20, 30, 255], 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        std::fs::write(&input, png).unwrap();
        assert_eq!(encode_file(&input, &encoded, 75), MOBILE_FFI_OK);
        assert_eq!(decode_file(&encoded, &decoded), MOBILE_FFI_OK);
        assert!(image::load_from_memory(&std::fs::read(&decoded).unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "frc-i-mobile-ffi-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn make_pixels(width: u32, height: u32, has_alpha: bool) -> Vec<u8> {
        let mut pixels =
            Vec::with_capacity((width * height) as usize * if has_alpha { 4 } else { 3 });
        for y in 0..height {
            for x in 0..width {
                pixels.push(((x * 7 + y * 3) % 256) as u8);
                pixels.push(((x * 5 + y * 11) % 256) as u8);
                pixels.push(((x * 13 + y * 2) % 256) as u8);
                if has_alpha {
                    pixels.push(255);
                }
            }
        }
        pixels
    }

    fn write_test_png(path: &Path, width: u32, height: u32, has_alpha: bool) {
        let pixels = make_pixels(width, height, has_alpha);
        let color = if has_alpha {
            ExtendedColorType::Rgba8
        } else {
            ExtendedColorType::Rgb8
        };
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&pixels, width, height, color)
            .unwrap();
        std::fs::write(path, png).unwrap();
    }

    #[test]
    fn decode_file_scaled_downscales_and_picks_jpeg_for_opaque_image() {
        let root = temp_root("scaled-jpeg");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        let out = root.join("out.bin");
        write_test_png(&input, 40, 20, false);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);

        let code = decode_file_scaled(&fri, &out, 10, 80);
        assert_eq!(code, 0, "opaque image must be written as JPEG");

        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
        let loaded = image::load_from_memory(&bytes).unwrap();
        assert!(!loaded.color().has_alpha());
        // 40x20 → max side 10 → 10x5, aspect ratio preserved.
        assert_eq!((loaded.width(), loaded.height()), (10, 5));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn decode_file_scaled_picks_png_for_image_with_alpha() {
        let root = temp_root("scaled-png");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        let out = root.join("out.bin");
        write_test_png(&input, 20, 40, true);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);

        let code = decode_file_scaled(&fri, &out, 10, 80);
        assert_eq!(code, 1, "image with alpha must be written as PNG");

        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Png);
        let loaded = image::load_from_memory(&bytes).unwrap();
        assert!(loaded.color().has_alpha());
        // 20x40 → max side 10 → 5x10, aspect ratio preserved.
        assert_eq!((loaded.width(), loaded.height()), (5, 10));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn decode_file_scaled_does_not_upscale_smaller_images() {
        let root = temp_root("scaled-no-upscale");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        let out = root.join("out.bin");
        write_test_png(&input, 8, 4, false);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);

        assert_eq!(decode_file_scaled(&fri, &out, 100, 80), 0);
        let loaded = image::load_from_memory(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!((loaded.width(), loaded.height()), (8, 4));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn decode_file_scaled_ignores_quality_for_png_path() {
        let root = temp_root("scaled-quality-ignored");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        let out = root.join("out.bin");
        write_test_png(&input, 12, 6, true);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);

        // quality=0 is invalid for JPEG but must not block the PNG (alpha) path.
        assert_eq!(decode_file_scaled(&fri, &out, 6, 0), 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn decode_file_scaled_rejects_invalid_arguments_without_panic() {
        let root = temp_root("scaled-invalid");
        let missing = root.join("does-not-exist.fri");
        let out = root.join("out.bin");
        assert_eq!(decode_file_scaled(&missing, &out, 10, 80), MOBILE_FFI_IO);

        let corrupt = root.join("corrupt.fri");
        std::fs::write(&corrupt, [0u8; 4]).unwrap();
        assert!(decode_file_scaled(&corrupt, &out, 10, 80) < 0);

        let input = root.join("input.png");
        let fri = root.join("input.fri");
        write_test_png(&input, 8, 8, false);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);
        assert_eq!(
            decode_file_scaled(&fri, &out, 0, 80),
            MOBILE_FFI_INVALID_ARGUMENT,
            "max_dimension = 0 must be rejected"
        );
        assert_eq!(
            decode_file_scaled(&fri, &out, 10, 0),
            MOBILE_FFI_INVALID_ARGUMENT,
            "quality out of range must be rejected on the JPEG path"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_info_matches_full_decode_without_decoding_body() {
        let root = temp_root("read-info");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        write_test_png(&input, 17, 33, true);
        assert_eq!(encode_file(&input, &fri, 85), MOBILE_FFI_OK);

        let source = std::fs::read(&fri).unwrap();
        let full = frc_i::decode(&source).unwrap();
        let (width, height) = read_info(&fri).unwrap();
        assert_eq!((width, height), (full.width, full.height));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn read_info_rejects_invalid_input_without_panic() {
        let root = temp_root("read-info-invalid");
        let missing = root.join("does-not-exist.fri");
        assert!(read_info(&missing).is_err());

        let corrupt = root.join("corrupt.fri");
        std::fs::write(&corrupt, [0u8; 4]).unwrap();
        assert!(read_info(&corrupt).is_err());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn c_abi_decode_file_scaled_and_read_info_round_trip() {
        let root = temp_root("cabi");
        let input = root.join("input.png");
        let fri = root.join("input.fri");
        let out = root.join("out.bin");
        write_test_png(&input, 32, 16, false);
        assert_eq!(encode_file(&input, &fri, 90), MOBILE_FFI_OK);

        let input_c = std::ffi::CString::new(fri.to_str().unwrap()).unwrap();
        let output_c = std::ffi::CString::new(out.to_str().unwrap()).unwrap();

        // SAFETY: input_c/output_c are valid NUL-terminated UTF-8 strings for the test.
        let code =
            unsafe { frc_i_mobile_decode_file_scaled(input_c.as_ptr(), output_c.as_ptr(), 8, 80) };
        assert_eq!(code, 0);
        let loaded = image::load_from_memory(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(loaded.width().max(loaded.height()), 8);

        let mut width = 0u32;
        let mut height = 0u32;
        // SAFETY: pointers are valid, non-null and properly aligned for the test.
        let info_code =
            unsafe { frc_i_mobile_read_info(input_c.as_ptr(), &mut width, &mut height) };
        assert_eq!(info_code, MOBILE_FFI_OK);
        assert_eq!((width, height), (32, 16));

        // SAFETY: a null input pointer must be rejected, not dereferenced.
        let null_code =
            unsafe { frc_i_mobile_read_info(std::ptr::null(), &mut width, &mut height) };
        assert_eq!(null_code, MOBILE_FFI_INVALID_ARGUMENT);

        let _ = std::fs::remove_dir_all(root);
    }
}
