/**
 * FSCP Unlock Flow: canonical string builders + Ed25519 signing helpers.
 *
 * Implements the client-side cryptographic operations for:
 *  - POST /api/messaging/e2e/unlock-complete   (recovery / trusted-device merge)
 *  - POST /api/messaging/e2e/epochs            (create new epoch after recovery)
 *  - Device key registration and signing
 *
 * All signing uses Ed25519 via libsodium (getSodium).
 * docs/fscp/e2e-security.md §Unlock-complete contract + §UserDeviceKey
 */

import { getSodium } from "./sodium";

// ── Base64url helpers (re-exported for convenience) ───────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  // Use libsodium's base64 encoder for consistency with the rest of FSCP.
  // Called after getSodium() is ready in context.
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Canonical string builders (docs/fscp/e2e-security.md) ─────────────────────────

const SEP = " | ";

/**
 * Canonical payload for unlock-complete Ed25519 signing.
 *
 * Format (docs/fscp/e2e-security.md §Unlock-complete contract):
 *   flora.messaging.unlock-complete.v1 | userUuid | resetRequestId | challengeId |
 *   backupKeyId | backupRevision | epochSetHashBase64Url | recoveredKeyEpochIds_sorted
 *
 * recoveredKeyEpochIds_sorted = sorted UUIDs joined by ","
 * The same canonical string is signed by EACH epoch's account identity private key.
 */
export function buildUnlockCompleteCanonical(params: {
  userUuid: string;
  resetRequestId: string;
  challengeId: string;
  backupKeyId: string;
  backupRevision: number;
  epochSetHashBase64Url: string;
  recoveredKeyEpochIds: string[];
}): string {
  const sortedIds = [...params.recoveredKeyEpochIds].sort().join(",");
  return [
    "flora.messaging.unlock-complete.v1",
    params.userUuid,
    params.resetRequestId,
    params.challengeId,
    params.backupKeyId,
    String(params.backupRevision),
    params.epochSetHashBase64Url,
    sortedIds,
  ].join(SEP);
}

/**
 * Canonical cover string for device key Ed25519 signing.
 *
 * Format (docs/fscp/e2e-security.md §UserDeviceKey):
 *   flora.messaging.device-key.v1 | userUuid | keyEpochId | deviceUuid |
 *   signingPublicKey | agreementPublicKey | createdAt
 *
 * createdAt = ISO-8601 UTC (e.g. "2026-06-08T00:00:00.000Z")
 * Signed by the epoch account identity private key.
 */
export function buildDeviceKeyCanonical(params: {
  userUuid: string;
  keyEpochId: string;
  deviceUuid: string;
  signingPublicKeyBase64Url: string;
  agreementPublicKeyBase64Url: string;
  createdAt: string;
}): string {
  return [
    "flora.messaging.device-key.v1",
    params.userUuid,
    params.keyEpochId,
    params.deviceUuid,
    params.signingPublicKeyBase64Url,
    params.agreementPublicKeyBase64Url,
    params.createdAt,
  ].join(SEP);
}

// ── Ed25519 signing via libsodium ─────────────────────────────────────────────

/**
 * Signs `message` with the Ed25519 private key and returns the detached
 * base64url-encoded signature.
 *
 * @param signingPrivateKeyBase64Url - 64-byte Ed25519 seed+public key (libsodium format).
 * @param message - UTF-8 string to sign.
 */
