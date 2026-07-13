//! WASM-декодер FVC1 для Apps/Web (`wasm32-unknown-unknown`, без wasm-bindgen).
//!
//! Экспортируемый C-ABI (все указатели — offsets в линейной памяти wasm):
//! ```text
//! fvc_version() -> u32                       версия битстрима (кладётся в major-байт)
//! fvc_alloc(len) -> ptr                      буфер под входной пакет
//! fvc_free(ptr, len)                         освобождение буфера fvc_alloc
//! fvc_decoder_new() -> handle                стейтфул-декодер (опорный кадр внутри)
//! fvc_decoder_free(handle)
//! fvc_decode(handle, ptr, len) -> 0 | -1     декодирование одного пакета
//! fvc_frame_width(handle) / fvc_frame_height(handle)
//! fvc_frame_rgba(handle, out, cap) -> n      последний кадр как RGBA8888 (n байт)
//! ```
//! Конверсия YUV→RGB — BT.601 limited range, целочисленная; ненормативная
//! (только для отображения). JS-глу: см. `www/fvc-player.mjs` рядом с crate.
//!
//! `unsafe` ограничен границей FFI (см. Cargo.toml); инварианты каждого блока
//! описаны на месте. Ядро декодера — безопасный `fvc`.

use fvc::{Decoder, Frame};

/// Версия битстрима в старшем байте, версия обёртки в младшем.
#[unsafe(no_mangle)]
pub extern "C" fn fvc_version() -> u32 {
    (u32::from(fvc::BITSTREAM_VERSION) << 8) | 1
}

/// Выделяет `len` байт в линейной памяти. 0 → null.
#[unsafe(no_mangle)]
pub extern "C" fn fvc_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Освобождает буфер, выделенный `fvc_alloc` с той же длиной.
///
/// # Safety
/// `ptr` обязан быть результатом `fvc_alloc(len)` и не использоваться дальше.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: контракт функции — (ptr, len) от fvc_alloc (capacity == len, len 0).
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) };
}

struct WasmDecoder {
    inner: Decoder,
    last: Option<Frame>,
}

/// Создаёт декодер; хэндл освобождать `fvc_decoder_free`.
#[unsafe(no_mangle)]
pub extern "C" fn fvc_decoder_new() -> *mut core::ffi::c_void {
    Box::into_raw(Box::new(WasmDecoder { inner: Decoder::new(), last: None })).cast()
}

/// # Safety
/// `handle` — живой результат `fvc_decoder_new`; после вызова недействителен.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_decoder_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    // SAFETY: контракт — handle от fvc_decoder_new, единственное владение.
    unsafe { drop(Box::from_raw(handle.cast::<WasmDecoder>())) };
}

/// Декодирует пакет FVC1. Возвращает 0 (ок) или -1 (ошибка битстрима/аргументов).
///
/// # Safety
/// `handle` — живой декодер; `data..data+len` — валидная память (буфер `fvc_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_decode(
    handle: *mut core::ffi::c_void,
    data: *const u8,
    len: usize,
) -> i32 {
    if handle.is_null() || (data.is_null() && len > 0) {
        return -1;
    }
    // SAFETY: контракты выше; декодер не переживает вызов (нет реентерабельности в wasm).
    let dec = unsafe { &mut *handle.cast::<WasmDecoder>() };
    // SAFETY: вызывающий гарантирует len байт по data.
    let packet = unsafe { core::slice::from_raw_parts(data, len) };
    match dec.inner.decode_frame(packet) {
        Ok(frame) => {
            dec.last = Some(frame);
            0
        }
        Err(_) => -1,
    }
}

fn with_decoder<T>(handle: *mut core::ffi::c_void, f: impl FnOnce(&WasmDecoder) -> T, default: T) -> T {
    if handle.is_null() {
        return default;
    }
    // SAFETY: контракт всех вызывающих — живой handle от fvc_decoder_new.
    let dec = unsafe { &*handle.cast::<WasmDecoder>() };
    f(dec)
}

