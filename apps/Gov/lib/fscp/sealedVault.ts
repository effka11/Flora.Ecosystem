/**
 * At-rest vault for Gov FSCP identity (isolated from Social `flora-fscp-vault`).
 */

import type { FscpProfileRecord } from "@flora/client-core/fscp";

export const GOV_FSCP_VAULT_DB = "flora-gov-fscp-vault";
export const FSCP_VAULT_DB_VERSION = 1;
export const FSCP_VAULT_STORE_META = "meta";
export const FSCP_VAULT_STORE_PROFILES = "profiles";
export const FSCP_VAULT_WRAP_KEY_ID = "wrapKey";
export const FSCP_SEALED_PROFILE_VERSION = 1;

export type SealedProfileBlob = {
  v: number;
  iv: ArrayBuffer;
  ct: ArrayBuffer;
};

export type FscpSealedVault = {
  ensureWrapKey(): Promise<CryptoKey>;
  getSealed(ownerNorm: string): Promise<SealedProfileBlob | null>;
  putSealed(ownerNorm: string, blob: SealedProfileBlob): Promise<void>;
  deleteSealed(ownerNorm: string): Promise<void>;
  clearAllSealed(): Promise<void>;
};

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("FSCP vault: WebCrypto SubtleCrypto unavailable (insecure context?).");
  }
  return subtle;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return null;
}

export function normalizeSealedProfileBlob(raw: unknown): SealedProfileBlob | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== "number") return null;
  const iv = asArrayBuffer(o.iv);
  const ct = asArrayBuffer(o.ct);
  if (!iv || !ct) return null;
  return { v: o.v, iv, ct };
}

function aadForOwner(ownerNorm: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(ownerNorm));
}

export async function generateWrapKey(subtle: SubtleCrypto = requireSubtle()): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealProfileRecord(
  wrapKey: CryptoKey,
  ownerNorm: string,
  record: FscpProfileRecord,
  subtle: SubtleCrypto = requireSubtle(),
): Promise<SealedProfileBlob> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ivBuf = toArrayBuffer(iv);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      agreementPrivateB64: record.agreementPrivateB64,
      signingPrivateB64: record.signingPrivateB64,
      deviceUuidFromServer: record.deviceUuidFromServer,
    }),
  );
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: ivBuf, additionalData: aadForOwner(ownerNorm) },
    wrapKey,
    toArrayBuffer(plaintext),
  );
  return {
    v: FSCP_SEALED_PROFILE_VERSION,
    iv: ivBuf,
    ct,
  };
}

export async function unsealProfileRecord(
  wrapKey: CryptoKey,
  ownerNorm: string,
  blob: SealedProfileBlob,
  subtle: SubtleCrypto = requireSubtle(),
): Promise<FscpProfileRecord | null> {
  if (blob.v !== FSCP_SEALED_PROFILE_VERSION) return null;
  const iv = asArrayBuffer(blob.iv);
  const ct = asArrayBuffer(blob.ct);
  if (!iv || !ct) return null;
  try {
    const plainBuf = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aadForOwner(ownerNorm),
      },
      wrapKey,
      ct,
    );
    const o = JSON.parse(new TextDecoder().decode(plainBuf)) as Record<string, unknown>;
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

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("FSCP vault: IndexedDB unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GOV_FSCP_VAULT_DB, FSCP_VAULT_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("FSCP vault: IndexedDB open failed."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FSCP_VAULT_STORE_META)) {
        db.createObjectStore(FSCP_VAULT_STORE_META);
      }
      if (!db.objectStoreNames.contains(FSCP_VAULT_STORE_PROFILES)) {
        db.createObjectStore(FSCP_VAULT_STORE_PROFILES);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("FSCP vault: IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("FSCP vault: IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("FSCP vault: IndexedDB transaction aborted."));
  });
}

