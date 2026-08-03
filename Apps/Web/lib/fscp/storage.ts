import type { FscpKeyStorageAdapter, FscpProfileRecord } from "@flora/client-core/fscp";
import {
  getDefaultFscpSealedVault,
  loadUnsealedProfile,
  sealAndStoreProfile,
  type FscpSealedVault,
} from "./sealedVault";

const PREFIX = "flora.fscp.profile.v1.";

/** Устаревшие общие ключи (до профилей по пользователю). */
const LS_AG = "flora.fscp.agreementPrivateB64";
const LS_SG = "flora.fscp.signingPrivateB64";
const LS_DEV = "flora.fscp.deviceUuidFromServer";
const LS_OWNER = "flora.fscp.ownerUserUuid";

function lsKey(ownerNorm: string): string {
  return `${PREFIX}${ownerNorm}`;
}

function clearLegacyFlatKeys(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LS_AG);
  localStorage.removeItem(LS_SG);
  localStorage.removeItem(LS_DEV);
  localStorage.removeItem(LS_OWNER);
}

function wipeLocalStorageProfile(ownerNorm: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(lsKey(ownerNorm));
}

function wipeAllLocalStorageProfiles(): void {
  if (typeof localStorage === "undefined") return;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) toRemove.push(k);
  }
  for (const k of toRemove) localStorage.removeItem(k);
  clearLegacyFlatKeys();
}

function parseLsProfileJson(raw: string): FscpProfileRecord | null {
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

function readLsProfile(ownerNorm: string): FscpProfileRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(lsKey(ownerNorm));
  if (!raw) return null;
  return parseLsProfileJson(raw);
}

/** Legacy flat keys → in-memory profile (does not write plaintext profile JSON). */
function readLegacyFlatProfile(currentOwnerNorm: string): FscpProfileRecord | null {
  if (typeof localStorage === "undefined") return null;
  const agB64 = localStorage.getItem(LS_AG);
  const sgB64 = localStorage.getItem(LS_SG);
  const dev = localStorage.getItem(LS_DEV);
  const storedOwner = localStorage.getItem(LS_OWNER);
  if (!agB64 || !sgB64) return null;

  const devNorm = dev && dev.trim().length > 0 ? dev.trim() : null;

  if (storedOwner != null) {
    const tag = storedOwner.trim().toLowerCase();
    if (tag !== currentOwnerNorm) {
      // Wrong owner for this resolve; leave flat keys for the matching owner migrate.
      return null;
    }
    return {
      agreementPrivateB64: agB64,
      signingPrivateB64: sgB64,
      deviceUuidFromServer: devNorm,
    };
  }

  // Orphan flat keys without owner tag — discard (same as pre-SEC-1 behavior).
  clearLegacyFlatKeys();
  return null;
}

function readPlaintextMigrationSource(ownerNorm: string): {
  record: FscpProfileRecord;
  fromLegacyFlat: boolean;
} | null {
  const fromLs = readLsProfile(ownerNorm);
  if (fromLs) return { record: fromLs, fromLegacyFlat: false };
  const fromLegacy = readLegacyFlatProfile(ownerNorm);
  if (fromLegacy) return { record: fromLegacy, fromLegacyFlat: true };
  return null;
}

async function migratePlaintextToVault(
  vault: FscpSealedVault,
  ownerNorm: string,
  source: { record: FscpProfileRecord; fromLegacyFlat: boolean },
): Promise<FscpProfileRecord> {
  try {
    await sealAndStoreProfile(vault, ownerNorm, source.record);
  } catch {
    // Keep plaintext LS for retry; still return the profile for this read.
    return source.record;
  }
  wipeLocalStorageProfile(ownerNorm);
  if (source.fromLegacyFlat) clearLegacyFlatKeys();
  return source.record;
}

export function createWebFscpKeyStorage(vault: FscpSealedVault = getDefaultFscpSealedVault()): FscpKeyStorageAdapter {
  return {
    async getProfile(ownerNorm) {
      try {
        const sealed = await loadUnsealedProfile(vault, ownerNorm);
        if (sealed) {
          wipeLocalStorageProfile(ownerNorm);
          return sealed;
        }
      } catch {
        // Vault unavailable — fall through to plaintext migrate/read (no new LS writes).
      }

      const source = readPlaintextMigrationSource(ownerNorm);
      if (!source) return null;

      try {
        return await migratePlaintextToVault(vault, ownerNorm, source);
      } catch {
        return source.record;
      }
    },

    async setProfile(ownerNorm, record) {
      await sealAndStoreProfile(vault, ownerNorm, record);
      wipeLocalStorageProfile(ownerNorm);
      // Only drop legacy flat keys if they belong to this owner (or have no owner tag).
      if (typeof localStorage !== "undefined") {
        const storedOwner = localStorage.getItem(LS_OWNER);
        if (storedOwner == null || storedOwner.trim().toLowerCase() === ownerNorm) {
          clearLegacyFlatKeys();
        }
      }
    },

    async clearProfile(ownerNorm) {
      wipeLocalStorageProfile(ownerNorm);
      try {
        await vault.deleteSealed(ownerNorm);
      } catch {
        /* vault may be unavailable; LS already wiped */
      }
    },

    async clearAllProfiles() {
      wipeAllLocalStorageProfiles();
      try {
        await vault.clearAllSealed();
      } catch {
        /* best-effort */
      }
    },
  };
}

export const webFscpKeyStorage: FscpKeyStorageAdapter = createWebFscpKeyStorage();
