import { sha256 } from "@noble/hashes/sha2.js";
import { asRecord, readNum, readStr } from "../contracts/parse.js";
import { deriveKeyArgon2id, getSodium, scalarmultBase } from "./sodium.js";
import { FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "./constants.js";
import { fromBase64Url } from "./base64url.js";

export type KeyEpochBackupEntry = {
  keyEpochId: string;
  status: "active" | "locked" | "recovered" | "retired";
  rootKeyBase64Url: string;
  epochAccountIdentityPrivateKeyBase64Url: string;
  epochAccountIdentityPublicKeyBase64Url: string;
  conversationKeyBackups: ConversationKeyBackup[];
};

export type ConversationKeyBackup = {
  conversationUuid: string;
  conversationKeyBase64Url: string;
  ratchetStateBase64Url: string;
};

export type KeyBackupPlaintext = {
  primaryKeyEpochId: string;
  keyEpochs: KeyEpochBackupEntry[];
};

export type KdfParamsOut = {
  name: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltBase64Url: string;
};

export type KeyBackupPayloadOut = {
  version: 1;
  backupRevision: number;
  backupKeyId: string;
  userUuid: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  kdf: KdfParamsOut;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  ciphertextBase64Url: string;
};

/**
 * Readability of a server key-backup — single source of truth for UI and self-heal.
 * - healthy:    decrypts cleanly with the provided password.
 * - missing:    no backup on the server (HTTP 404; assigned by the caller doing the GET).
 * - unreadable: AEAD authentication failed — wrong password OR corrupted ciphertext.
 *               These two are cryptographically indistinguishable (Poly1305 tag mismatch).
 * - malformed:  structural/parse/version problem; must NEVER be silently overwritten.
 */
export type FscpBackupState = "healthy" | "missing" | "unreadable" | "malformed";

export type KeyBackupClassification =
  | { state: "healthy"; payload: KeyBackupPayloadOut; plaintext: KeyBackupPlaintext }
  | { state: "malformed"; reason: string }
  | { state: "unreadable" };

export type RecoveryBackupPayloadOut = {
  version: 1;
  recoveryRevision: number;
  recoveryKeyId: string;
  userUuid: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  wordlist: { id: string; wordsCount: number };
  kdf: KdfParamsOut;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  ciphertextBase64Url: string;
};

function readUuidField(obj: Record<string, unknown>, keys: string[]): string {
  const s = readStr(obj, keys);
  return s.trim();
}

/** Нормализует ответ GET key-backup (camelCase / PascalCase, Guid → string). */
export function parseKeyBackupPayload(raw: unknown): KeyBackupPayloadOut {
  const o = asRecord(raw);
  if (!o) throw new Error("Некорректный payload key-backup.");

  const kdf = asRecord(o.kdf ?? o.Kdf);
  const aead = asRecord(o.aead ?? o.Aead);
  if (!kdf || !aead) throw new Error("Некорректный payload key-backup: отсутствуют kdf/aead.");

  const userUuid = readUuidField(o, ["userUuid", "UserUuid"]);
  const backupKeyId = readUuidField(o, ["backupKeyId", "BackupKeyId"]);
  const primaryKeyEpochId = readUuidField(o, ["primaryKeyEpochId", "PrimaryKeyEpochId"]);
  const saltBase64Url = readStr(kdf, ["saltBase64Url", "SaltBase64Url"]);
  const nonceBase64Url = readStr(aead, ["nonceBase64Url", "NonceBase64Url"]);
  const ciphertextBase64Url = readStr(o, ["ciphertextBase64Url", "CiphertextBase64Url"]);
  const epochSetHashBase64Url = readStr(o, ["epochSetHashBase64Url", "EpochSetHashBase64Url"]);

  const version = readNum(o, ["version", "Version"]) ?? 0;
  const backupRevision = readNum(o, ["backupRevision", "BackupRevision"]) ?? 0;
  const epochSetRevision = readNum(o, ["epochSetRevision", "EpochSetRevision"]) ?? 0;
  const memoryKiB = readNum(kdf, ["memoryKiB", "MemoryKiB"]) ?? 0;
  const iterations = readNum(kdf, ["iterations", "Iterations"]) ?? 0;
  const parallelism = readNum(kdf, ["parallelism", "Parallelism"]) ?? 1;

  if (
    !userUuid ||
    !backupKeyId ||
    !primaryKeyEpochId ||
    !saltBase64Url ||
    !nonceBase64Url ||
    !ciphertextBase64Url ||
    !epochSetHashBase64Url
  ) {
    throw new Error("Некорректный payload key-backup: неполные поля.");
  }

  return {
    version: version === 1 ? 1 : 1,
    backupRevision,
    backupKeyId,
    userUuid,
    primaryKeyEpochId,
    epochSetRevision,
    epochSetHashBase64Url,
    kdf: {
      name: "argon2id",
      memoryKiB,
      iterations,
      parallelism,
      saltBase64Url,
    },
    aead: { name: "xchacha20-poly1305", nonceBase64Url },
    ciphertextBase64Url,
  };
}

export function computeEpochSetHash(epochs: KeyEpochBackupEntry[]): string {
  const canonical = JSON.stringify(
    epochs.map((e) => ({
      keyEpochId: e.keyEpochId,
      status: e.status,
      epochAccountIdentityPublicKeyBase64Url: e.epochAccountIdentityPublicKeyBase64Url,
    })),
  );
  const hash = sha256(new TextEncoder().encode(canonical));
  let s = "";
  for (let i = 0; i < hash.length; i++) s += String.fromCharCode(hash[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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

export async function createKeyBackup(params: {
  userUuid: string;
  password: string;
  plaintext: KeyBackupPlaintext;
  backupRevision: number;
  epochSetRevision: number;
  backupKeyId: string;
  kdf?: { memoryKiB?: number; iterations?: number };
}): Promise<KeyBackupPayloadOut> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
  const memoryKiB = params.kdf?.memoryKiB ?? 65536;
  const iterations = params.kdf?.iterations ?? 3;
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES ?? 16);
  const saltBase64Url = b64(salt);
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: new TextEncoder().encode(params.password),
    salt,
    memoryKiB,
    iterations,
    keyLen: 32,
  });
  const epochSetHashBase64Url = computeEpochSetHash(params.plaintext.keyEpochs);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = buildKeyBackupAad({
    userUuid: params.userUuid,
    backupRevision: params.backupRevision,
    backupKeyId: params.backupKeyId,
    primaryKeyEpochId: params.plaintext.primaryKeyEpochId,
    epochSetRevision: params.epochSetRevision,
    epochSetHashBase64Url,
    kdfSaltBase64Url: saltBase64Url,
  });
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(params.plaintext)),
    aad,
    null,
    nonce,
    wrapKey,
  );
  return {
    version: 1,
    backupRevision: params.backupRevision,
    backupKeyId: params.backupKeyId,
    userUuid: params.userUuid,
    primaryKeyEpochId: params.plaintext.primaryKeyEpochId,
    epochSetRevision: params.epochSetRevision,
    epochSetHashBase64Url,
    kdf: { name: "argon2id", memoryKiB, iterations, parallelism: 1, saltBase64Url },
    aead: { name: "xchacha20-poly1305", nonceBase64Url: b64(nonce) },
    ciphertextBase64Url: b64(ciphertext),
  };
}

