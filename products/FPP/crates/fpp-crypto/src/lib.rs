//! FPP crypto kernel — portable surface (native + wasm32).
//!
//! Общая криптография personhood (nullifier'ы, commitments, civic-пайплайн) живёт
//! в `flora-governance-crypto` (FGP-CRYPTO §2); здесь — FPP-специфичные деривации.
//! Сейчас: эпохальный тег устройства для NS-D2 (FPP-SIGNALS §2, §3).

use flora_governance_crypto::ds;
pub use fpp_contracts::PersonhoodLevel;

/// Эпохальный тег устройства (NS-D2): `BLAKE3 derive_key("flora/device/v1/tag",
/// pk_device || epoch_id)` — 32 байта.
///
/// Вычисляется **на устройстве**; сервер видит и хранит только тег (FPP-SIGNALS §3):
/// - один девайс + одна эпоха → один тег: конкурентность личностей на устройстве
///   внутри эпохи наблюдаема;
/// - смена эпохи меняет тег: кросс-эпохная связка без `pk_device` невозможна —
///   долговременный трекинг устройств исключён по построению;
/// - `pk_device` — публичный ключ девайс-пары (hardware-backed где доступно, NS-D1);
///   он не покидает устройство и серверу не предъявляется.
pub fn device_tag_epoch(pk_device: &[u8; 32], epoch_id: &[u8; 16]) -> [u8; 32] {
    let mut material = [0u8; 48];
    material[..32].copy_from_slice(pk_device);
    material[32..].copy_from_slice(epoch_id);
    ds::derive(ds::DEVICE_TAG, &material)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_is_deterministic() {
        let pk = [0x11u8; 32];
        let epoch = [0x22u8; 16];
        assert_eq!(device_tag_epoch(&pk, &epoch), device_tag_epoch(&pk, &epoch));
    }

    #[test]
    fn tag_rotates_with_epoch_and_separates_devices() {
        let pk_a = [0x11u8; 32];
        let pk_b = [0x33u8; 32];
        let epoch_1 = [0x22u8; 16];
        let epoch_2 = [0x44u8; 16];
        assert_ne!(
            device_tag_epoch(&pk_a, &epoch_1),
            device_tag_epoch(&pk_a, &epoch_2)
        );
        assert_ne!(
            device_tag_epoch(&pk_a, &epoch_1),
            device_tag_epoch(&pk_b, &epoch_1)
        );
    }

    #[test]
    fn tag_is_domain_separated_from_civic_pipeline() {
        // Одинаковый материал под разными метками обязан давать разные выходы.
        let material = [0x55u8; 48];
        let pk: [u8; 32] = material[..32].try_into().unwrap();
        let epoch: [u8; 16] = material[32..].try_into().unwrap();
        assert_ne!(
            device_tag_epoch(&pk, &epoch),
            ds::derive(ds::CIVIC_COMMIT, &material)
        );
    }
}
