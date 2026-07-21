//! WASM-декодер FRC-I для Apps/Web (`wasm32-unknown-unknown`, без wasm-bindgen).
//!
//! Экспортируемый C-ABI (все указатели — offsets в линейной памяти wasm):
//! ```text
//! frc_i_version() -> u32                       версия битстрима (старший байт)
//! frc_i_alloc(len) -> ptr                      буфер под входной пакет
//! frc_i_free(ptr, len)                         освобождение буфера frc_i_alloc
//! frc_i_decode(ptr, len, out, cap) -> n | -1   декодирование .fri в RGB/RGBA
//! frc_i_encode(ptr, len, w, h, bpp, q, out, cap) -> n | <0
//! frc_i_info(ptr, len, out) -> 0 | -1          метаданные (ImageInfoWire)
//! ```
//! `unsafe` ограничен границей FFI; ядро декодера — безопасный `frc_i`.

use frc_i::{
    DecodeLimits, EncodeMode, ImageView, PixelFormat, decode_with_limits, encode, read_info,
};

pub const FRC_I_FFI_INVALID: i32 = -1;
pub const FRC_I_FFI_CAPACITY: i32 = -2;
pub const FRC_I_FFI_ENCODE: i32 = -3;

/// Версия битстрима в старшем байте, версия обёртки в младшем.
#[unsafe(no_mangle)]
pub extern "C" fn frc_i_version() -> u32 {
    (u32::from(frc_i::BITSTREAM_VERSION) << 8) | 2
}

/// Выделяет `len` байт в линейной памяти. 0 → null.
#[unsafe(no_mangle)]
pub extern "C" fn frc_i_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Освобождает буфер, выделенный `frc_i_alloc` с той же длиной.
///
/// # Safety
/// `ptr` обязан быть результатом `frc_i_alloc(len)` и не использоваться дальше.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: контракт функции — (ptr, len) от frc_i_alloc (capacity == len, len 0).
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) };
}

/// Метаданные потока для JS (20 байт, little-endian поля).
#[repr(C)]
pub struct ImageInfoWire {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    /// Бит 0 lossless, 1 alpha, 2 chroma420, 3 identity, 4 palette,
    /// 5 deblock, 6 metadata (ICC).
    pub flags: u32,
    pub quality: u32,
}

/// Читает заголовок без декодирования тела. `out` — 20 байт `ImageInfoWire`.
///
/// # Safety
/// `data..data+len` и `out` — валидная память; `out` вмещает `ImageInfoWire`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_info(data: *const u8, len: usize, out: *mut u8) -> i32 {
    if (data.is_null() && len > 0) || out.is_null() {
        return -1;
    }
    let wire_size = core::mem::size_of::<ImageInfoWire>();
    // SAFETY: вызывающий гарантирует len байт по data и wire_size по out.
    let bytes = unsafe { core::slice::from_raw_parts(data, len) };
    let info = match read_info(bytes) {
        Ok(i) => i,
        Err(_) => return -1,
    };
    let mut flags = 0u32;
    if info.lossless {
        flags |= 1;
    }
    if info.has_alpha {
        flags |= 2;
    }
    if info.chroma420 {
        flags |= 4;
    }
    if info.identity {
        flags |= 8;
    }
    if info.palette {
        flags |= 16;
    }
    if info.deblock {
        flags |= 32;
    }
    if info.metadata {
        flags |= 64;
    }
    let wire = ImageInfoWire {
        version: u32::from(info.version),
        width: info.width,
        height: info.height,
        flags,
        quality: info.quality.map(u32::from).unwrap_or(0),
    };
    // SAFETY: out вмещает ImageInfoWire (контракт).
    unsafe {
        core::ptr::copy_nonoverlapping((&raw const wire).cast::<u8>(), out, wire_size);
    }
    0
}

/// Декодирует `.fri` в `out` (RGB8 или RGBA8). Возвращает число записанных
/// байт или -1 (ошибка / недостаточно места).
///
/// # Safety
/// `data..data+len` и `out..out+cap` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_i_decode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if out.is_null() || len == 0 || data.is_null() {
        return -1;
    }
    // SAFETY: вызывающий гарантирует len байт по data.
    let bytes = unsafe { core::slice::from_raw_parts(data, len) };
    let img = match decode_with_limits(bytes, DecodeLimits::default()) {
        Ok(i) => i,
        Err(_) => return -1,
    };
    let need = img.data.len();
    if cap < need || need > i32::MAX as usize {
        return -1;
    }
    // SAFETY: cap >= need (контракт).
    unsafe {
        core::ptr::copy_nonoverlapping(img.data.as_ptr(), out, need);
    }
    let _ = matches!(img.format, PixelFormat::Rgb8 | PixelFormat::Rgba8);
    need as i32
}

