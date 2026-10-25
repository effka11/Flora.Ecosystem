//! sPx quantum and the 5/15 drawing grammar (`fgce.md` §3.1–§3.3, §4.3, §4.8).

use crate::MAX_COORD;
use crate::MAX_K;
use crate::contract::{Edge, Edges, Error};

/// Validates the scale and returns the fine step.
pub(crate) fn fine(k: u32) -> Result<u32, Error> {
    if (1..=MAX_K).contains(&k) {
        Ok(k)
    } else {
        Err(Error::ScaleOutOfRange)
    }
}

/// Validates the scale and returns the primary step.
pub(crate) fn primary(k: u32) -> Result<u32, Error> {
    fine(k).map(|k| 3 * k)
}

/// `length(n, k) = (n * k + 2) / 5` (`fgce.md` §3.3).
pub(crate) fn length(n: u32, k: u32) -> Result<u32, Error> {
    fine(k)?;
    let product = n as u64 * k as u64;
    if product > u32::MAX as u64 {
        return Err(Error::Overflow);
    }
    Ok(((product + 2) / 5) as u32)
}

fn check_coord(value: i64) -> Result<i32, Error> {
    if value.abs() > MAX_COORD {
        Err(Error::Overflow)
    } else {
        Ok(value as i32)
    }
}

fn grid_value(primary: i32, fine: Option<u8>, spx: Option<i32>, k: u32) -> Result<i32, Error> {
    if spx.is_some() && fine.is_none() {
        return Err(Error::BadNudge);
    }
    let fine = fine.unwrap_or(0);
    if fine > 2 {
        return Err(Error::BadNudge);
    }
    let spx = spx.unwrap_or(0);
    if spx.unsigned_abs() >= k {
        return Err(Error::BadNudge);
    }
    let value = primary as i64 * 3 * k as i64 + fine as i64 * k as i64 + spx as i64;
    check_coord(value)
}

/// Parses one edge for an entity or an arbitrary box (`fgce.md` §4.3).
pub(crate) fn parse_edge(edge: Edge, on_grid: bool, k: u32) -> Result<i32, Error> {
    fine(k)?;
    match (on_grid, edge) {
        (true, Edge::Pixel(_)) | (false, Edge::Grid { .. }) => Err(Error::OffGrid),
        (false, Edge::Pixel(value)) => check_coord(value as i64),
        (true, Edge::Grid { primary, fine, spx }) => grid_value(primary, fine, spx, k),
    }
}

/// Parses four edges, enforces the two-offset-side limit and ordering.
pub(crate) fn parse_edges(edges: Edges, on_grid: bool, k: u32) -> Result<[i32; 4], Error> {
    fine(k)?;
    let mut offset_sides = 0_u32;
    if on_grid {
        for edge in [edges.x1, edges.y1, edges.x2, edges.y2] {
            if let Edge::Grid {
                fine: fine_offset,
                spx,
                ..
            } = edge
                && (fine_offset.unwrap_or(0) != 0 || spx.unwrap_or(0) != 0)
            {
                offset_sides += 1;
            }
        }
        if offset_sides > 2 {
            return Err(Error::BadNudge);
        }
    }
    let x1 = parse_edge(edges.x1, on_grid, k)?;
    let y1 = parse_edge(edges.y1, on_grid, k)?;
    let x2 = parse_edge(edges.x2, on_grid, k)?;
    let y2 = parse_edge(edges.y2, on_grid, k)?;
    if x2 < x1 || y2 < y1 {
        return Err(Error::BadCell);
    }
    Ok([x1, y1, x2, y2])
}

