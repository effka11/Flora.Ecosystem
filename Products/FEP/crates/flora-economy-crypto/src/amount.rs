//! Базовые типы величин: суммы ([`Grains`]), идентификаторы ([`AccountId`]) и время ([`Timestamp`]).
//!
//! Суммы — целочисленные (атом `grain`), никакой плавающей точки. Идентификатор аккаунта —
//! 16 сырых байт (совместимо с UUID модуля, но crate не зависит от `uuid`, чтобы граф под wasm32
//! оставался без `getrandom`).

use serde::{Deserialize, Serialize};

/// Сколько атомов (`grain`) в одной единице `liv`. 10^6 — как «6 знаков после запятой»:
/// достаточно тонко для демерреджа на малых балансах, помещается в `i64` c огромным запасом.
pub const LIV_IN_GRAINS: i64 = 1_000_000;

/// Метка времени — Unix-миллисекунды UTC (совместимо с ISO 8601, next-architecture.md §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Timestamp(pub i64);

impl Timestamp {
    /// Разница в миллисекундах `self - earlier` (насыщается снизу нулём — время не идёт вспять).
    pub fn saturating_ms_since(self, earlier: Timestamp) -> i64 {
        (self.0 - earlier.0).max(0)
    }
}

/// Сумма в атомах (`grain`). Знаковая: балансы аккаунтов неотрицательны по инварианту движка,
/// но позиции взаимного кредита могут быть отрицательными (долг).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Grains(pub i64);

impl Grains {
    pub const ZERO: Grains = Grains(0);

    /// Из целого числа единиц `liv` (насыщается при переполнении).
    pub fn from_liv(liv: i64) -> Grains {
        Grains(liv.saturating_mul(LIV_IN_GRAINS))
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }

    /// Сложение с проверкой переполнения.
    pub fn checked_add(self, other: Grains) -> Option<Grains> {
        self.0.checked_add(other.0).map(Grains)
    }

    /// Вычитание с проверкой переполнения.
    pub fn checked_sub(self, other: Grains) -> Option<Grains> {
        self.0.checked_sub(other.0).map(Grains)
    }
}

/// Идентификатор экономического аккаунта — 16 сырых байт (обычно UUID модуля).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AccountId(pub [u8; 16]);

impl AccountId {
    /// Из hex-строки (32 hex-символа, с дефисами или без — как UUID). `None` при неверной форме.
    pub fn parse_hex(input: &str) -> Option<AccountId> {
        let mut bytes = [0u8; 16];
        let mut idx = 0;
        let mut hi: Option<u8> = None;
        for ch in input.chars() {
            if ch == '-' {
                continue;
            }
            let nibble = ch.to_digit(16)? as u8;
            match hi.take() {
                None => hi = Some(nibble),
                Some(high) => {
                    if idx >= 16 {
                        return None;
                    }
                    bytes[idx] = (high << 4) | nibble;
                    idx += 1;
                }
            }
        }
        if idx == 16 && hi.is_none() {
            Some(AccountId(bytes))
        } else {
            None
        }
    }

    /// Канонический UUID-подобный hex с дефисами, lowercase (паритет с `Guid.ToString("d")` / TS).
    pub fn to_hyphenated(self) -> String {
        let b = self.0;
        let mut s = String::with_capacity(36);
        for (i, byte) in b.iter().enumerate() {
            if matches!(i, 4 | 6 | 8 | 10) {
                s.push('-');
            }
            s.push(nibble_hex(byte >> 4));
            s.push(nibble_hex(byte & 0x0f));
        }
        s
    }
}

fn nibble_hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'a' + (n - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liv_conversion() {
        assert_eq!(Grains::from_liv(1), Grains(1_000_000));
        assert_eq!(Grains::from_liv(0), Grains::ZERO);
    }

    #[test]
    fn checked_arithmetic() {
        assert_eq!(Grains(10).checked_add(Grains(5)), Some(Grains(15)));
        assert_eq!(Grains(i64::MAX).checked_add(Grains(1)), None);
        assert_eq!(Grains(10).checked_sub(Grains(15)), Some(Grains(-5)));
    }

    #[test]
    fn account_id_hex_roundtrip() {
        let id = AccountId([
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
            0xcd, 0xef,
        ]);
        let s = id.to_hyphenated();
        assert_eq!(s, "01234567-89ab-cdef-0123-456789abcdef");
        assert_eq!(AccountId::parse_hex(&s), Some(id));
        assert_eq!(
            AccountId::parse_hex("0123456789abcdef0123456789abcdef"),
            Some(id)
        );
    }

    #[test]
    fn account_id_rejects_bad_input() {
        assert_eq!(AccountId::parse_hex("xyz"), None);
        assert_eq!(AccountId::parse_hex("0123"), None);
    }

    #[test]
    fn time_since_never_negative() {
        assert_eq!(Timestamp(100).saturating_ms_since(Timestamp(40)), 60);
        assert_eq!(Timestamp(40).saturating_ms_since(Timestamp(100)), 0);
    }
}