/// Рекомендуемая ёмкость выходного буфера encoder. Это безопасный практический
/// upper bound; точный размер возвращает [`frc_i_encode`].
#[unsafe(no_mangle)]
pub extern "C" fn frc_i_encode_capacity(width: u32, height: u32, bytes_per_pixel: u32) -> usize {
    let raw = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(bytes_per_pixel as usize);
    raw.saturating_mul(2).saturating_add(64 * 1024)
}

/// Кодирует RGB8/RGBA8 в текущий frozen lossy FRC-I v10.
///
/// Возвращает размер результата; `-1` — неверный ввод, `-2` — малый output,
/// `-3` — ошибка encoder.
///
/// # Safety
/// `data..data+len` и `out..out+cap` — валидная память.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn frc_i_encode(
    data: *const u8,
    len: usize,
    width: u32,
    height: u32,
    bytes_per_pixel: u32,
    quality: u32,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if data.is_null() || out.is_null() || width == 0 || height == 0 || !(1..=100).contains(&quality)
    {
        return FRC_I_FFI_INVALID;
    }
    let format = match bytes_per_pixel {
        3 => PixelFormat::Rgb8,
        4 => PixelFormat::Rgba8,
        _ => return FRC_I_FFI_INVALID,
    };
    let expected = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(bytes_per_pixel as usize))
    {
        Some(n) => n,
        None => return FRC_I_FFI_INVALID,
    };
    if len != expected {
        return FRC_I_FFI_INVALID;
    }
    // SAFETY: caller guarantees `len` readable bytes.
    let pixels = unsafe { core::slice::from_raw_parts(data, len) };
    let view = ImageView {
        width,
        height,
        format,
        data: pixels,
    };
    let encoded = match encode(
        &view,
        EncodeMode::Lossy {
            quality: quality as u8,
        },
    ) {
        Ok(bytes) => bytes,
        Err(_) => return FRC_I_FFI_ENCODE,
    };
    if encoded.len() > cap || encoded.len() > i32::MAX as usize {
        return FRC_I_FFI_CAPACITY;
    }
    // SAFETY: output capacity was checked above.
    unsafe {
        core::ptr::copy_nonoverlapping(encoded.as_ptr(), out, encoded.len());
    }
    encoded.len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use frc_i::{EncodeMode, ImageView, PixelFormat, encode};

    #[test]
    fn ffi_decode_cycle() {
        let pixels: Vec<u8> = (0..12).collect();
        let img = ImageView {
            width: 2,
            height: 2,
            format: PixelFormat::Rgb8,
            data: &pixels,
        };
        let fri = encode(&img, EncodeMode::Lossless).unwrap();

        let buf = frc_i_alloc(fri.len());
        unsafe {
            core::ptr::copy_nonoverlapping(fri.as_ptr(), buf, fri.len());
            let mut info = [0u8; core::mem::size_of::<ImageInfoWire>()];
            assert_eq!(frc_i_info(buf, fri.len(), info.as_mut_ptr()), 0);
            let mut out = vec![0u8; 12];
            assert_eq!(
                frc_i_decode(buf, fri.len(), out.as_mut_ptr(), out.len()),
                12
            );
            assert_eq!(out, pixels);
            assert_eq!(frc_i_decode(buf, fri.len(), out.as_mut_ptr(), 11), -1);
            frc_i_free(buf, fri.len());
        }
    }

    #[test]
    fn ffi_encode_cycle() {
        let pixels: Vec<u8> = (0..48).collect();
        let cap = frc_i_encode_capacity(4, 4, 3);
        let mut encoded = vec![0u8; cap];
        let n = unsafe {
            frc_i_encode(
                pixels.as_ptr(),
                pixels.len(),
                4,
                4,
                3,
                75,
                encoded.as_mut_ptr(),
                encoded.len(),
            )
        };
        assert!(n > 0);
        encoded.truncate(n as usize);
        assert!(read_info(&encoded).unwrap().version <= frc_i::BITSTREAM_VERSION);
        assert!(decode_with_limits(&encoded, DecodeLimits::default()).is_ok());
    }
}
