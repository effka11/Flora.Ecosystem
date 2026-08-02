//! FSCP contracts — shared constants for the functional product.
//! Spec: `Documents/fscp/FSCP.md`. Server validation lives in `fscp-core`.

use uuid::Uuid;

/// Wire prefix `fscp1:`.
pub const WIRE_PREFIX: &str = "fscp1:";

/// Wire prefix группового конверта FSCP-G v1 (`fscpg1:`) — отдельная спецификация,
/// DM-валидатор v1 такие wire отклоняет целиком.
pub const GROUP_WIRE_PREFIX: &str = "fscpg1:";

/// Максимум участников группы FSCP-G v1 (включая отправителя). Паритет
/// `FSCP_GROUP_MAX_MEMBERS` в `@flora/fscp`.
pub const GROUP_MAX_MEMBERS: usize = 128;

/// Wire prefix конверта организатора чатов FSCP-ORG v1 (`fscporg1:`) —
/// зашифрованное состояние папок/архива, сервер хранит opaque blob.
pub const ORGANIZER_WIRE_PREFIX: &str = "fscporg1:";

/// Bootstrap key epoch FSCP v1.
pub const BOOTSTRAP_KEY_EPOCH_ID: Uuid = uuid::uuid!("00000000-0000-4000-8000-000000000001");

/// Bootstrap device sentinel FSCP v1 — паритет `FSCP_BOOTSTRAP_DEVICE_UUID` (TS).
/// Не является записью `user_device_keys`: device-policy проверки его пропускают.
pub const BOOTSTRAP_DEVICE_UUID: Uuid = uuid::uuid!("00000000-0000-4000-8000-000000000002");
