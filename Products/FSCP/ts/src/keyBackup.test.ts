import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { configureSodiumLoader, deriveKeyArgon2id, type SodiumModule } from "./sodium.js";
import {
  assertEpochSetIntegrity,
  bootstrapPlaintextFromLocalMaterial,
  classifyKeyBackup,
  computeEpochSetHash,
  createKeyBackup,
  decryptKeyBackup,
  decryptRecoveryBackup,
  parseKeyBackupPayload,
  type KeyBackupPlaintext,
  type KeyEpochBackupEntry,
  type RecoveryBackupPayloadOut,
} from "./keyBackup.js";
import { FscpBackupError, isFscpBackupError } from "./resilience.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;

/** Light Argon2id for unit tests (not production params). */
const TEST_KDF = { memoryKiB: 8, iterations: 1 } as const;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

async function samplePlaintext(): Promise<KeyBackupPlaintext> {
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  return bootstrapPlaintextFromLocalMaterial(box.privateKey.subarray(0, 32), sign.privateKey);
}

/** Extra epoch so truncating `keyEpochs` yields a different epochSetHash. */
function withExtraEpoch(plaintext: KeyBackupPlaintext): KeyBackupPlaintext {
  const extra: KeyEpochBackupEntry = {
    keyEpochId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    status: "retired",
    rootKeyBase64Url: plaintext.keyEpochs[0]!.rootKeyBase64Url,
    epochAccountIdentityPrivateKeyBase64Url:
      plaintext.keyEpochs[0]!.epochAccountIdentityPrivateKeyBase64Url,
    epochAccountIdentityPublicKeyBase64Url:
      plaintext.keyEpochs[0]!.epochAccountIdentityPublicKeyBase64Url,
    conversationKeyBackups: [],
  };
  return {
    primaryKeyEpochId: plaintext.primaryKeyEpochId,
    keyEpochs: [...plaintext.keyEpochs, extra],
  };
}

function buildKeyBackupAad(params: {
  userUuid: string;
  backupRevision: number;
  backupKeyId: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  kdfSaltBase64Url: string;
}): string {
  return [
    "flora.messaging.key-backup.v1",
    params.userUuid,
    String(params.backupRevision),
    params.backupKeyId,
    params.primaryKeyEpochId,
    String(params.epochSetRevision),
    params.epochSetHashBase64Url,
    params.kdfSaltBase64Url,
  ].join(" | ");
}

function buildRecoveryAad(params: {
  userUuid: string;
  recoveryRevision: number;
  recoveryKeyId: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  kdfSaltBase64Url: string;
}): string {
  return [
    "flora.messaging.recovery-backup.v1",
    params.userUuid,
    String(params.recoveryRevision),
    params.recoveryKeyId,
    params.primaryKeyEpochId,
    String(params.epochSetRevision),
    params.epochSetHashBase64Url,
    params.kdfSaltBase64Url,
  ].join(" | ");
}

/** Low-level password ciphertext with intentional outer/plaintext commitment skew. */
async function encryptPasswordBackupSkewed(params: {
  password: string;
  plaintextJson: string;
  outerPrimaryKeyEpochId: string;
  outerEpochSetHashBase64Url: string;
  backupKeyId?: string;
}): Promise<ReturnType<typeof parseKeyBackupPayload>> {
  const userUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const backupKeyId = params.backupKeyId ?? "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const backupRevision = 1;
  const epochSetRevision = 2;
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES ?? 16);
  const saltBase64Url = b64(salt);
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: new TextEncoder().encode(params.password),
    salt,
    memoryKiB: TEST_KDF.memoryKiB,
    iterations: TEST_KDF.iterations,
    keyLen: 32,
  });
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = buildKeyBackupAad({
    userUuid,
    backupRevision,
    backupKeyId,
    primaryKeyEpochId: params.outerPrimaryKeyEpochId,
    epochSetRevision,
    epochSetHashBase64Url: params.outerEpochSetHashBase64Url,
    kdfSaltBase64Url: saltBase64Url,
  });
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(params.plaintextJson),
    aad,
    null,
    nonce,
    wrapKey,
  );
  return parseKeyBackupPayload({
    version: 1,
    backupRevision,
    backupKeyId,
    userUuid,
    primaryKeyEpochId: params.outerPrimaryKeyEpochId,
    epochSetRevision,
    epochSetHashBase64Url: params.outerEpochSetHashBase64Url,
    kdf: {
      name: "argon2id",
      memoryKiB: TEST_KDF.memoryKiB,
      iterations: TEST_KDF.iterations,
      parallelism: 1,
      saltBase64Url,
    },
    aead: { name: "xchacha20-poly1305", nonceBase64Url: b64(nonce) },
    ciphertextBase64Url: b64(ciphertext),
  });
}

function expectMalformed(e: unknown): void {
  expect(isFscpBackupError(e)).toBe(true);
  expect((e as FscpBackupError).kind).toBe("malformed");
  expect((e as FscpBackupError).kind).not.toBe("aead_auth_failed");
}

