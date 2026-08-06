/**
 * FSCP Key Backup: creates and decrypts the password-encrypted and
 * recovery-phrase-encrypted E2E material backups.
 *
 * Architecture:
 *  - Argon2id KDF → Web Worker (kdfWorker.ts) so the main thread never blocks.
 *  - XChaCha20-Poly1305 AEAD → libsodium on the main thread (fast, microseconds).
 *  - All key material stays in memory; only opaque ciphertext reaches the server.
 *
 * Documents/fscp/e2e-security.md §UserE2EKeyBackup
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { getSodium } from "./sodium";
import { FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "./constants";
import { deriveKeyArgon2idViaWorker } from "./kdfClient";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single key epoch in the plaintext backup. */
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

/** Plaintext that gets AEAD-encrypted and stored as ciphertext. */
export type KeyBackupPlaintext = {
  primaryKeyEpochId: string;
  keyEpochs: KeyEpochBackupEntry[];
};

/** KDF parameters to persist alongside the ciphertext. */
export type KdfParamsOut = {
  name: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltBase64Url: string;
};

/** Full key backup payload ready to PUT to /api/messaging/e2e/key-backup. */
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

// ── Argon2id KDF via Web Worker ───────────────────────────────────────────────
// RPC + Worker instance itself live in kdfClient.ts, shared with the FSCP SoT's
// configureFscpKdf() wiring (clientCore.ts) — one Worker, not two.

async function deriveKeyArgon2id(params: {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  keyLen: number;
}): Promise<Uint8Array> {
  return deriveKeyArgon2idViaWorker({
    passwordBytes: params.passwordBytes,
    salt: params.salt,
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    outputLength: params.keyLen,
  });
}

// ── Epoch set hash (canonical commitment) ────────────────────────────────────

/**
 * Computes the epochSetHash as SHA-256 of the canonical JSON of the epoch set.
 * The server stores this alongside the ciphertext for integrity checks.
 */