/// Parses one inset side (`fgce.md` §4.8): grid only, all three numbers non-negative.
pub(crate) fn parse_inset_side(edge: Option<Edge>, k: u32) -> Result<i32, Error> {
    fine(k)?;
    let Some(edge) = edge else {
        return Ok(0);
    };
    let Edge::Grid {
        primary,
        fine: fine_part,
        spx,
    } = edge
    else {
        return Err(Error::BadNudge);
    };
    if primary < 0 {
        return Err(Error::BadNudge);
    }
    if spx.is_some() && fine_part.is_none() {
        return Err(Error::BadNudge);
    }
    let fine_part = fine_part.unwrap_or(0);
    if fine_part > 2 {
        return Err(Error::BadNudge);
    }
    let spx = spx.unwrap_or(0);
    if spx < 0 || spx.unsigned_abs() >= k {
        return Err(Error::BadNudge);
    }
    let value = primary as i64 * 3 * k as i64 + fine_part as i64 * k as i64 + spx as i64;
    check_coord(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(primary: i32, fine: Option<u8>, spx: Option<i32>) -> Edge {
        Edge::Grid { primary, fine, spx }
    }

    #[test]
    fn scale_range() {
        for k in 1..=40 {
            assert_eq!(fine(k), Ok(k));
            assert_eq!(primary(k), Ok(3 * k));
        }
        assert_eq!(fine(0), Err(Error::ScaleOutOfRange));
        assert_eq!(fine(41), Err(Error::ScaleOutOfRange));
        assert_eq!(primary(41), Err(Error::ScaleOutOfRange));
    }

    #[test]
    fn length_continuity() {
        assert_eq!(length(2, 3), Ok(1));
        assert_eq!(length(22, 3), Ok(13));
        assert_eq!(length(15, 6), Ok(18));
        assert_eq!(length(1, 1), Ok(0));
        assert_eq!(length(1, 3), Ok(1));
        assert_eq!(length(u32::MAX, 1), Ok(858_993_459));
        assert_eq!(length(u32::MAX, 2), Err(Error::Overflow));
    }

    #[test]
    fn edge_grammar() {
        assert_eq!(parse_edge(edge(1, None, None), true, 5), Ok(15));
        assert_eq!(parse_edge(edge(1, Some(1), Some(0)), true, 5), Ok(20));
        assert_eq!(parse_edge(edge(0, Some(0), Some(-3)), true, 5), Ok(-3));
        assert_eq!(
            parse_edge(edge(0, Some(0), Some(5)), true, 5),
            Err(Error::BadNudge)
        );
        assert_eq!(
            parse_edge(edge(0, Some(3), None), true, 5),
            Err(Error::BadNudge)
        );
        assert_eq!(
            parse_edge(edge(0, None, Some(0)), true, 5),
            Err(Error::BadNudge)
        );
        assert_eq!(parse_edge(edge(0, Some(0), Some(5)), true, 10), Ok(5));
        assert_eq!(
            parse_edge(edge(0, Some(0), Some(1)), true, 1),
            Err(Error::BadNudge)
        );
        assert_eq!(parse_edge(Edge::Pixel(20), false, 5), Ok(20));
        assert_eq!(parse_edge(Edge::Pixel(20), true, 5), Err(Error::OffGrid));
        assert_eq!(
            parse_edge(edge(0, None, None), false, 5),
            Err(Error::OffGrid)
        );
    }

    #[test]
    fn edge_coordinate_limit() {
        assert_eq!(
            parse_edge(Edge::Pixel(1_048_577), false, 5),
            Err(Error::Overflow)
        );
        assert_eq!(
            parse_edge(Edge::Pixel(-1_048_576), false, 5),
            Ok(-1_048_576)
        );
    }

    #[test]
    fn edges_allow_two_offset_sides() {
        let two = Edges {
            x1: edge(0, Some(1), None),
            y1: edge(0, Some(0), Some(2)),
            x2: edge(9, None, None),
            y2: edge(9, None, None),
        };
        assert_eq!(parse_edges(two, true, 5), Ok([5, 2, 135, 135]));

        let three = Edges {
            x1: edge(0, Some(1), None),
            y1: edge(0, Some(0), Some(2)),
            x2: edge(9, Some(1), None),
            y2: edge(9, None, None),
        };
        assert_eq!(parse_edges(three, true, 5), Err(Error::BadNudge));

        let reversed = Edges {
            x1: edge(9, None, None),
            y1: edge(9, None, None),
            x2: edge(0, None, None),
            y2: edge(0, None, None),
        };
        assert_eq!(parse_edges(reversed, true, 5), Err(Error::BadCell));
    }

    #[test]
    fn inset_grammar() {
        assert_eq!(parse_inset_side(None, 5), Ok(0));
        assert_eq!(parse_inset_side(Some(edge(1, None, None)), 5), Ok(15));
        assert_eq!(parse_inset_side(Some(edge(1, Some(0), Some(1))), 5), Ok(16));
        assert_eq!(
            parse_inset_side(Some(Edge::Pixel(15)), 5),
            Err(Error::BadNudge)
        );
        assert_eq!(
            parse_inset_side(Some(edge(-1, None, None)), 5),
            Err(Error::BadNudge)
        );
        assert_eq!(
            parse_inset_side(Some(edge(0, Some(0), Some(-1))), 5),
            Err(Error::BadNudge)
        );
        assert_eq!(
            parse_inset_side(Some(edge(0, None, Some(1))), 5),
            Err(Error::BadNudge)
        );
    }
}
