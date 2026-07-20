//! WASM-обёртка FRV1 (декодер + энкодер) для Apps/Web
//! (`wasm32-unknown-unknown`, без wasm-bindgen).
//!
//! Экспортируемый C-ABI (все указатели — offsets в линейной памяти wasm):
//! ```text
//! frc_v_version() -> u32                       версия битстрима (кладётся в major-байт)
//! frc_v_alloc(len) -> ptr                      буфер под входные данные
//! frc_v_free(ptr, len)                         освобождение буфера frc_v_alloc
//!
//! frc_v_decoder_new() -> handle                стейтфул-декодер (опорный кадр внутри)
//! frc_v_decoder_free(handle)
//! frc_v_decode(handle, ptr, len) -> 0 | -1     декодирование одного пакета
//! frc_v_frame_width(handle) / frc_v_frame_height(handle)
//! frc_v_frame_rgba(handle, out, cap) -> n      последний кадр как RGBA8888 (n байт)
//!
//! frc_v_encoder_new(w, h, qp, keyint, speed, flags) -> handle | 0
//!     flags: bit0 — отключить деблокинг, bit1 — ssim-tune,
//!            bit2 — отключить детектор смены сцены
//! frc_v_encoder_free(handle)
//! frc_v_encode_i420(handle, ptr, len) -> n | -1   кадр Y‖Cb‖Cr (len = w·h·3/2)
//! frc_v_encode_rgba(handle, ptr, len) -> n | -1   кадр RGBA8888 (len = w·h·4)
//! frc_v_packet(handle, out, cap) -> n | -1        копия последнего пакета
//! frc_v_packet_keyframe(handle) -> 1 | 0 | -1
//! ```
//! Конверсии YUV↔RGB — BT.601 limited range, целочисленные; ненормативные
//! (отображение и захват). Сам битстрим от них не зависит: энкодер получает
//! уже готовый YUV. JS-глу: см. `www/frc-v-player.mjs` рядом с crate.
//!
//! `unsafe` ограничен границей FFI (см. Cargo.toml); инварианты каждого блока
//! описаны на месте. Ядро кодека — безопасный `frc_v`.

use frc_v::{Decoder, Encoder, EncoderConfig, Frame};

/// Версия битстрима в старшем байте, версия обёртки в младшем.
#[unsafe(no_mangle)]
pub extern "C" fn frc_v_version() -> u32 {
    (u32::from(frc_v::BITSTREAM_VERSION) << 8) | 1
}

/// Выделяет `len` байт в линейной памяти. 0 → null.
#[unsafe(no_mangle)]
pub extern "C" fn frc_v_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Освобождает буфер, выделенный `frc_v_alloc` с той же длиной.
///
/// # Safety
/// `ptr` обязан быть результатом `frc_v_alloc(len)` и не использоваться дальше.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: контракт функции — (ptr, len) от frc_v_alloc (capacity == len, len 0).
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) };
}

struct WasmDecoder {
    inner: Decoder,
    last: Option<Frame>,
}

/// Создаёт декодер; хэндл освобождать `frc_v_decoder_free`.
#[unsafe(no_mangle)]
pub extern "C" fn frc_v_decoder_new() -> *mut core::ffi::c_void {
    Box::into_raw(Box::new(WasmDecoder {
        inner: Decoder::new(),
        last: None,
    }))
    .cast()
}

/// # Safety
/// `handle` — живой результат `frc_v_decoder_new`; после вызова недействителен.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_decoder_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    // SAFETY: контракт — handle от frc_v_decoder_new, единственное владение.
    unsafe { drop(Box::from_raw(handle.cast::<WasmDecoder>())) };
}

/// Декодирует пакет FRV1. Возвращает 0 (ок) или -1 (ошибка битстрима/аргументов).
///
/// # Safety
/// `handle` — живой декодер; `data..data+len` — валидная память (буфер `frc_v_alloc`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_decode(
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

fn with_decoder<T>(
    handle: *mut core::ffi::c_void,
    f: impl FnOnce(&WasmDecoder) -> T,
    default: T,
) -> T {
    if handle.is_null() {
        return default;
    }
    // SAFETY: контракт всех вызывающих — живой handle от frc_v_decoder_new.
    let dec = unsafe { &*handle.cast::<WasmDecoder>() };
    f(dec)
}

