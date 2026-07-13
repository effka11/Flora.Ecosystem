//! Zigzag-отображение знаковых значений (FAC.md, «Энтропийное кодирование»).
//! Битовый транспорт кодека — бинарный range coder (`rangecoder`).

pub fn zigzag(v: i32) -> u32 {
    ((v as u32) << 1) ^ ((v >> 31) as u32)
}

pub fn unzigzag(u: u32) -> i32 {
    ((u >> 1) as i32) ^ -((u & 1) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_roundtrip() {
        for v in [0, 1, -1, 2, -2, 1000, -1000, i32::MAX, i32::MIN] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }

    #[test]
    fn zigzag_is_magnitude_ordered() {
        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
        assert_eq!(zigzag(-2), 3);
        assert_eq!(zigzag(2), 4);
    }
}