export async function decryptKeyBackup(
  payload: KeyBackupPayloadOut,
  password: string,
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const fromB64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: new TextEncoder().encode(password),
    salt: fromB64(payload.kdf.saltBase64Url),
    memoryKiB: payload.kdf.memoryKiB,
    iterations: payload.kdf.iterations,
    keyLen: 32,
  });
  const aad = buildKeyBackupAad({
    userUuid: payload.userUuid,
    backupRevision: payload.backupRevision,
    backupKeyId: payload.backupKeyId,
    primaryKeyEpochId: payload.primaryKeyEpochId,
    epochSetRevision: payload.epochSetRevision,
    epochSetHashBase64Url: payload.epochSetHashBase64Url,
    kdfSaltBase64Url: payload.kdf.saltBase64Url,
  });
  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromB64(payload.ciphertextBase64Url),
      aad,
      fromB64(payload.aead.nonceBase64Url),
      wrapKey,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as KeyBackupPlaintext;
  } catch (e) {
    if (e instanceof Error && e.message.includes("Некорректный payload")) {
      throw e;
    }
    throw new Error("Неверный пароль или повреждённые данные резервной копии.");
  }
}

/**
 * Classify a fetched key-backup payload without throwing on password/corruption errors.
 * Lets callers branch on a stable {@link FscpBackupState} instead of parsing error strings.
 * NOTE: "missing" (HTTP 404) is determined by whoever performs the GET, not here.
 */