/// Ширина последнего кадра (0 — кадра ещё нет).
///
/// # Safety
/// `handle` — живой декодер.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_frame_width(handle: *mut core::ffi::c_void) -> u32 {
    with_decoder(
        handle,
        |d| d.last.as_ref().map_or(0, |f| f.width() as u32),
        0,
    )
}

/// Высота последнего кадра (0 — кадра ещё нет).
///
/// # Safety
/// `handle` — живой декодер.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_frame_height(handle: *mut core::ffi::c_void) -> u32 {
    with_decoder(
        handle,
        |d| d.last.as_ref().map_or(0, |f| f.height() as u32),
        0,
    )
}

/// Пишет последний кадр как RGBA8888 в `out` (ёмкость `cap` байт).
/// Возвращает записанное число байт (w·h·4) или -1 (нет кадра / мало места).
///
/// # Safety
/// `handle` — живой декодер; `out..out+cap` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_frame_rgba(
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

// ---------------------------------------------------------------------------
// Энкодер
// ---------------------------------------------------------------------------

const ENC_FLAG_NO_LOOP_FILTER: u32 = 1;
const ENC_FLAG_SSIM_TUNE: u32 = 2;
const ENC_FLAG_NO_SCENE_CUT: u32 = 4;

struct WasmEncoder {
    inner: Encoder,
    packet: Vec<u8>,
    keyframe: bool,
    /// Переиспользуемый кадр-приёмник (I420/RGBA → YUV).
    frame: Frame,
}

/// Создаёт энкодер. Возвращает handle или null при некорректной конфигурации
/// (размеры не кратны 8 / вне лимитов, qp > 63, speed > 2, keyint = 0).
#[unsafe(no_mangle)]
pub extern "C" fn frc_v_encoder_new(
    width: u32,
    height: u32,
    qp: u8,
    keyint: u32,
    speed: u8,
    flags: u32,
) -> *mut core::ffi::c_void {
    let cfg = EncoderConfig {
        width,
        height,
        qp,
        loop_filter: flags & ENC_FLAG_NO_LOOP_FILTER == 0,
        keyint,
        ssim_tune: flags & ENC_FLAG_SSIM_TUNE != 0,
        scene_cut: flags & ENC_FLAG_NO_SCENE_CUT == 0,
        speed,
        ..EncoderConfig::default()
    };
    match Encoder::new(cfg) {
        Ok(inner) => Box::into_raw(Box::new(WasmEncoder {
            inner,
            packet: Vec::new(),
            keyframe: false,
            frame: Frame::new(width as usize, height as usize),
        }))
        .cast(),
        Err(_) => core::ptr::null_mut(),
    }
}

/// # Safety
/// `handle` — живой результат `frc_v_encoder_new`; после вызова недействителен.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_encoder_free(handle: *mut core::ffi::c_void) {
    if handle.is_null() {
        return;
    }
    // SAFETY: контракт — handle от frc_v_encoder_new, единственное владение.
    unsafe { drop(Box::from_raw(handle.cast::<WasmEncoder>())) };
}

fn encode_current(enc: &mut WasmEncoder) -> i32 {
    match enc.inner.encode_frame(&enc.frame) {
        Ok(p) => {
            let len = p.data.len();
            enc.packet = p.data;
            enc.keyframe = p.keyframe;
            i32::try_from(len).unwrap_or(-1)
        }
        Err(_) => -1,
    }
}

/// Кодирует кадр I420 (планарный Y ‖ Cb ‖ Cr, len = w·h·3/2).
/// Возвращает длину пакета (забрать через `frc_v_packet`) или -1.
///
/// # Safety
/// `handle` — живой энкодер; `data..data+len` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_encode_i420(
    handle: *mut core::ffi::c_void,
    data: *const u8,
    len: usize,
) -> i32 {
    if handle.is_null() || data.is_null() {
        return -1;
    }
    // SAFETY: контракт — живой handle, len байт по data.
    let enc = unsafe { &mut *handle.cast::<WasmEncoder>() };
    let src = unsafe { core::slice::from_raw_parts(data, len) };
    let (w, h) = (enc.frame.width(), enc.frame.height());
    if len != w * h * 3 / 2 {
        return -1;
    }
    let (y, c) = src.split_at(w * h);
    let (cb, cr) = c.split_at(w * h / 4);
    enc.frame.y.data_mut().copy_from_slice(y);
    enc.frame.cb.data_mut().copy_from_slice(cb);
    enc.frame.cr.data_mut().copy_from_slice(cr);
    encode_current(enc)
}

