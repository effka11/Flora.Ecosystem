//! Домен Economy: идентичность аккаунтов и часы секвенсора.
//!
//! Ядро (`flora-economy-crypto`) оперирует голыми 16-байтовыми [`AccountId`] (wasm-чистота);
//! домен модуля закрепляет правило: **экономический аккаунт = UUID пользователя Flora**,
//! один к одному. Это осознанное решение против анонимных кошельков-мешков: экономика FEP —
//! экономика людей, Sybil-защита — на уровне personhood, а не «один человек — сто кошельков».

use flora_economy_crypto::amount::{AccountId, Timestamp};
use uuid::Uuid;

/// UUID пользователя → идентификатор аккаунта ядра (те же 16 байт).
pub fn account_id_of(user: Uuid) -> AccountId {
    AccountId(*user.as_bytes())
}

/// Обратное преобразование для DTO/логов.
pub fn uuid_of(account: AccountId) -> Uuid {
    Uuid::from_bytes(account.0)
}

/// Часы секвенсора: журнал требует монотонных меток (ядро отклонит «время вспять»),
/// а системные часы могут прыгать. Секвенсор пишет `max(now, last)` — стандартный приём
/// логических часов поверх настенных.
pub fn sequencer_time(wall_clock_ms: i64, last_entry_at: Timestamp) -> Timestamp {
    Timestamp(wall_clock_ms.max(last_entry_at.0))
}

/// Текущее настенное время (Unix-мс UTC).
pub fn wall_clock_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_roundtrip() {
        let u = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        assert_eq!(uuid_of(account_id_of(u)), u);
    }

    #[test]
    fn sequencer_time_never_goes_back() {
        assert_eq!(sequencer_time(100, Timestamp(200)), Timestamp(200));
        assert_eq!(sequencer_time(300, Timestamp(200)), Timestamp(300));
    }
}
