//! File-oriented native bridge used by the Expo local module.

use std::ffi::{CStr, c_char};
use std::path::Path;

use frc_i::DecodeLimits;
use frc_i_integration::{IngestOptions, decode_frc_i_to_png, ingest};

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

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::JNIEnv;
    use jni::objects::{JClass, JString};
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};

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
}