/// Ширина последнего кадра (0 — кадра ещё нет).
///
/// # Safety
/// `handle` — живой декодер.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_frame_width(handle: *mut core::ffi::c_void) -> u32 {
    with_decoder(handle, |d| d.last.as_ref().map_or(0, |f| f.width() as u32), 0)
}

/// Высота последнего кадра (0 — кадра ещё нет).
///
/// # Safety
/// `handle` — живой декодер.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_frame_height(handle: *mut core::ffi::c_void) -> u32 {
    with_decoder(handle, |d| d.last.as_ref().map_or(0, |f| f.height() as u32), 0)
}

/// Пишет последний кадр как RGBA8888 в `out` (ёмкость `cap` байт).
/// Возвращает записанное число байт (w·h·4) или -1 (нет кадра / мало места).
///
/// # Safety
/// `handle` — живой декодер; `out..out+cap` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fvc_frame_rgba(
    handle: *mut core::ffi::c_void,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if handle.is_null() || out.is_null() {
        return -1;
    }
    // SAFETY: живой handle (контракт).
    let dec = unsafe { &*handle.cast::<WasmDecoder>() };
    let Some(frame) = &dec.last else { return -1 };
    let (w, h) = (frame.width(), frame.height());
    let need = w * h * 4;
    if cap < need || need > i32::MAX as usize {
        return -1;
    }
    // SAFETY: cap байт по out гарантированы вызывающим; need <= cap.
    let out = unsafe { core::slice::from_raw_parts_mut(out, need) };
    yuv420_to_rgba(frame, out);
    need as i32
}

/// BT.601 limited-range → RGBA, целочисленно (ненормативно, для отображения).
fn yuv420_to_rgba(f: &Frame, out: &mut [u8]) {
    let (w, h) = (f.width(), f.height());
    for y in 0..h {
        for x in 0..w {
            let yy = (i32::from(f.y.get(x, y)) - 16).max(0) * 298;
            let u = i32::from(f.cb.get(x / 2, y / 2)) - 128;
            let v = i32::from(f.cr.get(x / 2, y / 2)) - 128;
            let r = (yy + 409 * v + 128) >> 8;
            let g = (yy - 100 * u - 208 * v + 128) >> 8;
            let b = (yy + 516 * u + 128) >> 8;
            let o = (y * w + x) * 4;
            out[o] = r.clamp(0, 255) as u8;
            out[o + 1] = g.clamp(0, 255) as u8;
            out[o + 2] = b.clamp(0, 255) as u8;
            out[o + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fvc::{Encoder, EncoderConfig};

    /// FFI-цикл: alloc → decode(key+P) → размеры → RGBA → free.
    #[test]
    fn ffi_decode_cycle() {
        let mut frame = Frame::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                frame.y.set(x, y, ((x * 3 + y) % 250) as u8);
            }
        }
        let mut enc = Encoder::new(EncoderConfig {
            width: 64,
            height: 64,
            qp: 30,
            loop_filter: true,
            keyint: 2,
        })
        .unwrap();
        let key = enc.encode_frame(&frame).unwrap();
        let p = enc.encode_frame(&frame).unwrap();
        assert!(!p.keyframe);

        let dec = fvc_decoder_new();
        for packet in [&key.data, &p.data] {
            let buf = fvc_alloc(packet.len());
            // SAFETY (тест): buf только что выделен нужной длины.
            unsafe {
                core::ptr::copy_nonoverlapping(packet.as_ptr(), buf, packet.len());
                assert_eq!(fvc_decode(dec, buf, packet.len()), 0);
                fvc_free(buf, packet.len());
            }
        }
        unsafe {
            assert_eq!(fvc_frame_width(dec), 64);
            assert_eq!(fvc_frame_height(dec), 64);
            let mut rgba = vec![0u8; 64 * 64 * 4];
            assert_eq!(fvc_frame_rgba(dec, rgba.as_mut_ptr(), rgba.len()), 64 * 64 * 4);
            assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
            // Мусор не проходит.
            let junk = [7u8; 5];
            assert_eq!(fvc_decode(dec, junk.as_ptr(), junk.len()), -1);
            fvc_decoder_free(dec);
        }
    }
}
