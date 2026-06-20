import type { FscpKeyStorageAdapter, FscpProfileRecord } from "@flora/client-core/fscp";

const PREFIX = "flora.fscp.profile.v1.";

/** Устаревшие общие ключи (до профилей по пользователю). */
const LS_AG = "flora.fscp.agreementPrivateB64";
const LS_SG = "flora.fscp.signingPrivateB64";
const LS_DEV = "flora.fscp.deviceUuidFromServer";
const LS_OWNER = "flora.fscp.ownerUserUuid";

function key(ownerNorm: string): string {
  return `${PREFIX}${ownerNorm}`;
}

function clearLegacyFlatKeys(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LS_AG);
  localStorage.removeItem(LS_SG);
  localStorage.removeItem(LS_DEV);
  localStorage.removeItem(LS_OWNER);
}

function readProfile(ownerNorm: string): FscpProfileRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(key(ownerNorm));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const agreementPrivateB64 =
      typeof o.agreementPrivateB64 === "string"
        ? o.agreementPrivateB64
        : typeof o.ag === "string"
          ? o.ag
          : "";
    const signingPrivateB64 =
      typeof o.signingPrivateB64 === "string"
        ? o.signingPrivateB64
        : typeof o.sg === "string"
          ? o.sg
          : "";
    if (!agreementPrivateB64 || !signingPrivateB64) return null;
    const devRaw = o.deviceUuidFromServer ?? o.dev;
    const deviceUuidFromServer =
      typeof devRaw === "string" && devRaw.trim().length > 0 ? devRaw.trim() : null;
    return { agreementPrivateB64, signingPrivateB64, deviceUuidFromServer };
  } catch {
    return null;
  }
}

function writeProfile(ownerNorm: string, record: FscpProfileRecord): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    key(ownerNorm),
    JSON.stringify({
      agreementPrivateB64: record.agreementPrivateB64,
      signingPrivateB64: record.signingPrivateB64,
      deviceUuidFromServer: record.deviceUuidFromServer,
    }),
  );
}

/** Переносит legacy flat keys в профиль v1 (по одному на пользователя). */
function migrateLegacyFlatKeysIntoProfiles(currentOwnerNorm: string): FscpProfileRecord | null {
  if (typeof localStorage === "undefined") return null;
  const agB64 = localStorage.getItem(LS_AG);
  const sgB64 = localStorage.getItem(LS_SG);
  const dev = localStorage.getItem(LS_DEV);
  const storedOwner = localStorage.getItem(LS_OWNER);
  if (!agB64 || !sgB64) return null;

  const devNorm = dev && dev.trim().length > 0 ? dev.trim() : null;

  if (storedOwner != null) {
    const tag = storedOwner.trim().toLowerCase();
    const rec: FscpProfileRecord = {
      agreementPrivateB64: agB64,
      signingPrivateB64: sgB64,
      deviceUuidFromServer: devNorm,
    };
    writeProfile(tag, rec);
    clearLegacyFlatKeys();
    return tag === currentOwnerNorm ? rec : null;
  }

  clearLegacyFlatKeys();
  return null;
}

function readOrMigrateProfile(ownerNorm: string): FscpProfileRecord | null {
  return readProfile(ownerNorm) ?? migrateLegacyFlatKeysIntoProfiles(ownerNorm);
}

export const webFscpKeyStorage: FscpKeyStorageAdapter = {
  async getProfile(ownerNorm) {
    return readOrMigrateProfile(ownerNorm);
  },
  async setProfile(ownerNorm, record) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      key(ownerNorm),
      JSON.stringify({
        agreementPrivateB64: record.agreementPrivateB64,
        signingPrivateB64: record.signingPrivateB64,
        deviceUuidFromServer: record.deviceUuidFromServer,
      }),
    );
  },
  async clearProfile(ownerNorm) {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key(ownerNorm));
  },
  async clearAllProfiles() {
    if (typeof localStorage === "undefined") return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  },
};
