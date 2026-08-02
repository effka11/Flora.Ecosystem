//! Каноническая эпоха NS-слоя (FPP-SIGNALS §2 NS-D2, Приложение A).
//!
//! Эпоха — общий такт девайс-тегов, самоотчётов и поручительств (90 дней,
//! FPP §4.1). Деривация обязана быть **одинаковой на устройстве и сервере**:
//! девайс-тег `fpp-crypto::device_tag_epoch(pk_device, epoch_id)` совпадёт
//! у обеих сторон только при каноническом `epoch_id`.
//!
//! Нормативная форма (16 байт): `LE64(genesis_unix_s) || LE64(epoch_index)`.
//! `genesis_unix_s` — публичный R2-параметр инсталляции: включение genesis
//! в id разводит теги разных инсталляций по построению, без дополнительных
//! понятий вроде «идентификатора инсталляции».

/// Длина эпохи по умолчанию: 90 дней в секундах (= эпоха поручительств
/// FPP §4.1, Приложение A FPP-SIGNALS). R2-параметр.
pub const EPOCH_LEN_S: u64 = 90 * 86_400;

/// Индекс эпохи для момента `unix_s` (секунды Unix) относительно genesis.
///
/// `None` до genesis и при вырожденной длине эпохи `0` (некорректный конфиг —
/// отклоняется, а не «чинится»). Деление — усечение (floor на неотрицательных).
pub const fn epoch_index_at(unix_s: u64, genesis_unix_s: u64, epoch_len_s: u64) -> Option<u64> {
    if epoch_len_s == 0 || unix_s < genesis_unix_s {
        return None;
    }
    Some((unix_s - genesis_unix_s) / epoch_len_s)
}

/// Начало эпохи `epoch_index` (секунды Unix); `None` при переполнении `u64`.
pub const fn epoch_start_s(genesis_unix_s: u64, epoch_index: u64, epoch_len_s: u64) -> Option<u64> {
    match epoch_index.checked_mul(epoch_len_s) {
        Some(offset) => offset.checked_add(genesis_unix_s),
        None => None,
    }
}

/// Канонические 16 байт `epoch_id`: `LE64(genesis_unix_s) || LE64(epoch_index)`.
///
/// Потребитель — `fpp-crypto::device_tag_epoch` (здесь только байтовая форма id;
/// сама деривация тега — в криптокрейте).
pub const fn epoch_id_bytes(genesis_unix_s: u64, epoch_index: u64) -> [u8; 16] {
    let g = genesis_unix_s.to_le_bytes();
    let i = epoch_index.to_le_bytes();
    let mut id = [0u8; 16];
    let mut k = 0;
    while k < 8 {
        id[k] = g[k];
        id[k + 8] = i[k];
        k += 1;
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENESIS: u64 = 1_735_689_600; // 2025-01-01T00:00:00Z

    #[test]
    fn index_boundaries() {
        assert_eq!(epoch_index_at(GENESIS, GENESIS, EPOCH_LEN_S), Some(0));
        assert_eq!(epoch_index_at(GENESIS - 1, GENESIS, EPOCH_LEN_S), None);
        assert_eq!(
            epoch_index_at(GENESIS + EPOCH_LEN_S - 1, GENESIS, EPOCH_LEN_S),
            Some(0)
        );
        assert_eq!(
            epoch_index_at(GENESIS + EPOCH_LEN_S, GENESIS, EPOCH_LEN_S),
            Some(1)
        );
        assert_eq!(
            epoch_index_at(GENESIS + 5 * EPOCH_LEN_S + 7, GENESIS, EPOCH_LEN_S),
            Some(5)
        );
    }

    #[test]
    fn degenerate_epoch_len_is_rejected() {
        assert_eq!(epoch_index_at(GENESIS, GENESIS, 0), None);
    }

    #[test]
    fn start_is_inverse_of_index() {
        for index in [0u64, 1, 2, 41] {
            let start = epoch_start_s(GENESIS, index, EPOCH_LEN_S).unwrap();
            assert_eq!(epoch_index_at(start, GENESIS, EPOCH_LEN_S), Some(index));
            assert_eq!(
                epoch_index_at(start + EPOCH_LEN_S - 1, GENESIS, EPOCH_LEN_S),
                Some(index)
            );
        }
        assert_eq!(epoch_start_s(u64::MAX, 2, EPOCH_LEN_S), None);
    }

    #[test]
    fn id_bytes_layout_is_le_genesis_then_index() {
        let id = epoch_id_bytes(0x0102_0304_0506_0708, 0x1112_1314_1516_1718);
        assert_eq!(
            id,
            [
                0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // LE64(genesis)
                0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11, // LE64(index)
            ]
        );
    }

    #[test]
    fn id_separates_installations_and_epochs() {
        assert_ne!(epoch_id_bytes(GENESIS, 3), epoch_id_bytes(GENESIS, 4));
        assert_ne!(epoch_id_bytes(GENESIS, 3), epoch_id_bytes(GENESIS + 1, 3));
    }
}