export function computeEpochSetHash(epochs: KeyEpochBackupEntry[]): string {
  const canonical = JSON.stringify(
    epochs.map((e) => ({
      keyEpochId: e.keyEpochId,
      status: e.status,
      epochAccountIdentityPublicKeyBase64Url: e.epochAccountIdentityPublicKeyBase64Url,
    })),
    null,
    0
  );
  const hash = sha256(new TextEncoder().encode(canonical));
  // base64url encode without padding
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * After AEAD decrypt + JSON.parse: outer metadata must match the plaintext epoch set.
 * Web copy uses `===` for the hash (fixed-length SHA-256 base64url); no franking import.
 */
function assertEpochSetIntegrity(
  plaintext: KeyBackupPlaintext,
  expectedHash: string,
  expectedPrimaryEpochId: string
): void {
  if (plaintext.primaryKeyEpochId !== expectedPrimaryEpochId) {
    throw new Error(
      "Повреждённые или несогласованные данные резервной копии: commitment набора эпох."
    );
  }
  // Keep parity with SoT: missing/non-array keyEpochs must not throw TypeError.
  if (!Array.isArray(plaintext.keyEpochs)) {
    throw new Error(
      "Повреждённые или несогласованные данные резервной копии: commitment набора эпох."
    );
  }
  if (computeEpochSetHash(plaintext.keyEpochs) !== expectedHash) {
    throw new Error(
      "Повреждённые или несогласованные данные резервной копии: commitment набора эпох."
    );
  }
}

// ── AAD construction ──────────────────────────────────────────────────────────

/**
 * Constructs the AEAD Additional Authenticated Data string per spec:
 * "flora.messaging.key-backup.v1 | userUuid | backupRevision | backupKeyId |
 *  primaryKeyEpochId | epochSetRevision | epochSetHash | kdfSalt"
 */
function buildKeyBackupAad(params: {
  userUuid: string;
  backupRevision: number;
  backupKeyId: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  kdfSaltBase64Url: string;
}): Uint8Array {
  const parts = [
    "flora.messaging.key-backup.v1",
    params.userUuid,
    String(params.backupRevision),
    params.backupKeyId,
    params.primaryKeyEpochId,
    String(params.epochSetRevision),
    params.epochSetHashBase64Url,
    params.kdfSaltBase64Url,
  ];
  return new TextEncoder().encode(parts.join(" | "));
}

function buildRecoveryAad(params: {
  userUuid: string;
  recoveryRevision: number;
  recoveryKeyId: string;
  primaryKeyEpochId: string;
  epochSetRevision: number;
  epochSetHashBase64Url: string;
  kdfSaltBase64Url: string;
}): Uint8Array {
  const parts = [
    "flora.messaging.recovery-backup.v1",
    params.userUuid,
    String(params.recoveryRevision),
    params.recoveryKeyId,
    params.primaryKeyEpochId,
    String(params.epochSetRevision),
    params.epochSetHashBase64Url,
    params.kdfSaltBase64Url,
  ];
  return new TextEncoder().encode(parts.join(" | "));
}

// ── Public API ────────────────────────────────────────────────────────────────

export type CreateKeyBackupParams = {
  userUuid: string;
  password: string;
  plaintext: KeyBackupPlaintext;
  /** Monotonically increasing revision. Pass 1 for first backup. */
  backupRevision: number;
  epochSetRevision: number;
  /** Stable UUID for this backup key (client generates and persists). */
  backupKeyId: string;
  /** KDF params; defaults applied if not specified. */
  kdf?: { memoryKiB?: number; iterations?: number };
};

/**
 * Encrypts the E2E key material with the user's password using Argon2id + XChaCha20-Poly1305.
 * Runs KDF in a Web Worker to avoid blocking the main thread.
 * Returns the payload ready for PUT /api/messaging/e2e/key-backup.
 */
export async function createKeyBackup(
  params: CreateKeyBackupParams
): Promise<KeyBackupPayloadOut> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) =>
    sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);

  const memoryKiB = params.kdf?.memoryKiB ?? 65536;
  const iterations = params.kdf?.iterations ?? 3;
  const parallelism = 1;

  // Generate random 16-byte Argon2id salt
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const saltBase64Url = b64(salt);

  // Derive 32-byte wrap key via Argon2id (in worker)
  const pwBytes = new TextEncoder().encode(params.password);
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: pwBytes,
    salt,
    memoryKiB,
    iterations,
    keyLen: 32,
  });

  const epochSetHashBase64Url = computeEpochSetHash(params.plaintext.keyEpochs);
  const plaintextJson = JSON.stringify(params.plaintext);
  const plaintextBytes = new TextEncoder().encode(plaintextJson);

  // Generate 24-byte XChaCha20 nonce
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const nonceBase64Url = b64(nonce);

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
    plaintextBytes,
    aad,
    null,
    nonce,
    wrapKey
  );

  return {
    version: 1,
    backupRevision: params.backupRevision,
    backupKeyId: params.backupKeyId,
    userUuid: params.userUuid,
    primaryKeyEpochId: params.plaintext.primaryKeyEpochId,
    epochSetRevision: params.epochSetRevision,
    epochSetHashBase64Url,
    kdf: {
      name: "argon2id",
      memoryKiB,
      iterations,
      parallelism,
      saltBase64Url,
    },
    aead: { name: "xchacha20-poly1305", nonceBase64Url },
    ciphertextBase64Url: b64(ciphertext),
  };
}

/** Decrypts a stored key backup using the user's password. */
export async function decryptKeyBackup(
  payload: KeyBackupPayloadOut,
  password: string
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const fromB64 = (s: string) =>
    sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

  const pwBytes = new TextEncoder().encode(password);
  const salt = fromB64(payload.kdf.saltBase64Url);

  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: pwBytes,
    salt,
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

  const nonce = fromB64(payload.aead.nonceBase64Url);
  const ciphertext = fromB64(payload.ciphertextBase64Url);

  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      wrapKey
    );
  } catch {
    throw new Error("Неверный пароль или повреждённые данные резервной копии.");
  }

  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as KeyBackupPlaintext;
  assertEpochSetIntegrity(
    parsed,
    payload.epochSetHashBase64Url,
    payload.primaryKeyEpochId
  );
  return parsed;
}

// ── Recovery backup ───────────────────────────────────────────────────────────

export type CreateRecoveryBackupParams = {
  userUuid: string;
  /** 12-word phrase joined with spaces. */
  recoveryPhrase: string;
  plaintext: KeyBackupPlaintext;
  recoveryRevision: number;
  epochSetRevision: number;
  recoveryKeyId: string;
  wordlistId?: string;
  wordsCount?: number;
  kdf?: { memoryKiB?: number; iterations?: number };
};

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

