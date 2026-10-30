//! C ABI host adapter for wasm hosts (`docs/wasm-abi.md`, v2).
//!
//! The kernel (`fgce`) stays dependency-free and safe. This adapter is the
//! generic transport between the kernel and a wasm host; page geometry is not
//! here. This crate owns the only raw pointers: the request slice and the
//! response buffer.
//! Variable payloads (`verbs`, `children`, `Upload` bytes) are addressed by
//! offsets inside the request buffer, so no host pointers are dereferenced.

mod wire;

use std::ptr;
use std::slice;

use fgce::Engine;

/// Version of this ABI, not of the kernel. The kernel version comes from `Info`.
const ABI_VERSION: u32 = 3;

/// Engine plus the last encoded response. The response is valid until the next
/// `fgce_submit`; the host copies what it needs before submitting again.
pub struct HostEngine {
    engine: Engine,
    response: Vec<u8>,
}

#[unsafe(no_mangle)]
pub extern "C" fn fgce_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn fgce_engine_new() -> *mut HostEngine {
    Box::into_raw(Box::new(HostEngine {
        engine: Engine::new(),
        response: Vec::new(),
    }))
}

/// # Safety
/// `engine` must be a pointer returned by `fgce_engine_new` and not used after.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fgce_engine_free(engine: *mut HostEngine) {
    if engine.is_null() {
        return;
    }
    // SAFETY: the host passes a live pointer from fgce_engine_new exactly once.
    unsafe { drop(Box::from_raw(engine)) };
}

#[unsafe(no_mangle)]
pub extern "C" fn fgce_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer`/`len` must be the pair returned by `fgce_alloc(len)` and unused after.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fgce_free(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    // SAFETY: the host passes the pair from fgce_alloc exactly once.
    unsafe { drop(Vec::from_raw_parts(pointer, 0, len)) };
}

/// Executes one request. Returns `0` on success (the response is in the engine
/// buffer) or `-1` for a null engine/request. Malformed requests are encoded as
/// an `Error(BufferLayout)` response, not as `-1`.
///
/// # Safety
/// `request`/`len` must describe a valid buffer for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fgce_submit(
    engine: *mut HostEngine,
    request: *const u8,
    len: usize,
) -> i32 {
    if engine.is_null() || (request.is_null() && len > 0) {
        return -1;
    }
    let host = unsafe { &mut *engine };
    let data = if len == 0 {
        &[][..]
    } else {
        // SAFETY: the host guarantees `request`/`len`.
        unsafe { slice::from_raw_parts(request, len) }
    };
    let response = match wire::decode_request(data) {
        Ok(decoded) => run(host, &decoded),
        Err(error) => wire::error_response(error),
    };
    host.response = response;
    0
}

fn run(host: &mut HostEngine, decoded: &wire::Decoded) -> Vec<u8> {
    let request = wire::to_request(decoded);
    match host.engine.submit(request) {
        Ok(response) => wire::encode_response(response),
        Err(error) => wire::error_response(error),
    }
}

/// # Safety
/// `engine` must be a live pointer from `fgce_engine_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fgce_response_ptr(engine: *const HostEngine) -> *const u8 {
    if engine.is_null() {
        return ptr::null();
    }
    // SAFETY: the host keeps the engine alive; the pointer is read-only.
    unsafe { &*engine }.response.as_ptr()
}