describe("keyBackup", () => {
  it("roundtrips backup with string AEAD additional data (RN-compatible)", async () => {
    const plaintext = await samplePlaintext();

    const backup = await createKeyBackup({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      password: "test-password-123",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });

    const parsed = parseKeyBackupPayload(backup);
    const restored = await decryptKeyBackup(parsed, "test-password-123");
    expect(restored.primaryKeyEpochId).toBe(plaintext.primaryKeyEpochId);
    expect(restored.keyEpochs).toHaveLength(1);
  });

  it("rejects wrong password", async () => {
    const plaintext = await samplePlaintext();
    const backup = await createKeyBackup({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      password: "right",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    });
    await expect(decryptKeyBackup(parseKeyBackupPayload(backup), "wrong")).rejects.toThrow(
      /Неверный пароль/,
    );
  });

  it("password decrypt: truncated keyEpochs vs full epochSetHash → malformed (not aead_auth_failed)", async () => {
    const base = await samplePlaintext();
    const full = withExtraEpoch(base);
    const truncated: KeyBackupPlaintext = {
      primaryKeyEpochId: full.primaryKeyEpochId,
      keyEpochs: full.keyEpochs.slice(0, 1),
    };
    const fullHash = computeEpochSetHash(full.keyEpochs);
    expect(computeEpochSetHash(truncated.keyEpochs)).not.toBe(fullHash);

    const password = "commitment-mismatch-password";
    const payload = await encryptPasswordBackupSkewed({
      password,
      plaintextJson: JSON.stringify(truncated),
      outerPrimaryKeyEpochId: full.primaryKeyEpochId,
      outerEpochSetHashBase64Url: fullHash,
    });

    try {
      await decryptKeyBackup(payload, password);
      expect.fail("expected FscpBackupError malformed");
    } catch (e) {
      expectMalformed(e);
    }
  });

  it("password decrypt: primaryKeyEpochId mismatch → malformed", async () => {
    const plaintext = await samplePlaintext();
    const hash = computeEpochSetHash(plaintext.keyEpochs);
    const outerPrimary = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    expect(plaintext.primaryKeyEpochId).not.toBe(outerPrimary);

    const password = "primary-mismatch-password";
    const payload = await encryptPasswordBackupSkewed({
      password,
      plaintextJson: JSON.stringify(plaintext),
      outerPrimaryKeyEpochId: outerPrimary,
      outerEpochSetHashBase64Url: hash,
      backupKeyId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    });

    try {
      await decryptKeyBackup(payload, password);
      expect.fail("expected FscpBackupError malformed");
    } catch (e) {
      expectMalformed(e);
    }
  });

  it("assertEpochSetIntegrity: missing keyEpochs → malformed (not TypeError)", () => {
    const plaintext = {
      primaryKeyEpochId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    } as KeyBackupPlaintext;
    try {
      assertEpochSetIntegrity(plaintext, "any-hash", plaintext.primaryKeyEpochId);
      expect.fail("expected FscpBackupError malformed");
    } catch (e) {
      expectMalformed(e);
    }
  });

  it("classifyKeyBackup: missing keyEpochs after AEAD → malformed (not unreadable)", async () => {
    const plaintext = await samplePlaintext();
    const hash = computeEpochSetHash(plaintext.keyEpochs);
    const password = "missing-epochs-password";
    const skewedBody = {
      primaryKeyEpochId: plaintext.primaryKeyEpochId,
      // Intentional tamper: keyEpochs omitted → must classify as malformed.
    };
    const payload = await encryptPasswordBackupSkewed({
      password,
      plaintextJson: JSON.stringify(skewedBody),
      outerPrimaryKeyEpochId: plaintext.primaryKeyEpochId,
      outerEpochSetHashBase64Url: hash,
      backupKeyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01",
    });

    const cls = await classifyKeyBackup(payload, password);
    expect(cls.state).toBe("malformed");
  });

  it("recovery decrypt: truncated keyEpochs vs full epochSetHash → malformed (not aead_auth_failed)", async () => {
    const base = await samplePlaintext();
    const full = withExtraEpoch(base);
    const truncated: KeyBackupPlaintext = {
      primaryKeyEpochId: full.primaryKeyEpochId,
      keyEpochs: full.keyEpochs.slice(0, 1),
    };
    const fullHash = computeEpochSetHash(full.keyEpochs);
    expect(computeEpochSetHash(truncated.keyEpochs)).not.toBe(fullHash);

    const userUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const recoveryKeyId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const recoveryRevision = 1;
    const epochSetRevision = 2;
    const recoveryPhrase = "commitment mismatch recovery phrase";

    const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES ?? 16);
    const saltBase64Url = b64(salt);
    const wrapKey = await deriveKeyArgon2id({
      passwordBytes: new TextEncoder().encode(recoveryPhrase.trim()),
      salt,
      memoryKiB: TEST_KDF.memoryKiB,
      iterations: TEST_KDF.iterations,
      keyLen: 32,
    });
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const aad = buildRecoveryAad({
      userUuid,
      recoveryRevision,
      recoveryKeyId,
      primaryKeyEpochId: full.primaryKeyEpochId,
      epochSetRevision,
      epochSetHashBase64Url: fullHash,
      kdfSaltBase64Url: saltBase64Url,
    });
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(JSON.stringify(truncated)),
      aad,
      null,
      nonce,
      wrapKey,
    );

    const payload: RecoveryBackupPayloadOut = {
      version: 1,
      recoveryRevision,
      recoveryKeyId,
      userUuid,
      primaryKeyEpochId: full.primaryKeyEpochId,
      epochSetRevision,
      epochSetHashBase64Url: fullHash,
      wordlist: { id: "test", wordsCount: 24 },
      kdf: {
        name: "argon2id",
        memoryKiB: TEST_KDF.memoryKiB,
        iterations: TEST_KDF.iterations,
        parallelism: 1,
        saltBase64Url,
      },
      aead: { name: "xchacha20-poly1305", nonceBase64Url: b64(nonce) },
      ciphertextBase64Url: b64(ciphertext),
    };

    try {
      await decryptRecoveryBackup(payload, recoveryPhrase);
      expect.fail("expected FscpBackupError malformed");
    } catch (e) {
      expectMalformed(e);
    }
  });
});
