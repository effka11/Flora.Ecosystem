import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureWrapKeyPutIfAbsent,
  generateWrapKey,
  normalizeSealedProfileBlob,
  sealProfileRecord,
  unsealProfileRecord,
} from "./sealedVault.js";

test("seal/unseal round-trip with AAD", async () => {
  const wrapKey = await generateWrapKey();
  const owner = "user-aaa";
  const record = {
    agreementPrivateB64: "ag-secret",
    signingPrivateB64: "sg-secret",
    deviceUuidFromServer: "device-1",
  };
  const sealed = await sealProfileRecord(wrapKey, owner, record);
  assert.equal(sealed.v, 1);
  const opened = await unsealProfileRecord(wrapKey, owner, sealed);
  assert.deepEqual(opened, record);
});

test("AAD mismatch fails closed (null)", async () => {
  const wrapKey = await generateWrapKey();
  const sealed = await sealProfileRecord(wrapKey, "owner-a", {
    agreementPrivateB64: "ag",
    signingPrivateB64: "sg",
    deviceUuidFromServer: null,
  });
  const opened = await unsealProfileRecord(wrapKey, "owner-b", sealed);
  assert.equal(opened, null);
});

test("unknown sealed version returns null", async () => {
  const wrapKey = await generateWrapKey();
  const sealed = await sealProfileRecord(wrapKey, "owner", {
    agreementPrivateB64: "ag",
    signingPrivateB64: "sg",
    deviceUuidFromServer: null,
  });
  const opened = await unsealProfileRecord(wrapKey, "owner", { ...sealed, v: 99 });
  assert.equal(opened, null);
});

test("normalizeSealedProfileBlob accepts TypedArray iv/ct", async () => {
  const wrapKey = await generateWrapKey();
  const sealed = await sealProfileRecord(wrapKey, "owner-view", {
    agreementPrivateB64: "ag-view",
    signingPrivateB64: "sg-view",
    deviceUuidFromServer: null,
  });
  const normalized = normalizeSealedProfileBlob({
    v: sealed.v,
    iv: new Uint8Array(sealed.iv),
    ct: new Uint8Array(sealed.ct),
  });
  assert.ok(normalized);
  assert.ok(normalized.iv instanceof ArrayBuffer);
  assert.ok(normalized.ct instanceof ArrayBuffer);
  const opened = await unsealProfileRecord(wrapKey, "owner-view", normalized);
  assert.equal(opened?.agreementPrivateB64, "ag-view");
});

test("ensureWrapKeyPutIfAbsent keeps first stored key", async () => {
  let stored: CryptoKey | null = null;
  const first = await generateWrapKey();
  const second = await generateWrapKey();
  let generateCalls = 0;

  const key = await ensureWrapKeyPutIfAbsent(
    async () => stored,
    async (candidate) => {
      if (stored) return stored;
      stored = candidate;
      return candidate;
    },
    async () => {
      generateCalls += 1;
      return generateCalls === 1 ? first : second;
    },
  );
  assert.equal(key, first);

  const again = await ensureWrapKeyPutIfAbsent(
    async () => stored,
    async (candidate) => {
      if (stored) return stored;
      stored = candidate;
      return candidate;
    },
    async () => second,
  );
  assert.equal(again, first);
  assert.equal(generateCalls, 1);
});

test("concurrent put-if-absent: second writer keeps existing", async () => {
  let stored: CryptoKey | null = null;
  const a = await generateWrapKey();
  const b = await generateWrapKey();

  const writeIfAbsent = async (candidate: CryptoKey) => {
    if (stored) return stored;
    stored = candidate;
    return candidate;
  };

  const [k1, k2] = await Promise.all([
    ensureWrapKeyPutIfAbsent(
      async () => stored,
      writeIfAbsent,
      async () => a,
    ),
    ensureWrapKeyPutIfAbsent(
      async () => stored,
      writeIfAbsent,
      async () => b,
    ),
  ]);

  assert.ok(k1 === a || k1 === b);
  assert.equal(k1, k2);
  assert.equal(stored, k1);
});
