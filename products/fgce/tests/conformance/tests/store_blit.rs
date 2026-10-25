//! §12 rows 16, 47, 70, 71, 83, 109, 110, 121–127, 147, 153, 154:
//! `Upload`/`Drop`, `Blit`, `Area`, `Alpha8`, tint and premultiply in the store.

use fgce::{
    AlphaMode, Blend, Color, Entity, EntityKind, Error, ImageId, NodeId, PixelFormat, Request,
    Sample,
};
use fgce_conformance::{Harness, photo, rect};

fn solid(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity((width * height * 4) as usize);
    for _ in 0..width * height {
        bytes.extend_from_slice(&pixel);
    }
    bytes
}

fn glyph(id: u32, image: u32, x1: i32, y1: i32, x2: i32, y2: i32) -> Request<'static> {
    Request::Entity(Entity {
        id: NodeId(id),
        kind: EntityKind::Glyph {
            format: PixelFormat::Alpha8,
            image: ImageId(image),
            tint: None,
        },
        on_grid: Some(false),
        edges: fgce_conformance::pixels(x1, y1, x2, y2),
        align: None,
        blend: None,
        radius: None,
    })
}

#[test]
fn row_16_repeat_upload_beyond_the_box() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(
        1,
        10,
        10,
        AlphaMode::Straight,
        &solid(10, 10, [255, 0, 0, 255]),
    );
    h.ok(photo(1, PixelFormat::Rgba8, 1, 0, 0, 9, 9));
    assert_eq!(
        h.try_upload(
            1,
            11,
            11,
            PixelFormat::Rgba8,
            AlphaMode::Straight,
            &solid(11, 11, [0, 255, 0, 255])
        ),
        Error::BoxOverflow
    );
    assert_eq!(
        h.snapshot().nodes[0].rect,
        rect(0, 0, 9, 9),
        "box unchanged"
    );
    assert_eq!(
        h.try_blit(1, rect(0, 0, 10, 10), rect(0, 0, 10, 10), Sample::Crisp),
        Error::BufferLayout,
        "image is still 10×10"
    );
    h.blit(1, rect(0, 0, 9, 9), rect(0, 0, 9, 9), Sample::Crisp);
    assert_eq!(h.pixel(0, 0), [255, 0, 0, 255]);
}

#[test]
fn row_47_drop_of_live_photo_is_unknown_image() {
    let mut h = Harness::new();
    h.begin(100, 100);
    h.upload_rgba(
        1,
        4,
        4,
        AlphaMode::Straight,
        &solid(4, 4, [10, 20, 30, 255]),
    );
    h.ok(photo(1, PixelFormat::Rgba8, 1, 0, 0, 3, 3));
    h.blit(1, rect(0, 0, 3, 3), rect(0, 0, 3, 3), Sample::Crisp);
    let before = h.pixel(1, 1);
    assert_eq!(h.err(Request::Drop { id: ImageId(1) }), Error::UnknownImage);
    h.blit(1, rect(0, 0, 3, 3), rect(0, 0, 3, 3), Sample::Crisp);
    assert_eq!(h.pixel(1, 1), before);
}

#[test]
fn row_70_blit_src_includes_width() {
    let mut h = Harness::new();
    h.upload_rgba(1, 4, 4, AlphaMode::Straight, &solid(4, 4, [1, 2, 3, 255]));
    h.begin(10, 10);
    assert_eq!(
        h.try_blit(1, rect(0, 0, 0, 0), rect(0, 0, 4, 3), Sample::Crisp),
        Error::BufferLayout
    );
    h.blit(1, rect(0, 0, 3, 3), rect(0, 0, 3, 3), Sample::Crisp);
    assert_eq!(h.pixel(0, 0), [1, 2, 3, 255], "store unchanged");
}

