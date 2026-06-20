import * as SecureStore from "expo-secure-store";
import type { FscpKeyStorageAdapter, FscpProfileRecord } from "@flora/client-core/fscp";

const PREFIX = "flora.fscp.profile.v1.";

function key(ownerNorm: string): string {
  return `${PREFIX}${ownerNorm}`;
}

export const mobileFscpKeyStorage: FscpKeyStorageAdapter = {
  async getProfile(ownerNorm) {
    const raw = await SecureStore.getItemAsync(key(ownerNorm));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FscpProfileRecord;
    } catch {
      return null;
    }
  },
  async setProfile(ownerNorm, record) {
    await SecureStore.setItemAsync(key(ownerNorm), JSON.stringify(record));
  },
  async clearProfile(ownerNorm) {
    await SecureStore.deleteItemAsync(key(ownerNorm));
  },
  async clearAllProfiles() {
    /* SecureStore has no enumeration; callers clear known owners explicitly */
  },
};