export async function ed25519Sign(
  signingPrivateKeyBase64Url: string,
  message: string
): Promise<string> {
  const sodium = await getSodium();
  const sk = sodium.from_base64(
    signingPrivateKeyBase64Url,
    sodium.base64_variants.URLSAFE_NO_PADDING
  );
  const msgBytes = sodium.from_string(message);
  const sig = sodium.crypto_sign_detached(msgBytes, sk);
  return sodium.to_base64(sig, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Returns the Ed25519 public key derived from the given private key, as base64url.
 * The libsodium private key is 64 bytes (seed || public key); public = last 32 bytes.
 */
export async function ed25519PublicKeyFromPrivate(
  signingPrivateKeyBase64Url: string
): Promise<string> {
  const sodium = await getSodium();
  const sk = sodium.from_base64(
    signingPrivateKeyBase64Url,
    sodium.base64_variants.URLSAFE_NO_PADDING
  );
  // libsodium sign secret key format: 64 bytes = seed(32) + public_key(32)
  const pk = sk.slice(32, 64);
  return sodium.to_base64(pk, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Generates a fresh Ed25519 key pair.
 * Returns the private key (64 bytes, libsodium format) and public key (32 bytes),
 * both as base64url.
 */
export async function generateEd25519KeyPair(): Promise<{
  signingPrivateKeyBase64Url: string;
  signingPublicKeyBase64Url: string;
}> {
  const sodium = await getSodium();
  const kp = sodium.crypto_sign_keypair();
  return {
    signingPrivateKeyBase64Url: sodium.to_base64(
      kp.privateKey,
      sodium.base64_variants.URLSAFE_NO_PADDING
    ),
    signingPublicKeyBase64Url: sodium.to_base64(
      kp.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING
    ),
  };
}

/**
 * Generates a fresh X25519 key pair for device agreement.
 * Returns the private scalar (32 bytes) and public key (32 bytes), both as base64url.
 */
export async function generateX25519KeyPair(): Promise<{
  agreementPrivateKeyBase64Url: string;
  agreementPublicKeyBase64Url: string;
}> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  // private key from crypto_box_keypair is 32 bytes scalar (curve25519)
  const sk32 =
    kp.privateKey.length === 64 ? kp.privateKey.slice(0, 32) : kp.privateKey;
  return {
    agreementPrivateKeyBase64Url: sodium.to_base64(
      sk32,
      sodium.base64_variants.URLSAFE_NO_PADDING
    ),
    agreementPublicKeyBase64Url: sodium.to_base64(
      kp.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING
    ),
  };
}

// ── Unlock-complete full client flow ──────────────────────────────────────────

export type EpochMaterial = {
  keyEpochId: string;
  /** Ed25519 epoch account identity private key (base64url, libsodium 64-byte format). */
  epochAccountIdentityPrivateKeyBase64Url: string;
  /** Ed25519 epoch account identity public key (base64url, 32 bytes). */
  epochAccountIdentityPublicKeyBase64Url: string;
};

export type UnlockCompleteSigningInput = {
  userUuid: string;
  resetRequestId: string;
  challengeId: string;
  backupKeyId: string;
  backupRevision: number;
  epochSetHashBase64Url: string;
  recoveredEpochs: EpochMaterial[];
};

export type EpochSignatureEntry = {
  keyEpochId: string;
  valueBase64Url: string;
};

export type UnlockCompleteSignedPayload = {
  /** Sorted by keyEpochId for server validation. */
  epochIdentityPublicKeys: EpochSignatureEntry[];
  /** Detached Ed25519 signatures over the canonical payload. */
  epochUnlockSignatures: EpochSignatureEntry[];
  /** Sorted list of recovered epoch IDs. */
  recoveredKeyEpochIds: string[];
};

/**
 * Produces the full signed payload for POST /api/messaging/e2e/unlock-complete.
 *
 * For each recovered epoch:
 *   1. Builds the canonical string.
 *   2. Signs it with the epoch account identity private key.
 *   3. Produces the epochUnlockSignatures and epochIdentityPublicKeys arrays.
 *
 * Both arrays are sorted by keyEpochId (ascending) per spec.
 */
export async function signUnlockCompletePayload(
  input: UnlockCompleteSigningInput
): Promise<UnlockCompleteSignedPayload> {
  const recoveredKeyEpochIds = input.recoveredEpochs
    .map((e) => e.keyEpochId)
    .sort();

  const canonical = buildUnlockCompleteCanonical({
    userUuid: input.userUuid,
    resetRequestId: input.resetRequestId,
    challengeId: input.challengeId,
    backupKeyId: input.backupKeyId,
    backupRevision: input.backupRevision,
    epochSetHashBase64Url: input.epochSetHashBase64Url,
    recoveredKeyEpochIds,
  });

  const signatures: EpochSignatureEntry[] = [];
  const publicKeys: EpochSignatureEntry[] = [];

  for (const epoch of input.recoveredEpochs) {
    const sig = await ed25519Sign(
      epoch.epochAccountIdentityPrivateKeyBase64Url,
      canonical
    );
    signatures.push({ keyEpochId: epoch.keyEpochId, valueBase64Url: sig });
    publicKeys.push({
      keyEpochId: epoch.keyEpochId,
      valueBase64Url: epoch.epochAccountIdentityPublicKeyBase64Url,
    });
  }

  signatures.sort((a, b) => a.keyEpochId.localeCompare(b.keyEpochId));
  publicKeys.sort((a, b) => a.keyEpochId.localeCompare(b.keyEpochId));

  return {
    epochIdentityPublicKeys: publicKeys,
    epochUnlockSignatures: signatures,
    recoveredKeyEpochIds,
  };
}

// ── Device key signing (epoch account identity signs device key) ───────────────

export type DeviceKeySigningInput = {
  userUuid: string;
  keyEpochId: string;
  deviceUuid: string;
  signingPublicKeyBase64Url: string;
  agreementPublicKeyBase64Url: string;
  createdAt: string;
  /** Epoch account identity private key that signs the device binding. */
  epochAccountIdentityPrivateKeyBase64Url: string;
};

/**
 * Produces the Ed25519 signature over the device key canonical cover string.
 * Use when approving a Pending device after trusted-device approval.
 */
export async function signDeviceKeyBinding(
  input: DeviceKeySigningInput
): Promise<string> {
  const canonical = buildDeviceKeyCanonical({
    userUuid: input.userUuid,
    keyEpochId: input.keyEpochId,
    deviceUuid: input.deviceUuid,
    signingPublicKeyBase64Url: input.signingPublicKeyBase64Url,
    agreementPublicKeyBase64Url: input.agreementPublicKeyBase64Url,
    createdAt: input.createdAt,
  });
  return ed25519Sign(input.epochAccountIdentityPrivateKeyBase64Url, canonical);
}
