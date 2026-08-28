import type { FscpKeyStorageAdapter, FscpProfileRecord } from "@flora/client-core/fscp";
import {
  getDefaultGovFscpSealedVault,
  loadUnsealedProfile,
  sealAndStoreProfile,
  type FscpSealedVault,
} from "./sealedVault";

/** Civic-origin profile keys. Must not share Social `flora.fscp.profile.v1.`. */
export const GOV_FSCP_PROFILE_PREFIX = "flora.gov.fscp.profile.v1.";

function lsKey(ownerNorm: string): string {
  return `${GOV_FSCP_PROFILE_PREFIX}${ownerNorm}`;
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
    if (k?.startsWith(GOV_FSCP_PROFILE_PREFIX)) toRemove.push(k);
  }
  for (const k of toRemove) localStorage.removeItem(k);
}

function parseLsProfileJson(raw: string): FscpProfileRecord | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const agreementPrivateB64 =
      typeof o.agreementPrivateB64 === "string" ? o.agreementPrivateB64 : "";
    const signingPrivateB64 = typeof o.signingPrivateB64 === "string" ? o.signingPrivateB64 : "";
    if (!agreementPrivateB64 || !signingPrivateB64) return null;
    const devRaw = o.deviceUuidFromServer;
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

export function createGovFscpKeyStorage(
  vault: FscpSealedVault = getDefaultGovFscpSealedVault(),
): FscpKeyStorageAdapter {
  return {
    async getProfile(ownerNorm) {
      try {
        const sealed = await loadUnsealedProfile(vault, ownerNorm);
        if (sealed) {
          wipeLocalStorageProfile(ownerNorm);
          return sealed;
        }
      } catch {
        // Vault unavailable — fall through to civic-prefix LS only.
      }

      return readLsProfile(ownerNorm);
    },

    async setProfile(ownerNorm, record) {
      await sealAndStoreProfile(vault, ownerNorm, record);
      wipeLocalStorageProfile(ownerNorm);
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

export const govFscpKeyStorage: FscpKeyStorageAdapter = createGovFscpKeyStorage();