/// Кодирует кадр RGBA8888 (len = w·h·4); конверсия в YUV 4:2:0 — BT.601
/// limited range, хрома усредняется по 2×2. Возвращает длину пакета или -1.
///
/// # Safety
/// `handle` — живой энкодер; `data..data+len` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_encode_rgba(
    handle: *mut core::ffi::c_void,
    data: *const u8,
    len: usize,
) -> i32 {
    if handle.is_null() || data.is_null() {
        return -1;
    }
    // SAFETY: контракт — живой handle, len байт по data.
    let enc = unsafe { &mut *handle.cast::<WasmEncoder>() };
    let src = unsafe { core::slice::from_raw_parts(data, len) };
    let (w, h) = (enc.frame.width(), enc.frame.height());
    if len != w * h * 4 {
        return -1;
    }
    rgba_to_yuv420(src, &mut enc.frame);
    encode_current(enc)
}

/// Копирует последний пакет в `out` (ёмкость `cap`). Возвращает длину или -1.
///
/// # Safety
/// `handle` — живой энкодер; `out..out+cap` — валидная память.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_packet(
    handle: *mut core::ffi::c_void,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if handle.is_null() || out.is_null() {
        return -1;
    }
    // SAFETY: контракт — живой handle.
    let enc = unsafe { &*handle.cast::<WasmEncoder>() };
    let n = enc.packet.len();
    if n == 0 || cap < n || n > i32::MAX as usize {
        return -1;
    }
    // SAFETY: cap байт по out гарантированы вызывающим; n <= cap.
    unsafe { core::ptr::copy_nonoverlapping(enc.packet.as_ptr(), out, n) };
    n as i32
}

/// Был ли последний пакет ключевым (1/0); -1 — пакета ещё нет.
///
/// # Safety
/// `handle` — живой энкодер.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn frc_v_packet_keyframe(handle: *mut core::ffi::c_void) -> i32 {
    if handle.is_null() {
        return -1;
    }
    // SAFETY: контракт — живой handle.
    let enc = unsafe { &*handle.cast::<WasmEncoder>() };
    if enc.packet.is_empty() {
        return -1;
    }
    i32::from(enc.keyframe)
}