/// # Safety
/// `engine` must be a live pointer from `fgce_engine_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fgce_response_len(engine: *const HostEngine) -> usize {
    if engine.is_null() {
        return 0;
    }
    // SAFETY: the host keeps the engine alive; the pointer is read-only.
    unsafe { &*engine }.response.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::{
        KIND_ERROR, KIND_FRAME, KIND_INFO, KIND_NONE, KIND_PIXELS, KIND_SNAPSHOT, OP_BEGIN,
        OP_DEBUG_GRID, OP_DEBUG_HOVER, OP_DEBUG_LABEL, OP_DEFINE_REFERENCE, OP_DRAW_TREE, OP_END,
        OP_ENTITY, OP_FILL_LATTICE, OP_FILL_RECT, OP_INFO, OP_READ_PIXELS, OP_SNAPSHOT,
        OP_STROKE_ROUND_RECT, OP_UPLOAD, OP_USE_REFERENCE, Writer,
    };

    const WHITE: [u8; 4] = [255, 255, 255, 255];

    fn response(engine: *mut HostEngine, bytes: &[u8]) -> Vec<u8> {
        // SAFETY: the engine and the request buffer are valid in this test.
        let code = unsafe { fgce_submit(engine, bytes.as_ptr(), bytes.len()) };
        assert_eq!(code, 0);
        // SAFETY: the engine was created by fgce_engine_new.
        let (len, pointer) = unsafe { (fgce_response_len(engine), fgce_response_ptr(engine)) };
        // SAFETY: the pointer/len describe the engine response buffer.
        unsafe { slice::from_raw_parts(pointer, len) }.to_vec()
    }

    fn begin(width: u32, height: u32) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_BEGIN);
        writer.u32(width);
        writer.u32(height);
        writer.out
    }

    fn fill_rect(x1: i32, y1: i32, x2: i32, y2: i32, color: [u8; 4]) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_FILL_RECT);
        writer.i32(x1);
        writer.i32(y1);
        writer.i32(x2);
        writer.i32(y2);
        writer.bytes(&color);
        writer.bool(false);
        writer.bool(false);
        writer.out
    }

    fn read_pixels(x1: i32, y1: i32, x2: i32, y2: i32, straight: bool) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_READ_PIXELS);
        writer.i32(x1);
        writer.i32(y1);
        writer.i32(x2);
        writer.i32(y2);
        writer.u8(u8::from(straight));
        writer.out
    }

    fn pixel_edges(x1: i32, y1: i32, x2: i32, y2: i32) -> Vec<u8> {
        let mut writer = Writer::new();
        for value in [x1, y1, x2, y2] {
            writer.u8(1);
            writer.i32(value);
        }
        writer.out
    }

    fn flat_entity(id: u32, x1: i32, y1: i32, x2: i32, y2: i32, color: [u8; 4]) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_ENTITY);
        writer.u32(id);
        writer.u8(3);
        writer.bytes(&color);
        writer.bool(true);
        writer.bool(false);
        writer.bytes(&pixel_edges(x1, y1, x2, y2));
        writer.bool(false);
        writer.bool(false);
        writer.bool(false);
        writer.out
    }

    fn upload_alpha8(id: u32, width: u32, height: u32, coverage: &[u8]) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_UPLOAD);
        writer.u32(id);
        writer.u32(width);
        writer.u32(height);
        writer.u32(width);
        writer.u8(2);
        writer.u8(0);
        let offset_position = writer.out.len();
        writer.u32(0);
        writer.u32(coverage.len() as u32);
        let offset = writer.out.len() as u32;
        writer.bytes(coverage);
        writer.out[offset_position..offset_position + 4].copy_from_slice(&offset.to_le_bytes());
        writer.out
    }

    fn glyph_entity(id: u32, image: u32, x1: i32, y1: i32, x2: i32, y2: i32) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(OP_ENTITY);
        writer.u32(id);
        writer.u8(1);
        writer.u8(2);
        writer.u32(image);
        writer.bool(true);
        writer.bytes(&WHITE);
        writer.bool(true);
        writer.bool(false);
        writer.bytes(&pixel_edges(x1, y1, x2, y2));
        writer.bool(false);
        writer.bool(false);
        writer.bool(false);
        writer.out
    }

    #[test]
    fn info_reports_the_kernel_version_and_limits() {
        let engine = fgce_engine_new();
        let payload = response(engine, &[OP_INFO]);
        assert_eq!(payload[0], KIND_INFO);
        let mut reader = wire::Reader::new(&payload[1..]);
        let version_len = reader.u32().unwrap() as usize;
        assert_eq!(reader.bytes(version_len).unwrap(), b"0.2.0");
        assert_eq!(reader.u32().unwrap(), 8192);
        assert_eq!(reader.u32().unwrap(), 40);
        assert_eq!(reader.u32().unwrap(), 32);
        assert_eq!(reader.u32().unwrap(), 65_536);
        assert_eq!(reader.u32().unwrap(), 1_048_576);
        assert_eq!(reader.u8().unwrap(), 1);
        assert!(reader.bool().unwrap());
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn begin_fill_end_and_read_pixels() {
        let engine = fgce_engine_new();
        assert_eq!(response(engine, &begin(4, 4))[0], wire::KIND_NONE);
        assert_eq!(
            response(engine, &fill_rect(0, 0, 3, 3, [255, 255, 255, 255]))[0],
            wire::KIND_NONE
        );
        let payload = response(engine, &[OP_END]);
        assert_eq!(payload[0], KIND_FRAME);
        let mut reader = wire::Reader::new(&payload[1..]);
        assert_eq!(reader.u32().unwrap(), 4);
        assert_eq!(reader.u32().unwrap(), 4);
        let stride = reader.u32().unwrap() as usize;
        let pixels_len = reader.u32().unwrap() as usize;
        let pixels = reader.bytes(pixels_len).unwrap();
        assert_eq!(stride, 64);
        assert_eq!(pixels_len, 64 * 4);
        assert_eq!(&pixels[0..4], &[255, 255, 255, 255]);

        let payload = response(engine, &read_pixels(0, 0, 0, 0, true));
        assert_eq!(payload[0], KIND_PIXELS);
        let mut reader = wire::Reader::new(&payload[1..]);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u32().unwrap(), 4);
        let bytes_len = reader.u32().unwrap() as usize;
        assert_eq!(reader.bytes(bytes_len).unwrap(), &WHITE);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn new_request_opcodes_are_decoded() {
        let engine = fgce_engine_new();
        assert_eq!(response(engine, &begin(8, 8))[0], KIND_NONE);

        let mut fill = Writer::new();
        fill.u8(OP_FILL_RECT);
        for value in [0, 0, 7, 7] {
            fill.i32(value);
        }
        fill.bytes(&WHITE);
        fill.bool(false);
        fill.bool(true);
        fill.u8(1);
        fill.u8(50);
        assert_eq!(response(engine, &fill.out)[0], KIND_NONE);

        let mut rounded = Writer::new();
        rounded.u8(OP_STROKE_ROUND_RECT);
        for value in [0, 0, 7, 7] {
            rounded.i32(value);
        }
        rounded.bool(true);
        rounded.u8(1);
        rounded.u8(50);
        rounded.u32(256);
        rounded.u8(2);
        rounded.u8(1);
        rounded.u8(0);
        rounded.u8(1);
        rounded.bytes(&WHITE);
        rounded.bool(false);
        assert_eq!(response(engine, &rounded.out)[0], KIND_NONE);

        let mut lattice = Writer::new();
        lattice.u8(OP_FILL_LATTICE);
        for value in [0, 0, 7, 7] {
            lattice.i32(value);
        }
        lattice.u32(5);
        lattice.bool(true);
        lattice.u32(15);
        lattice.bytes(&WHITE);
        lattice.bytes(&WHITE);
        lattice.bool(false);
        assert_eq!(response(engine, &lattice.out)[0], KIND_NONE);

        assert_eq!(response(engine, &[OP_DRAW_TREE])[0], KIND_NONE);
        assert_eq!(response(engine, &[OP_END])[0], KIND_FRAME);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn debug_requests_are_decoded() {
        let engine = fgce_engine_new();
        assert_eq!(response(engine, &begin(4, 4))[0], KIND_NONE);

        let mut grid = Writer::new();
        grid.u8(OP_DEBUG_GRID);
        grid.bool(true);
        grid.bytes(&[171, 171, 171, 255]);
        grid.bytes(&[255, 0, 0, 128]);
        grid.bool(false);
        grid.bool(true);
        grid.bytes(&[242, 242, 242, 255]);
        grid.u8(200);
        grid.u8(2);
        assert_eq!(response(engine, &grid.out)[0], KIND_NONE);

        let mut hover = Writer::new();
        hover.u8(OP_DEBUG_HOVER);
        hover.bool(true);
        hover.i32(3);
        hover.i32(-4);
        assert_eq!(response(engine, &hover.out)[0], KIND_NONE);

        let mut label = Writer::new();
        label.u8(OP_DEBUG_LABEL);
        label.u32(0);
        label.bool(true);
        let offset_position = label.out.len();
        label.u32(0);
        label.u32(6);
        let offset = label.out.len() as u32;
        label.bytes(b"window");
        label.out[offset_position..offset_position + 4].copy_from_slice(&offset.to_le_bytes());
        assert_eq!(response(engine, &label.out)[0], KIND_NONE);

        assert_eq!(response(engine, &[OP_END])[0], KIND_FRAME);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn upload_glyph_and_snapshot() {
        let engine = fgce_engine_new();
        assert_eq!(response(engine, &begin(2, 2))[0], wire::KIND_NONE);
        assert_eq!(
            response(engine, &upload_alpha8(1, 2, 2, &[255, 0, 0, 0]))[0],
            wire::KIND_NONE
        );
        assert_eq!(
            response(engine, &glyph_entity(1, 1, 0, 0, 1, 1))[0],
            wire::KIND_NONE
        );
        assert_eq!(response(engine, &[OP_END])[0], KIND_FRAME);

        let payload = response(engine, &[OP_SNAPSHOT]);
        assert_eq!(payload[0], KIND_SNAPSHOT);
        let mut reader = wire::Reader::new(&payload[1..]);
        assert!(reader.u64().unwrap() > 0);
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 1);
        assert_eq!(reader.i32().unwrap(), 1);

        let payload = response(engine, &read_pixels(0, 0, 0, 0, true));
        let mut reader = wire::Reader::new(&payload[1..]);
        let _ = (
            reader.i32(),
            reader.i32(),
            reader.u32(),
            reader.u32(),
            reader.u32(),
        );
        let bytes_len = reader.u32().unwrap() as usize;
        assert_eq!(reader.bytes(bytes_len).unwrap(), &WHITE);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn flat_entity_is_snapshotted() {
        let engine = fgce_engine_new();
        assert_eq!(response(engine, &begin(8, 8))[0], wire::KIND_NONE);
        assert_eq!(
            response(engine, &flat_entity(5, 0, 0, 7, 7, [1, 2, 3, 255]))[0],
            wire::KIND_NONE
        );
        let payload = response(engine, &[OP_SNAPSHOT]);
        let mut reader = wire::Reader::new(&payload[1..]);
        let _generation = reader.u64().unwrap();
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u32().unwrap(), 5);
        assert_eq!(reader.u32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 0);
        assert_eq!(reader.i32().unwrap(), 7);
        assert_eq!(reader.i32().unwrap(), 7);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn reference_can_hold_a_tree_before_begin() {
        let engine = fgce_engine_new();
        let mut writer = Writer::new();
        writer.u8(OP_DEFINE_REFERENCE);
        writer.u32(7);
        writer.u32(100);
        writer.u32(100);
        writer.u32(5);
        writer.u32(1);
        writer.i8(0);
        writer.i8(0);
        writer.u32(0);
        writer.u32(0);
        assert_eq!(response(engine, &writer.out)[0], wire::KIND_NONE);
        let mut writer = Writer::new();
        writer.u8(OP_USE_REFERENCE);
        writer.u32(7);
        assert_eq!(response(engine, &writer.out)[0], wire::KIND_NONE);
        assert_eq!(
            response(engine, &flat_entity(1, 0, 0, 9, 9, [255, 255, 255, 255]))[0],
            wire::KIND_NONE
        );
        assert_eq!(response(engine, &begin(100, 100))[0], wire::KIND_NONE);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }

    #[test]
    fn malformed_request_is_a_buffer_layout_error() {
        let engine = fgce_engine_new();
        let payload = response(engine, &[99]);
        assert_eq!(payload, vec![KIND_ERROR, 6]);
        // SAFETY: the engine was created by fgce_engine_new.
        unsafe { fgce_engine_free(engine) };
    }
}
