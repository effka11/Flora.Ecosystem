//! §12 row 100: opaque `FillRect` bytes and the untouched outside.

use fgce::Blend;
use fgce_conformance::{Harness, RED, WHITE, rect};

#[test]
fn row_100_opaque_fill_rect_bytes() {
    let mut h = Harness::new();
    h.begin(10, 10);
    h.fill(
        rect(2, 2, 4, 4),
        fgce::Color {
            r: 200,
            g: 100,
            b: 50,
            a: 255,
        },
    );
    let frame = h.end();
    assert_eq!(frame.pixel(3, 3), [200, 100, 50, 255]);
    assert_eq!(frame.pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(5, 5), [0, 0, 0, 0]);
    assert_eq!(frame.pixel(2, 4), [200, 100, 50, 255]);
}

#[test]
fn fill_rect_blend_src_and_clear() {
    let mut h = Harness::new();
    h.begin(4, 4);
    h.fill(rect(0, 0, 3, 3), RED);
    h.fill_blend(rect(1, 1, 2, 2), WHITE, Blend::Src);
    assert_eq!(h.pixel_premul(1, 1), [255, 255, 255, 255]);
    h.fill_blend(rect(0, 0, 0, 0), WHITE, Blend::Clear);
    assert_eq!(h.pixel_premul(0, 0), [0, 0, 0, 0]);
    assert_eq!(h.pixel_premul(3, 3), [255, 0, 0, 255], "outside the clear");
}