/// RGBA → YUV 4:2:0 BT.601 limited range, целочисленно (ненормативно, захват).
/// Обратна `yuv420_to_rgba` с точностью до округления и субдискретизации.
fn rgba_to_yuv420(src: &[u8], f: &mut Frame) {
    let (w, h) = (f.width(), f.height());
    for y in 0..h {
        for x in 0..w {
            let o = (y * w + x) * 4;
            let (r, g, b) = (
                i32::from(src[o]),
                i32::from(src[o + 1]),
                i32::from(src[o + 2]),
            );
            let yy = 16 + ((66 * r + 129 * g + 25 * b + 128) >> 8);
            f.y.set(x, y, yy.clamp(0, 255) as u8);
        }
    }
    // Хрома из усреднённого RGB 2×2 (размеры кратны 8 — блоки полные).
    for cy in 0..h / 2 {
        for cx in 0..w / 2 {
            let (mut r, mut g, mut b) = (0i32, 0, 0);
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let o = ((2 * cy + dy) * w + 2 * cx + dx) * 4;
                r += i32::from(src[o]);
                g += i32::from(src[o + 1]);
                b += i32::from(src[o + 2]);
            }
            let (r, g, b) = ((r + 2) >> 2, (g + 2) >> 2, (b + 2) >> 2);
            let cb = 128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8);
            let cr = 128 + ((112 * r - 94 * g - 18 * b + 128) >> 8);
            f.cb.set(cx, cy, cb.clamp(0, 255) as u8);
            f.cr.set(cx, cy, cr.clamp(0, 255) as u8);
        }
    }
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
    use frc_v::{Encoder, EncoderConfig};

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
            keyint: 2,
            ..EncoderConfig::default()
        })
        .unwrap();
        let key = enc.encode_frame(&frame).unwrap();
        let p = enc.encode_frame(&frame).unwrap();
        assert!(!p.keyframe);

        let dec = frc_v_decoder_new();
        for packet in [&key.data, &p.data] {
            let buf = frc_v_alloc(packet.len());
            // SAFETY (тест): buf только что выделен нужной длины.
            unsafe {
                core::ptr::copy_nonoverlapping(packet.as_ptr(), buf, packet.len());
                assert_eq!(frc_v_decode(dec, buf, packet.len()), 0);
                frc_v_free(buf, packet.len());
            }
        }
        unsafe {
            assert_eq!(frc_v_frame_width(dec), 64);
            assert_eq!(frc_v_frame_height(dec), 64);
            let mut rgba = vec![0u8; 64 * 64 * 4];
            assert_eq!(
                frc_v_frame_rgba(dec, rgba.as_mut_ptr(), rgba.len()),
                64 * 64 * 4
            );
            assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
            // Мусор не проходит.
            let junk = [7u8; 5];
            assert_eq!(frc_v_decode(dec, junk.as_ptr(), junk.len()), -1);
            frc_v_decoder_free(dec);
        }
    }

    /// FFI-энкодер: I420-путь байт-в-байт совпадает с нативным энкодером,
    /// пакеты декодируются, RGBA-путь даёт согласованный roundtrip.
    #[test]
    fn ffi_encode_cycle() {
        let (w, h) = (64usize, 48usize);
        // Двухкадровая сцена: градиент + сдвиг.
        let mut frames = Vec::new();
        for shift in [0usize, 2] {
            let mut f = Frame::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    f.y.set(x, y, (((x + shift) * 4 + y * 2) % 256) as u8);
                }
            }
            for y in 0..h / 2 {
                for x in 0..w / 2 {
                    f.cb.set(x, y, (90 + x) as u8);
                    f.cr.set(x, y, (160 - y) as u8);
                }
            }
            frames.push(f);
        }

        // Нативный эталон (та же конфигурация, что ниже по FFI).
        let mut native = Encoder::new(EncoderConfig {
            width: w as u32,
            height: h as u32,
            qp: 30,
            keyint: 2,
            speed: 2,
            ..EncoderConfig::default()
        })
        .unwrap();

        let enc = frc_v_encoder_new(w as u32, h as u32, 30, 2, 2, 0);
        assert!(!enc.is_null());
        let dec = frc_v_decoder_new();
        for (i, f) in frames.iter().enumerate() {
            let expected = native.encode_frame(f).unwrap();

            let mut i420 = Vec::with_capacity(w * h * 3 / 2);
            i420.extend_from_slice(f.y.data());
            i420.extend_from_slice(f.cb.data());
            i420.extend_from_slice(f.cr.data());
            // SAFETY (тест): буферы живы, длины согласованы.
            unsafe {
                let n = frc_v_encode_i420(enc, i420.as_ptr(), i420.len());
                assert_eq!(n as usize, expected.data.len(), "frame {i}");
                assert_eq!(frc_v_packet_keyframe(enc), i32::from(expected.keyframe));
                let mut packet = vec![0u8; n as usize];
                assert_eq!(frc_v_packet(enc, packet.as_mut_ptr(), packet.len()), n);
                assert_eq!(packet, expected.data, "FFI must mirror native encoder");
                assert_eq!(frc_v_decode(dec, packet.as_ptr(), packet.len()), 0);
            }
        }

        // RGBA-путь: серый кадр → энкод → декод → тот же серый (с точностью конверсий).
        let rgba = vec![128u8; w * h * 4];
        // SAFETY (тест): буферы живы, длины согласованы.
        unsafe {
            let n = frc_v_encode_rgba(enc, rgba.as_ptr(), rgba.len());
            assert!(n > 0);
            let mut packet = vec![0u8; n as usize];
            assert_eq!(frc_v_packet(enc, packet.as_mut_ptr(), packet.len()), n);
            assert_eq!(frc_v_decode(dec, packet.as_ptr(), packet.len()), 0);
            let mut out = vec![0u8; w * h * 4];
            assert_eq!(
                frc_v_frame_rgba(dec, out.as_mut_ptr(), out.len()),
                (w * h * 4) as i32
            );
            for px in out.chunks_exact(4) {
                for c in &px[..3] {
                    assert!(c.abs_diff(128) <= 6, "grey roundtrip drifted: {px:?}");
                }
            }
            // Неверная длина входа — ошибка, не паника.
            assert_eq!(frc_v_encode_i420(enc, rgba.as_ptr(), 7), -1);
            frc_v_decoder_free(dec);
            frc_v_encoder_free(enc);
        }

        // Невалидная конфигурация → null.
        assert!(frc_v_encoder_new(63, 48, 30, 1, 0, 0).is_null());
        assert!(frc_v_encoder_new(64, 48, 99, 1, 0, 0).is_null());
        assert!(frc_v_encoder_new(64, 48, 30, 1, 9, 0).is_null());
    }
}
