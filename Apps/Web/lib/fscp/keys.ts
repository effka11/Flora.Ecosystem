import { webFscpKeyStorage } from "./storage";

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

/** Удаляет только устаревшие общие ключи (миграция). */
export function clearFscpLegacyFlatKeys(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LS_AG);
  localStorage.removeItem(LS_SG);
  localStorage.removeItem(LS_DEV);
  localStorage.removeItem(LS_OWNER);
}

/** Явный сброс FSCP-профиля пользователя на этом устройстве (не вызывается при обычном `clearSession`). */
export async function clearFscpMaterialForUser(ownerUserUuid: string): Promise<void> {
  const k = ownerUserUuid.trim().toLowerCase();
  if (!k) return;
  await webFscpKeyStorage.clearProfile(k);
}

/**
 * Полный сброс FSCP device material в origin (sealed vault + residual LS + legacy).
 * При обычном выходе ключи не трогаются — см. `clearSession` в `lib/auth.ts`.
 */
export async function clearFscpDeviceMaterial(): Promise<void> {
  clearFscpLegacyFlatKeys();
  await webFscpKeyStorage.clearAllProfiles();
}

/** @deprecated Use {@link clearFscpDeviceMaterial}. */
export async function clearFscpLocalStorage(): Promise<void> {
  await clearFscpDeviceMaterial();
}