export async function classifyKeyBackup(
  raw: unknown,
  password: string,
): Promise<KeyBackupClassification> {
  let payload: KeyBackupPayloadOut;
  try {
    payload = parseKeyBackupPayload(raw);
  } catch (e) {
    return { state: "malformed", reason: e instanceof Error ? e.message : "parse error" };
  }
  try {
    const plaintext = await decryptKeyBackup(payload, password);
    return { state: "healthy", payload, plaintext };
  } catch (e) {
    if (e instanceof Error && e.message.includes("Некорректный payload")) {
      return { state: "malformed", reason: e.message };
    }
    return { state: "unreadable" };
  }
}

export async function decryptRecoveryBackup(
  payload: RecoveryBackupPayloadOut,
  recoveryPhrase: string,
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const fromB64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: new TextEncoder().encode(recoveryPhrase.trim()),
    salt: fromB64(payload.kdf.saltBase64Url),
    memoryKiB: payload.kdf.memoryKiB,
    iterations: payload.kdf.iterations,
    keyLen: 32,
  });
  const aad = buildRecoveryAad({
    userUuid: payload.userUuid,
    recoveryRevision: payload.recoveryRevision,
    recoveryKeyId: payload.recoveryKeyId,
    primaryKeyEpochId: payload.primaryKeyEpochId,
    epochSetRevision: payload.epochSetRevision,
    epochSetHashBase64Url: payload.epochSetHashBase64Url,
    kdfSaltBase64Url: payload.kdf.saltBase64Url,
  });
  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromB64(payload.ciphertextBase64Url),
      aad,
      fromB64(payload.aead.nonceBase64Url),
      wrapKey,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as KeyBackupPlaintext;
  } catch {
    throw new Error("Неверная фраза восстановления или повреждённые данные.");
  }
}

export async function bootstrapPlaintextFromLocalMaterial(
  agreementPrivateKey: Uint8Array,
  signingPrivateKey: Uint8Array,
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
  const agScalar =
    agreementPrivateKey.byteLength >= 32 ? agreementPrivateKey.subarray(0, 32) : agreementPrivateKey;
  const agPub = scalarmultBase(sodium, agScalar);
  const signPub =
    signingPrivateKey.byteLength >= 64 ? signingPrivateKey.subarray(32, 64) : signingPrivateKey.subarray(0, 32);
  return {
    primaryKeyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
    keyEpochs: [
      {
        keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
        status: "active",
        rootKeyBase64Url: b64(agScalar),
        epochAccountIdentityPrivateKeyBase64Url: b64(signingPrivateKey),
        epochAccountIdentityPublicKeyBase64Url: b64(signPub),
        conversationKeyBackups: [],
      },
    ],
  };
}

export async function restoreLocalMaterialFromBackupPlaintext(
  plaintext: KeyBackupPlaintext,
): Promise<{ agreementPrivateKey: Uint8Array; signingPrivateKey: Uint8Array }> {
  const epoch = plaintext.keyEpochs.find((e) => e.keyEpochId === plaintext.primaryKeyEpochId);
  if (!epoch) throw new Error("Эпоха ключей не найдена в бэкапе.");
  return {
    agreementPrivateKey: fromBase64Url(epoch.rootKeyBase64Url),
    signingPrivateKey: fromBase64Url(epoch.epochAccountIdentityPrivateKeyBase64Url),
  };
}
