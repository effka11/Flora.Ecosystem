export const STORAGE_VERSION = 1;

export type Migration = {
  version: number;
  up: () => Promise<void>;
};

export type KeyValueStore = {
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type SecureStoreAdapter = KeyValueStore;

export type MmkvStoreAdapter = KeyValueStore;

export async function runMigrations(
  store: KeyValueStore,
  migrations: Migration[],
  versionKey = "flora.storage.version",
): Promise<void> {
  const raw = await store.getString(versionKey);
  let current = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(current)) current = 0;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    await m.up();
    current = m.version;
    await store.setString(versionKey, String(current));
  }
}