export async function ensureWrapKeyPutIfAbsent(
  read: () => Promise<CryptoKey | null>,
  writeIfAbsent: (key: CryptoKey) => Promise<CryptoKey>,
  generate: () => Promise<CryptoKey> = () => generateWrapKey(),
): Promise<CryptoKey> {
  const existing = await read();
  if (existing) return existing;
  const created = await generate();
  return writeIfAbsent(created);
}

export function createIndexedDbFscpSealedVault(): FscpSealedVault {
  return {
    async ensureWrapKey() {
      return ensureWrapKeyPutIfAbsent(
        async () =>
          withDb(async (db) => {
            const tx = db.transaction(FSCP_VAULT_STORE_META, "readonly");
            const key = await idbReq(
              tx.objectStore(FSCP_VAULT_STORE_META).get(FSCP_VAULT_WRAP_KEY_ID),
            );
            await idbTxDone(tx);
            return key instanceof CryptoKey ? key : null;
          }),
        async (candidate) =>
          withDb(async (db) => {
            const tx = db.transaction(FSCP_VAULT_STORE_META, "readwrite");
            const store = tx.objectStore(FSCP_VAULT_STORE_META);
            const existing = await idbReq(store.get(FSCP_VAULT_WRAP_KEY_ID));
            if (existing instanceof CryptoKey) {
              await idbTxDone(tx);
              return existing;
            }
            store.put(candidate, FSCP_VAULT_WRAP_KEY_ID);
            await idbTxDone(tx);
            return candidate;
          }),
      );
    },

    async getSealed(ownerNorm) {
      return withDb(async (db) => {
        const tx = db.transaction(FSCP_VAULT_STORE_PROFILES, "readonly");
        const raw = await idbReq(tx.objectStore(FSCP_VAULT_STORE_PROFILES).get(ownerNorm));
        await idbTxDone(tx);
        return normalizeSealedProfileBlob(raw);
      });
    },

    async putSealed(ownerNorm, blob) {
      await withDb(async (db) => {
        const tx = db.transaction(FSCP_VAULT_STORE_PROFILES, "readwrite");
        tx.objectStore(FSCP_VAULT_STORE_PROFILES).put(blob, ownerNorm);
        await idbTxDone(tx);
      });
    },

    async deleteSealed(ownerNorm) {
      await withDb(async (db) => {
        const tx = db.transaction(FSCP_VAULT_STORE_PROFILES, "readwrite");
        tx.objectStore(FSCP_VAULT_STORE_PROFILES).delete(ownerNorm);
        await idbTxDone(tx);
      });
    },

    async clearAllSealed() {
      await withDb(async (db) => {
        const tx = db.transaction(FSCP_VAULT_STORE_PROFILES, "readwrite");
        tx.objectStore(FSCP_VAULT_STORE_PROFILES).clear();
        await idbTxDone(tx);
      });
    },
  };
}

let defaultVault: FscpSealedVault | null = null;

export function getDefaultGovFscpSealedVault(): FscpSealedVault {
  if (!defaultVault) defaultVault = createIndexedDbFscpSealedVault();
  return defaultVault;
}

export function setDefaultGovFscpSealedVaultForTests(vault: FscpSealedVault | null): void {
  defaultVault = vault;
}

export async function sealAndStoreProfile(
  vault: FscpSealedVault,
  ownerNorm: string,
  record: FscpProfileRecord,
): Promise<void> {
  const wrapKey = await vault.ensureWrapKey();
  const blob = await sealProfileRecord(wrapKey, ownerNorm, record);
  await vault.putSealed(ownerNorm, blob);
}

export async function loadUnsealedProfile(
  vault: FscpSealedVault,
  ownerNorm: string,
): Promise<FscpProfileRecord | null> {
  const blob = await vault.getSealed(ownerNorm);
  if (!blob) return null;
  const wrapKey = await vault.ensureWrapKey();
  const record = await unsealProfileRecord(wrapKey, ownerNorm, blob);
  if (!record) {
    try {
      await vault.deleteSealed(ownerNorm);
    } catch {
      /* best-effort corrupt cleanup */
    }
  }
  return record;
}
