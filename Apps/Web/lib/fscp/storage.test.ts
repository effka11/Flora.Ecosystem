import assert from "node:assert/strict";
import test from "node:test";
import type { FscpProfileRecord } from "@flora/client-core/fscp";
import {
  generateWrapKey,
  sealProfileRecord,
  unsealProfileRecord,
  type FscpSealedVault,
  type SealedProfileBlob,
} from "./sealedVault.js";
import { createWebFscpKeyStorage } from "./storage.js";

class MemoryLocalStorage {
  readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

function installLocalStorage(storage: MemoryLocalStorage): () => void {
  const g = globalThis as typeof globalThis & { localStorage: Storage };
  const prev = g.localStorage;
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    writable: true,
    value: storage as unknown as Storage,
  });
  return () => {
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      writable: true,
      value: prev,
    });
  };
}

async function createMemoryVault(): Promise<FscpSealedVault> {
  let wrapKey: CryptoKey | null = null;
  const profiles = new Map<string, SealedProfileBlob>();
  return {
    async ensureWrapKey() {
      if (!wrapKey) wrapKey = await generateWrapKey();
      return wrapKey;
    },
    async getSealed(ownerNorm) {
      return profiles.get(ownerNorm) ?? null;
    },
    async putSealed(ownerNorm, blob) {
      profiles.set(ownerNorm, blob);
    },
    async deleteSealed(ownerNorm) {
      profiles.delete(ownerNorm);
    },
    async clearAllSealed() {
      profiles.clear();
    },
  };
}

const sample: FscpProfileRecord = {
  agreementPrivateB64: "agreement-b64",
  signingPrivateB64: "signing-b64",
  deviceUuidFromServer: "dev-uuid",
};

test("set/get round-trip through sealed vault (no plaintext LS)", async () => {
  const ls = new MemoryLocalStorage();
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    const storage = createWebFscpKeyStorage(vault);
    await storage.setProfile("owner-1", sample);
    assert.equal(ls.getItem("flora.fscp.profile.v1.owner-1"), null);
    const got = await storage.getProfile("owner-1");
    assert.deepEqual(got, sample);
  } finally {
    restore();
  }
});

test("migrates plaintext LS profile into vault and wipes LS", async () => {
  const ls = new MemoryLocalStorage();
  ls.setItem(
    "flora.fscp.profile.v1.owner-2",
    JSON.stringify({
      agreementPrivateB64: "ag-ls",
      signingPrivateB64: "sg-ls",
      deviceUuidFromServer: null,
    }),
  );
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    const storage = createWebFscpKeyStorage(vault);
    const got = await storage.getProfile("owner-2");
    assert.deepEqual(got, {
      agreementPrivateB64: "ag-ls",
      signingPrivateB64: "sg-ls",
      deviceUuidFromServer: null,
    });
    assert.equal(ls.getItem("flora.fscp.profile.v1.owner-2"), null);
    const again = await storage.getProfile("owner-2");
    assert.deepEqual(again, got);
  } finally {
    restore();
  }
});

test("migrates legacy flat keys into vault", async () => {
  const ls = new MemoryLocalStorage();
  ls.setItem("flora.fscp.agreementPrivateB64", "ag-flat");
  ls.setItem("flora.fscp.signingPrivateB64", "sg-flat");
  ls.setItem("flora.fscp.deviceUuidFromServer", "flat-dev");
  ls.setItem("flora.fscp.ownerUserUuid", "Owner-3");
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    const storage = createWebFscpKeyStorage(vault);
    const got = await storage.getProfile("owner-3");
    assert.deepEqual(got, {
      agreementPrivateB64: "ag-flat",
      signingPrivateB64: "sg-flat",
      deviceUuidFromServer: "flat-dev",
    });
    assert.equal(ls.getItem("flora.fscp.agreementPrivateB64"), null);
    assert.equal(ls.getItem("flora.fscp.signingPrivateB64"), null);
  } finally {
    restore();
  }
});

test("clearProfile removes sealed entry", async () => {
  const ls = new MemoryLocalStorage();
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    const storage = createWebFscpKeyStorage(vault);
    await storage.setProfile("owner-4", sample);
    await storage.clearProfile("owner-4");
    assert.equal(await storage.getProfile("owner-4"), null);
  } finally {
    restore();
  }
});

test("setProfile does not wipe another owner's legacy flat keys", async () => {
  const ls = new MemoryLocalStorage();
  ls.setItem("flora.fscp.agreementPrivateB64", "ag-other");
  ls.setItem("flora.fscp.signingPrivateB64", "sg-other");
  ls.setItem("flora.fscp.ownerUserUuid", "other-user");
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    const storage = createWebFscpKeyStorage(vault);
    await storage.setProfile("owner-self", sample);
    assert.equal(ls.getItem("flora.fscp.agreementPrivateB64"), "ag-other");
    assert.equal(ls.getItem("flora.fscp.ownerUserUuid"), "other-user");
  } finally {
    restore();
  }
});

test("setProfile throws when vault write fails (no LS fallback)", async () => {
  const ls = new MemoryLocalStorage();
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    vault.putSealed = async () => {
      throw new Error("quota");
    };
    const storage = createWebFscpKeyStorage(vault);
    await assert.rejects(() => storage.setProfile("owner-5", sample), /quota/);
    assert.equal(ls.getItem("flora.fscp.profile.v1.owner-5"), null);
  } finally {
    restore();
  }
});

test("migrate seal failure leaves LS intact", async () => {
  const ls = new MemoryLocalStorage();
  ls.setItem(
    "flora.fscp.profile.v1.owner-6",
    JSON.stringify({
      agreementPrivateB64: "ag-keep",
      signingPrivateB64: "sg-keep",
      deviceUuidFromServer: null,
    }),
  );
  const restore = installLocalStorage(ls);
  try {
    const vault = await createMemoryVault();
    vault.putSealed = async () => {
      throw new Error("idb down");
    };
    const storage = createWebFscpKeyStorage(vault);
    const got = await storage.getProfile("owner-6");
    assert.equal(got?.agreementPrivateB64, "ag-keep");
    assert.ok(ls.getItem("flora.fscp.profile.v1.owner-6"));
  } finally {
    restore();
  }
});

test("corrupt sealed blob treated as miss", async () => {
  const wrapKey = await generateWrapKey();
  const good = await sealProfileRecord(wrapKey, "owner-7", sample);
  const opened = await unsealProfileRecord(wrapKey, "owner-7", {
    ...good,
    ct: new Uint8Array([1, 2, 3]).buffer,
  });
  assert.equal(opened, null);
});
