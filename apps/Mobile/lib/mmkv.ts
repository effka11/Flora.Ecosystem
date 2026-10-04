import { MMKV } from "react-native-mmkv";
import { runMigrations, type KeyValueStore } from "@flora/client-core/storage";

export const mmkv = new MMKV({ id: "flora-mobile" });

export const mmkvStore: KeyValueStore = {
  async getString(key) {
    return mmkv.getString(key) ?? null;
  },
  async setString(key, value) {
    mmkv.set(key, value);
  },
  async delete(key) {
    mmkv.delete(key);
  },
};

export async function initStorageMigrations(): Promise<void> {
  await runMigrations(mmkvStore, []);
}
