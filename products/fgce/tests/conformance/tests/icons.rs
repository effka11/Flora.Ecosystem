//! §12 0.2.0 rows: the three Luna icons drawn through the public requests.
//!
//! `ink` is the sum of coverage over the whole frame (`Σ alpha / 255` after
//! `SrcOver`), not the sum over the individual strokes.

use fgce::{Cap, Color, Join, Peak, Radius, Rect, Request, Stroke, StrokeAlign, Verb};
use fgce_conformance::{Harness, rect};

/// `MUTED` `#AB`: opaque grey, channel 171.
const MUTED: Color = Color {
    r: 171,
    g: 171,
    b: 171,
    a: 255,
};

struct Stats {
    bbox: Option<Rect>,
    max_channel: u8,
    max_alpha: u8,
    ink: f64,
}

fn stats(bytes: &[u8], width: u32, height: u32) -> Stats {
    let stride = bytes.len() / height as usize;
    let mut bbox: Option<Rect> = None;
    let mut max_channel = 0;
    let mut max_alpha = 0;
    let mut ink = 0.0;
    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let at = y as usize * stride + x as usize * 4;
            let alpha = bytes[at + 3];
            max_alpha = max_alpha.max(alpha);
            max_channel = max_channel.max(bytes[at].max(bytes[at + 1]).max(bytes[at + 2]));
            ink += alpha as f64 / 255.0;
            if alpha == 0 {
                continue;
            }
            bbox = Some(match bbox {
                None => rect(x, y, x, y),
                Some(area) => rect(
                    area.x1.min(x),
                    area.y1.min(y),
                    area.x2.max(x),
                    area.y2.max(y),
                ),
            });
        }
    }
    Stats {
        bbox,
        max_channel,
        max_alpha,
        ink,
    }
}

fn stroke(peak: Peak) -> Stroke {
    Stroke {
        width_q8: 256,
        align: StrokeAlign::Center,
        join: Join::Bevel,
        cap: Cap::Butt,
        peak,
    }
}

fn cross(peak: Peak) -> Vec<u8> {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::StrokePath {
        verbs: &[Verb::Move(1, 1), Verb::Line(10, 10)],
        stroke: stroke(peak),
        color: MUTED,
        blend: None,
    });
    h.ok(Request::StrokePath {
        verbs: &[Verb::Move(10, 1), Verb::Line(1, 10)],
        stroke: stroke(peak),
        color: MUTED,
        blend: None,
    });
    h.end().bytes
}

#[test]
fn row_g10_minus_icon_is_fourteen_by_one() {
    let mut h = Harness::new();
    h.begin(14, 1);
    h.ok(Request::FillRect {
        rect: rect(0, 0, 13, 0),
        color: MUTED,
        blend: None,
        radius: None,
    });
    let frame = h.end();
    let stats = stats(&frame.bytes, frame.width, frame.height);
    assert_eq!(stats.bbox, Some(rect(0, 0, 13, 0)));
    assert_eq!(stats.max_channel, 171);
    assert_eq!(stats.max_alpha, 255);
    assert_eq!(stats.ink, 14.0);
}

#[test]
fn row_g10_frame_icon_is_thirteen_by_thirteen() {
    let mut h = Harness::new();
    h.begin(13, 13);
    h.ok(Request::StrokeRoundRect {
        rect: rect(0, 0, 12, 12),
        radius: None,
        stroke: Stroke {
            width_q8: 256,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Nominal,
        },
        color: MUTED,
        blend: None,
    });
    let frame = h.end();
    let stats = stats(&frame.bytes, frame.width, frame.height);
    assert_eq!(stats.bbox, Some(rect(0, 0, 12, 12)));
    assert_eq!(stats.max_channel, 171);
    assert_eq!(stats.max_alpha, 255);
    assert_eq!(stats.ink, 48.0);
}

#[test]
fn row_g10_cross_icon_is_eleven_by_eleven() {
    let bytes = cross(Peak::Nominal);
    let stats = stats(&bytes, 16, 16);
    assert_eq!(stats.bbox, Some(rect(0, 0, 10, 10)));
    assert_eq!(stats.max_channel, 171);
    assert_eq!(stats.max_alpha, 255);
    assert!(
        (stats.ink - 26.694).abs() < 0.01,
        "Nominal cross ink = {}",
        stats.ink
    );
}

#[test]
fn row_g10_cross_light_ink_is_lower_than_nominal() {
    let light = stats(&cross(Peak::Light), 16, 16);
    let nominal = stats(&cross(Peak::Nominal), 16, 16);
    assert_eq!(
        light.max_alpha, 253,
        "the frame peak is the crossing of two 0.914 strokes"
    );
    assert!(
        (light.ink - 24.569).abs() < 0.01,
        "Light cross ink = {}",
        light.ink
    );
    assert!(
        nominal.ink > light.ink,
        "Nominal {} must exceed Light {}",
        nominal.ink,
        light.ink
    );
}

#[test]
fn row_g10_radius_none_matches_a_plain_stroke_path() {
    let mut rounded = Harness::new();
    rounded.begin(13, 13);
    rounded.ok(Request::StrokeRoundRect {
        rect: rect(0, 0, 12, 12),
        radius: Some(Radius::Percent(0)),
        stroke: Stroke {
            width_q8: 256,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        },
        color: MUTED,
        blend: None,
    });
    let rounded = rounded.end().bytes;

    let mut plain = Harness::new();
    plain.begin(13, 13);
    plain.ok(Request::StrokePath {
        verbs: &[
            Verb::Move(0, 0),
            Verb::Line(13, 0),
            Verb::Line(13, 13),
            Verb::Line(0, 13),
            Verb::Close,
        ],
        stroke: Stroke {
            width_q8: 256,
            align: StrokeAlign::Inside,
            join: Join::Miter { limit_q8: 1024 },
            cap: Cap::Butt,
            peak: Peak::Light,
        },
        color: MUTED,
        blend: None,
    });
    assert_eq!(rounded, plain.end().bytes);
}
