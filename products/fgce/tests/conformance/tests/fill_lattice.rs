//! §12 0.16 rows: `FillLattice` against an equivalent `FillRect` sequence.

use fgce::{Blend, Color, NodeId, Request};
use fgce_conformance::{Harness, RED, flat, rect};

const FINE: Color = Color {
    r: 40,
    g: 80,
    b: 120,
    a: 255,
};
const PRIMARY: Color = Color {
    r: 200,
    g: 30,
    b: 30,
    a: 255,
};

fn bad_step() -> Request<'static> {
    Request::FillLattice {
        rect: rect(0, 0, 7, 7),
        step: 0,
        primary_step: None,
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: None,
    }
}

fn manual(area: fgce::Rect, step: i32, primary_step: Option<i32>) -> Harness {
    let mut h = Harness::new();
    h.begin(64, 64);
    let mut x = area.x1;
    while x <= area.x2 {
        let offset = x - area.x1;
        let color = if primary_step.is_some_and(|value| offset % value == 0) {
            PRIMARY
        } else {
            FINE
        };
        h.fill(rect(x, area.y1, x, area.y2), color);
        x += step;
    }
    let mut y = area.y1;
    while y <= area.y2 {
        let offset = y - area.y1;
        let color = if primary_step.is_some_and(|value| offset % value == 0) {
            PRIMARY
        } else {
            FINE
        };
        h.fill(rect(area.x1, y, area.x2, y), color);
        y += step;
    }
    h
}

fn lattice(area: fgce::Rect, step: u32, primary_step: Option<u32>) -> Harness {
    let mut h = Harness::new();
    h.begin(64, 64);
    h.ok(Request::FillLattice {
        rect: area,
        step,
        primary_step,
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: None,
    });
    h
}

#[test]
fn row_g5_lattice_state_precedes_bad_cell() {
    let mut h = Harness::new();
    assert_eq!(h.err(bad_step()), fgce::Error::NotBegun);
    h.begin(8, 8);
    assert_eq!(h.err(bad_step()), fgce::Error::BadCell);
}

#[test]
fn row_g5_lattice_matches_fill_rects() {
    for (area, step, primary) in [
        (rect(0, 0, 63, 63), 15, Some(45)),
        (rect(3, 7, 40, 50), 5, None),
    ] {
        let mut lattice = lattice(area, step, primary);
        let mut manual = manual(area, step as i32, primary.map(|value| value as i32));
        assert_eq!(lattice.end().bytes, manual.end().bytes);
    }
}

#[test]
fn row_g5_lattice_rejects_bad_steps() {
    let mut h = Harness::new();
    h.begin(16, 16);
    let request = |step: u32, primary_step: Option<u32>| Request::FillLattice {
        rect: rect(0, 0, 15, 15),
        step,
        primary_step,
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: None,
    };
    assert_eq!(
        h.submit(request(0, None)).unwrap_err(),
        fgce::Error::BadCell
    );
    assert_eq!(
        h.submit(request(5, Some(0))).unwrap_err(),
        fgce::Error::BadCell
    );
    assert_eq!(
        h.submit(request(5, Some(7))).unwrap_err(),
        fgce::Error::BadCell
    );
}

#[test]
fn row_g5_lattice_does_not_move_the_snapshot_or_place() {
    let mut h = Harness::new();
    h.begin(64, 64);
    h.ok(flat(1, 0, 0, 9, 9, RED));
    let before = h.snapshot();
    h.ok(Request::FillLattice {
        rect: rect(0, 0, 63, 63),
        step: 15,
        primary_step: Some(45),
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: None,
    });
    let after = h.snapshot();
    assert_eq!(before, after);
    h.place(1, rect(4, 4, 13, 13));
    assert_eq!(
        h.snapshot()
            .nodes
            .iter()
            .find(|node| node.id == NodeId(1))
            .unwrap()
            .rect,
        rect(4, 4, 13, 13)
    );
}

#[test]
fn row_g5_lattice_respects_the_clip() {
    let mut h = Harness::new();
    h.begin(64, 64);
    h.clip_push(rect(0, 0, 20, 20));
    h.ok(Request::FillLattice {
        rect: rect(0, 0, 63, 63),
        step: 15,
        primary_step: Some(45),
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: None,
    });
    h.clip_pop();
    assert_eq!(h.pixel_premul(0, 15)[3], 255);
    assert_eq!(h.pixel_premul(15, 15)[3], 255);
    assert_eq!(h.pixel_premul(30, 15)[3], 0);
    assert_eq!(h.pixel_premul(15, 30)[3], 0);
}

#[test]
fn row_g5_lattice_horizontal_wins_at_a_crossing() {
    let mut h = Harness::new();
    h.begin(16, 16);
    h.ok(Request::FillLattice {
        rect: rect(0, 0, 15, 15),
        step: 5,
        primary_step: Some(15),
        fine_color: FINE,
        primary_color: PRIMARY,
        blend: Some(Blend::Src),
    });
    assert_eq!(h.pixel_premul(0, 0), [PRIMARY.r, PRIMARY.g, PRIMARY.b, 255]);
    assert_eq!(
        h.pixel_premul(0, 5),
        [FINE.r, FINE.g, FINE.b, 255],
        "the horizontal line is painted last"
    );
    assert_eq!(
        h.pixel_premul(5, 0),
        [PRIMARY.r, PRIMARY.g, PRIMARY.b, 255],
        "the horizontal line is painted last"
    );
}
