/** До появления реальных key epochs на сервере — фиксированная эпоха bootstrap (FSCP v1 wire). */
export const FSCP_BOOTSTRAP_KEY_EPOCH_ID = "00000000-0000-4000-8000-000000000001";

/** Если у пользователя в БД ещё нет device_uuid — согласованный sentinel для 1:1 bootstrap. */
export const FSCP_BOOTSTRAP_DEVICE_UUID = "00000000-0000-4000-8000-000000000002";

export const FSCP_WIRE_PREFIX = "fscp1:";

export const FLORA_UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