#[test]
fn row_71_empty_src_with_negative_x1_is_no_op() {
    let mut h = Harness::new();
    h.upload_rgba(
        1,
        4,
        4,
        AlphaMode::Straight,
        &solid(4, 4, [255, 255, 255, 255]),
    );
    h.begin(10, 10);
    h.blit(1, rect(0, 0, 3, 3), rect(-5, 0, -6, 9), Sample::Crisp);
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 0], "non-positive src is a no-op");
    assert_eq!(
        h.try_blit(1, rect(0, 0, 3, 3), rect(-1, 0, 0, 9), Sample::Crisp),
        Error::BufferLayout
    );
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 0]);
}

#[test]
fn row_83_short_upload_bytes_keep_the_store() {
    let mut h = Harness::new();
    h.begin(10, 10);
    let mut short = solid(4, 4, [9, 9, 9, 255]);
    short.truncate(short.len() - 4);
    assert_eq!(
        h.try_upload(1, 4, 4, PixelFormat::Rgba8, AlphaMode::Straight, &short),
        Error::BufferLayout
    );
    assert_eq!(
        h.try_blit(1, rect(0, 0, 3, 3), rect(0, 0, 3, 3), Sample::Crisp),
        Error::UnknownImage
    );
}

#[test]
fn row_109_area_two_by_one() {
    let mut h = Harness::new();
    let mut bytes = Vec::new();
    for value in [1_u8, 2, 3, 4, 5, 6] {
        bytes.extend_from_slice(&[value, value, value]);
    }
    h.upload(1, 2, 3, PixelFormat::Rgb8, AlphaMode::Straight, &bytes);
    h.begin(4, 4);
    h.blit_full(
        1,
        rect(0, 0, 0, 1),
        rect(0, 0, 1, 2),
        Sample::Area,
        None,
        None,
    );
    assert_eq!(h.pixel(0, 0), [2, 2, 2, 255]);
    assert_eq!(h.pixel(0, 1), [5, 5, 5, 255]);
}

#[test]
fn row_110_area_tint_channel_one() {
    let mut h = Harness::new();
    h.upload(
        1,
        2,
        1,
        PixelFormat::Rgb8,
        AlphaMode::Straight,
        &[0, 0, 0, 200, 200, 200],
    );
    h.begin(4, 4);
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 1, 0),
        Sample::Area,
        Some(Color {
            r: 1,
            g: 1,
            b: 1,
            a: 255,
        }),
        None,
    );
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 255]);
}

#[test]
fn row_121_store_bytes_are_not_premultiplied_twice() {
    let mut h = Harness::new();
    h.upload_rgba(1, 1, 1, AlphaMode::Premul, &[200, 0, 0, 200]);
    for _ in 0..2 {
        h.begin(4, 4);
        h.blit(1, rect(0, 0, 0, 0), rect(0, 0, 0, 0), Sample::Crisp);
        assert_eq!(h.pixel_premul(0, 0), [200, 0, 0, 200]);
        h.end();
    }
}

#[test]
fn row_122_rgb_tint_channel() {
    let mut h = Harness::new();
    h.upload(
        1,
        1,
        1,
        PixelFormat::Rgb8,
        AlphaMode::Straight,
        &[255, 255, 255],
    );
    h.begin(2, 2);
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        Some(Color {
            r: 128,
            g: 128,
            b: 128,
            a: 255,
        }),
        None,
    );
    assert_eq!(h.pixel(0, 0), [128, 128, 128, 255]);
}

#[test]
fn row_123_rgb_tint_alpha() {
    let mut h = Harness::new();
    h.upload(
        1,
        1,
        1,
        PixelFormat::Rgb8,
        AlphaMode::Straight,
        &[255, 255, 255],
    );
    h.begin(2, 2);
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        Some(Color {
            r: 255,
            g: 255,
            b: 255,
            a: 128,
        }),
        None,
    );
    assert_eq!(h.pixel_premul(0, 0), [128, 128, 128, 128]);
}

