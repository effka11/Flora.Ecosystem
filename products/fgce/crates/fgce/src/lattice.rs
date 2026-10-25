//! Live window lattice (`fgce.md` §3.4).

use crate::contract::{Error, Lattice, Pin};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct LatticeCalc {
    pub(crate) lattice: Lattice,
    pub(crate) sheet_x: u64,
    pub(crate) sheet_y: u64,
}

pub(crate) fn check_pin(pin: Pin) -> Result<(), Error> {
    if (-1..=1).contains(&pin.x) && (-1..=1).contains(&pin.y) {
        Ok(())
    } else {
        Err(Error::BadAnchor)
    }
}

fn check_axis(span: u32, step: u32) -> Result<(), Error> {
    if span < 1 || step < 1 {
        Err(Error::BadCell)
    } else {
        Ok(())
    }
}

fn axis(span: u32, step: u32, pin: i8, x_axis: bool) -> (u32, u64, i64) {
    let count = span.div_ceil(step);
    let sheet = count as u64 * step as u64;
    let slack = span as i64 - sheet as i64;
    // x: -1 is the left edge, y: +1 is the top edge (`fgce.md` §3.4).
    let near = if x_axis { -1 } else { 1 };
    let far = -near;
    let origin = match pin {
        p if p == near => 0,
        p if p == far => slack,
        _ => slack.div_euclid(2),
    };
    (count, sheet, origin)
}

/// Computes both axes of the live lattice. `step` is already `primary(k)`.
pub(crate) fn compute(
    span_x: u32,
    span_y: u32,
    step: u32,
    pin_x: i8,
    pin_y: i8,
) -> Result<LatticeCalc, Error> {
    check_pin(Pin { x: pin_x, y: pin_y })?;
    check_axis(span_x, step)?;
    check_axis(span_y, step)?;
    let (count_x, sheet_x, origin_x) = axis(span_x, step, pin_x, true);
    let (count_y, sheet_y, origin_y) = axis(span_y, step, pin_y, false);
    Ok(LatticeCalc {
        lattice: Lattice {
            count_x,
            count_y,
            origin_x,
            origin_y,
        },
        sheet_x,
        sheet_y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_91() {
        let lattice = compute(91, 91, 15, -1, 1).unwrap();
        assert_eq!(lattice.lattice.count_x, 7);
        assert_eq!(lattice.lattice.count_y, 7);
        assert_eq!(lattice.sheet_x, 105);
        assert_eq!(lattice.lattice.origin_x, 0);
        assert_eq!(lattice.lattice.origin_y, 0);
    }

    #[test]
    fn window_91_by_90() {
        let calc = compute(91, 90, 15, -1, 1).unwrap();
        assert_eq!(calc.lattice.count_x, 7);
        assert_eq!(calc.lattice.count_y, 6);
        assert_eq!(calc.sheet_x, 105);
        assert_eq!(calc.sheet_y, 90);
    }

    #[test]
    fn window_90() {
        let lattice = compute(90, 90, 15, -1, 1).unwrap();
        assert_eq!(lattice.lattice.count_x, 6);
        assert_eq!(lattice.sheet_x, 90);
        assert_eq!(lattice.lattice.origin_x, 0);
    }

    #[test]
    fn window_100_three_pins() {
        let near = compute(100, 100, 15, -1, 1).unwrap();
        assert_eq!(near.lattice.count_x, 7);
        assert_eq!(near.sheet_x, 105);
        assert_eq!(near.lattice.origin_x, 0);
        assert_eq!(near.lattice.origin_y, 0);

        let center = compute(100, 100, 15, 0, 0).unwrap();
        assert_eq!(center.lattice.origin_x, -3);
        assert_eq!(center.lattice.origin_y, -3);

        let far = compute(100, 100, 15, 1, -1).unwrap();
        assert_eq!(far.lattice.origin_x, -5);
        assert_eq!(far.lattice.origin_y, -5);
    }

    #[test]
    fn invalid_lattice() {
        assert_eq!(compute(0, 10, 15, 0, 0).unwrap_err(), Error::BadCell);
        assert_eq!(compute(10, 0, 15, 0, 0).unwrap_err(), Error::BadCell);
        assert_eq!(compute(10, 10, 0, 0, 0).unwrap_err(), Error::BadCell);
        assert_eq!(compute(10, 10, 15, 2, 0).unwrap_err(), Error::BadAnchor);
        assert_eq!(compute(10, 10, 15, 0, -2).unwrap_err(), Error::BadAnchor);
    }
}
