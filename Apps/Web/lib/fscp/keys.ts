/** Профиль FSCP в localStorage: по одному на userUuid, чтобы смена аккаунта не затирала ключи другого пользователя в том же браузере. */
const PROFILE_KEY_PREFIX = "flora.fscp.profile.v1.";

/** Устаревшие общие ключи (до профилей по пользователю). */
const LS_AG = "flora.fscp.agreementPrivateB64";
const LS_SG = "flora.fscp.signingPrivateB64";
const LS_DEV = "flora.fscp.deviceUuidFromServer";
const LS_OWNER = "flora.fscp.ownerUserUuid";

export type FscpLocalMaterial = {
  agreementPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  deviceUuidFromServer: string | null;
};

function profileStorageKey(ownerNorm: string): string {
  return `${PROFILE_KEY_PREFIX}${ownerNorm}`;
}

/** Удаляет только устаревшие общие ключи (миграция). */
export function clearFscpLegacyFlatKeys(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LS_AG);
  localStorage.removeItem(LS_SG);
  localStorage.removeItem(LS_DEV);
  localStorage.removeItem(LS_OWNER);
}

/** Явный сброс FSCP-профиля пользователя на этом устройстве (не вызывается при обычном `clearSession`). */
export function clearFscpMaterialForUser(ownerUserUuid: string): void {
  if (typeof localStorage === "undefined") return;
  const k = ownerUserUuid.trim().toLowerCase();
  if (!k) return;
  localStorage.removeItem(profileStorageKey(k));
}

/**
 * Полный сброс FSCP в origin (все пользователи + legacy). Для отладки и «забыть это устройство»;
 * при обычном выходе ключи не трогаются — см. `clearSession` в `lib/auth.ts`.
 */
export function clearFscpLocalStorage(): void {
  clearFscpLegacyFlatKeys();
  if (typeof localStorage === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PROFILE_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