#[test]
fn row_124_blend_src_replaces() {
    let mut h = Harness::new();
    h.upload_rgba(1, 1, 1, AlphaMode::Premul, &[10, 20, 30, 255]);
    h.begin(2, 2);
    h.fill(
        rect(0, 0, 0, 0),
        Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        },
    );
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        None,
        Some(Blend::Src),
    );
    assert_eq!(h.pixel(0, 0), [10, 20, 30, 255]);
}

#[test]
fn row_125_blend_clear_zeroes() {
    let mut h = Harness::new();
    h.upload_rgba(1, 1, 1, AlphaMode::Premul, &[10, 20, 30, 255]);
    h.begin(2, 2);
    h.fill(
        rect(0, 0, 0, 0),
        Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        },
    );
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        None,
        Some(Blend::Clear),
    );
    assert_eq!(h.pixel(0, 0), [0, 0, 0, 0]);
}

#[test]
fn row_126_alpha8_stays_coverage() {
    let mut h = Harness::new();
    h.upload(1, 1, 1, PixelFormat::Alpha8, AlphaMode::Straight, &[128]);
    h.begin(2, 2);
    h.blit(1, rect(0, 0, 0, 0), rect(0, 0, 0, 0), Sample::Crisp);
    assert_eq!(h.pixel_premul(0, 0), [128, 128, 128, 128]);
}

#[test]
fn row_127_rgba_tint_example() {
    let mut h = Harness::new();
    h.upload_rgba(1, 1, 1, AlphaMode::Premul, &[200, 0, 0, 200]);
    h.begin(2, 2);
    h.blit_full(
        1,
        rect(0, 0, 0, 0),
        rect(0, 0, 0, 0),
        Sample::Crisp,
        Some(Color {
            r: 255,
            g: 0,
            b: 0,
            a: 100,
        }),
        None,
    );
    assert_eq!(h.pixel_premul(0, 0), [78, 0, 0, 78]);
}

#[test]
fn row_147_crisp_and_area_agree_on_equal_sizes() {
    let mut h = Harness::new();
    h.upload_rgba(1, 1, 1, AlphaMode::Straight, &[10, 20, 30, 40]);
    h.begin(2, 2);
    h.blit(1, rect(0, 0, 0, 0), rect(0, 0, 0, 0), Sample::Crisp);
    let crisp = h.pixel_premul(0, 0);
    h.begin(2, 2);
    h.blit(1, rect(0, 0, 0, 0), rect(0, 0, 0, 0), Sample::Area);
    assert_eq!(h.pixel_premul(0, 0), crisp);
    assert_eq!(crisp, [2, 3, 5, 40], "store bytes after premultiply");
}

#[test]
fn row_153_image_id_zero() {
    let mut h = Harness::new();
    h.begin(20, 20);
    assert_eq!(
        h.try_upload(
            0,
            1,
            1,
            PixelFormat::Rgba8,
            AlphaMode::Straight,
            &[0, 0, 0, 0]
        ),
        Error::UnknownImage
    );
    assert_eq!(h.err(Request::Drop { id: ImageId(0) }), Error::UnknownImage);
    assert_eq!(
        h.try_blit(0, rect(0, 0, 0, 0), rect(0, 0, 0, 0), Sample::Crisp),
        Error::UnknownImage
    );
    assert_eq!(
        h.err(photo(1, PixelFormat::Rgba8, 0, 0, 0, 9, 9)),
        Error::UnknownImage
    );
    assert_eq!(h.err(glyph(2, 0, 0, 0, 9, 9)), Error::UnknownImage);
}

#[test]
fn row_154_image_missing_from_store() {
    let mut h = Harness::new();
    h.begin(20, 20);
    assert_eq!(
        h.err(photo(1, PixelFormat::Rgba8, 5, 0, 0, 9, 9)),
        Error::UnknownImage
    );
    assert_eq!(h.err(glyph(2, 5, 0, 0, 9, 9)), Error::UnknownImage);
}
