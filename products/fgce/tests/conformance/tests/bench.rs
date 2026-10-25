//! §12 rows 120 and 146 plus the addendum benchmark: 1920×1080 `FillRect`,
//! matching `Blit` and a vector fill. Wall-clock is printed, never asserted.
//!
//! Pass/fail is the memory invariant: one frame buffer is reused between
//! same-size `Begin` calls, so a second full-frame bitmap cannot appear.

use std::time::Instant;

use fgce::{AlphaMode, Color, FillRule, PixelFormat, Request, Response, Verb};
use fgce_conformance::{Harness, rect};

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;

fn frame_pointer(h: &mut Harness) -> (*const u8, u32) {
    match h.submit(Request::End).expect("End") {
        Response::Frame(frame) => (frame.pixels.as_ptr(), frame.stride),
        _ => unreachable!("End returns Frame"),
    }
}

fn bench(name: &str, run: impl FnOnce()) {
    let start = Instant::now();
    run();
    eprintln!("{name}: {:?}", start.elapsed());
}

#[test]
fn row_120_146_one_frame_buffer_and_benchmarks() {
    let mut h = Harness::new();
    h.begin(WIDTH, HEIGHT);
    let (first, stride) = frame_pointer(&mut h);
    assert_eq!(stride, 7680, "stride = align_up(width * 4, 64)");

    bench("FillRect 1920x1080", || {
        h.begin(WIDTH, HEIGHT);
        h.fill(
            rect(0, 0, WIDTH as i32 - 1, HEIGHT as i32 - 1),
            Color {
                r: 10,
                g: 20,
                b: 30,
                a: 255,
            },
        );
    });
    h.submit(Request::End).expect("End after fill");
    h.begin(WIDTH, HEIGHT);
    let (second, _) = frame_pointer(&mut h);
    assert_eq!(
        first, second,
        "a same-size Begin must reuse the single frame buffer"
    );

    let mut bytes = vec![0_u8; (WIDTH * HEIGHT * 4) as usize];
    for pixel in bytes.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[200, 100, 50, 255]);
    }
    h.upload(
        1,
        WIDTH,
        HEIGHT,
        PixelFormat::Rgba8,
        AlphaMode::Straight,
        &bytes,
    );
    bench("Blit 1920x1080", || {
        h.begin(WIDTH, HEIGHT);
        h.blit(
            1,
            rect(0, 0, WIDTH as i32 - 1, HEIGHT as i32 - 1),
            rect(0, 0, WIDTH as i32 - 1, HEIGHT as i32 - 1),
            fgce::Sample::Crisp,
        );
    });
    h.submit(Request::End).expect("End after blit");

    bench("Vector 1920x1080", || {
        h.begin(WIDTH, HEIGHT);
        h.fill_path(
            &[
                Verb::Move(0, 0),
                Verb::Line(WIDTH as i32, 0),
                Verb::Line(0, HEIGHT as i32),
                Verb::Close,
            ],
            FillRule::NonZero,
            Color {
                r: 255,
                g: 255,
                b: 255,
                a: 255,
            },
        );
    });
    h.submit(Request::End).expect("End after vector");
    h.begin(WIDTH, HEIGHT);
    let (third, _) = frame_pointer(&mut h);
    assert_eq!(first, third, "still the same buffer after three frames");
    assert_eq!(
        match h.submit(Request::ReadPixels {
            rect: rect(0, 0, 0, 0),
            alpha: AlphaMode::Premul,
        }) {
            Ok(Response::Pixels(pixels)) => pixels.stride,
            other => panic!("ReadPixels: {other:?}"),
        },
        4,
        "ReadPixels stride is the intersection width * 4"
    );
}