/**
 * Encrypts the E2E key material with the user's recovery phrase.
 * Uses stricter KDF parameters (iterations: 4 by default).
 */
export async function createRecoveryBackup(
  params: CreateRecoveryBackupParams
): Promise<RecoveryBackupPayloadOut> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) =>
    sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);

  const memoryKiB = params.kdf?.memoryKiB ?? 65536;
  const iterations = params.kdf?.iterations ?? 4;
  const parallelism = 1;

  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const saltBase64Url = b64(salt);

  const phraseBytes = new TextEncoder().encode(params.recoveryPhrase.trim());
  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: phraseBytes,
    salt,
    memoryKiB,
    iterations,
    keyLen: 32,
  });

  const epochSetHashBase64Url = computeEpochSetHash(params.plaintext.keyEpochs);
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(params.plaintext));
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const nonceBase64Url = b64(nonce);

  const aad = buildRecoveryAad({
    userUuid: params.userUuid,
    recoveryRevision: params.recoveryRevision,
    recoveryKeyId: params.recoveryKeyId,
    primaryKeyEpochId: params.plaintext.primaryKeyEpochId,
    epochSetRevision: params.epochSetRevision,
    epochSetHashBase64Url,
    kdfSaltBase64Url: saltBase64Url,
  });

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintextBytes,
    aad,
    null,
    nonce,
    wrapKey
  );

  return {
    version: 1,
    recoveryRevision: params.recoveryRevision,
    recoveryKeyId: params.recoveryKeyId,
    userUuid: params.userUuid,
    primaryKeyEpochId: params.plaintext.primaryKeyEpochId,
    epochSetRevision: params.epochSetRevision,
    epochSetHashBase64Url,
    wordlist: {
      id: params.wordlistId ?? "flora-recovery-ru-v1",
      wordsCount: params.wordsCount ?? 12,
    },
    kdf: { name: "argon2id", memoryKiB, iterations, parallelism, saltBase64Url },
    aead: { name: "xchacha20-poly1305", nonceBase64Url },
    ciphertextBase64Url: b64(ciphertext),
  };
}

/** Decrypts a stored recovery backup using the user's 12-word recovery phrase. */
export async function decryptRecoveryBackup(
  payload: RecoveryBackupPayloadOut,
  recoveryPhrase: string
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const fromB64 = (s: string) =>
    sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

  const phraseBytes = new TextEncoder().encode(recoveryPhrase.trim());
  const salt = fromB64(payload.kdf.saltBase64Url);

  const wrapKey = await deriveKeyArgon2id({
    passwordBytes: phraseBytes,
    salt,
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

  const nonce = fromB64(payload.aead.nonceBase64Url);
  const ciphertext = fromB64(payload.ciphertextBase64Url);

  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      wrapKey
    );
  } catch {
    throw new Error("Неверная фраза восстановления или повреждённые данные.");
  }

  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as KeyBackupPlaintext;
  assertEpochSetIntegrity(
    parsed,
    payload.epochSetHashBase64Url,
    payload.primaryKeyEpochId
  );
  return parsed;
}

// ── Bootstrap helper ──────────────────────────────────────────────────────────

/**
 * Builds a KeyBackupPlaintext from the current bootstrap FSCP material
 * (agreementPrivateKey + signingPrivateKey for the v1 bootstrap epoch).
 */
export async function bootstrapPlaintextFromLocalMaterial(
  agreementPrivateKey: Uint8Array,
  signingPrivateKey: Uint8Array
): Promise<KeyBackupPlaintext> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) =>
    sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);

  // Derive public keys from private keys
  const agPub = sodium.crypto_scalarmult_base(agreementPrivateKey);
  // signingPrivateKey from libsodium is 64 bytes; the public key is the last 32 bytes
  const signPub = signingPrivateKey.length === 64
    ? signingPrivateKey.slice(32)
    : sodium.crypto_sign_ed25519_sk_to_pk(signingPrivateKey);

  return {
    primaryKeyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
    keyEpochs: [
      {
        keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
        status: "active",
        rootKeyBase64Url: b64(agreementPrivateKey),
        epochAccountIdentityPrivateKeyBase64Url: b64(signingPrivateKey),
        epochAccountIdentityPublicKeyBase64Url: b64(signPub),
        conversationKeyBackups: [],
      },
    ],
  };
}

export { FSCP_BOOTSTRAP_KEY_EPOCH_ID };
