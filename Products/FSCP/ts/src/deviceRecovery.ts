/**
 * DeviceToDeviceRecoveryEnvelope (Documents/fscp/e2e-security.md §DeviceToDeviceRecoveryEnvelope).
 *
 * Trusted-device recovery: старое active-устройство передаёт E2E material выбранных
 * epochs (root key, epoch account identity keys) новому устройству через отдельный
 * envelope — НЕ через message envelope.
 *
 * Криптосхема повторяет RKE v1: X25519(eph, target device agreement pk) →
 * HKDF-SHA256(salt32, info=AAD) → XChaCha20-Poly1305(aad=AAD). Поверх — Ed25519
 * подпись source device signing key над canonical JSON конверта без подписи
 * (challenge binding: recoveryRequestId, устройства, список epochs — всё в AAD
 * и под подписью).
 */

import { v5 as uuidv5 } from "uuid";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "./canonicalJson.js";
import { FLORA_UUID_NAMESPACE } from "./constants.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { toBase64Url } from "./unlockFlow.js";
import { getSodium, scalarmult, scalarmultBase } from "./sodium.js";

const D2D_AAD_DOMAIN = "flora.messaging.device-to-device-recovery.v1";
const D2D_SIGNATURE_DOMAIN = "flora.messaging.device-to-device-recovery-signature.v1";

/** Материал одной epoch внутри plaintext конверта (схема §DeviceToDeviceRecoveryEnvelope). */
export type FscpDeviceRecoveryEpoch = {
  keyEpochId: string;
  rootKeyBase64Url: string;
  epochAccountIdentityPrivateKeyBase64Url: string;
  epochAccountIdentityPublicKeyBase64Url: string;
  /** v1: пусто; зарезервировано для per-conversation ключей. */
  conversationKeyBackups: unknown[];
};

export type FscpDeviceRecoveryPayload = {
  keyEpochs: FscpDeviceRecoveryEpoch[];
};

/** JSON-конверт D2D recovery (передаётся телом recover-key, сервер не расшифровывает). */
export type FscpDeviceRecoveryEnvelope = {
  version: 1;
  recoveryRequestId: string;
  userUuid: string;
  sourceDeviceUuid: string;
  targetDeviceUuid: string;
  transferredKeyEpochIds: string[];
  targetAgreementPublicKeyId: string;
  ephemeralPublicKeyBase64Url: string;
  saltBase64Url: string;
  aead: { name: "xchacha20-poly1305"; nonceBase64Url: string };
  ciphertextBase64Url: string;
  sourceDeviceSignatureBase64Url: string;
};

/** Детерминированный id device agreement-ключа (аналог agreementPublicKeyId для устройств). */
export function deviceAgreementPublicKeyId(userUuid: string, deviceUuid: string): string {
  return uuidv5(
    `${userUuid.toLowerCase()}|${deviceUuid.toLowerCase()}|device-agreement-v1`,
    FLORA_UUID_NAMESPACE,
  );
}

/** AAD-строка конверта — байт-в-байт по спеке; epochs отсортированы и склеены запятой. */
export function deviceRecoveryAadLine(params: {
  recoveryRequestId: string;
  userUuid: string;
  sourceDeviceUuid: string;
  targetDeviceUuid: string;
  targetAgreementPublicKeyId: string;
  transferredKeyEpochIds: string[];
}): string {
  const sortedEpochs = [...params.transferredKeyEpochIds]
    .map((id) => id.toLowerCase())
    .sort()
    .join(",");
  return [
    D2D_AAD_DOMAIN,
    params.recoveryRequestId.toLowerCase(),
    params.userUuid.toLowerCase(),
    params.sourceDeviceUuid.toLowerCase(),
    params.targetDeviceUuid.toLowerCase(),
    params.targetAgreementPublicKeyId.toLowerCase(),
    sortedEpochs,
  ].join(" | ");
}

function envelopeWithoutSignature(
  env: FscpDeviceRecoveryEnvelope,
): Omit<FscpDeviceRecoveryEnvelope, "sourceDeviceSignatureBase64Url"> {
  const { sourceDeviceSignatureBase64Url: _sig, ...rest } = env;
  return rest;
}

function signaturePayload(envNoSig: object): Uint8Array {
  return utf8Bytes(`${D2D_SIGNATURE_DOMAIN} | ${canonicalJson(envNoSig)}`);
}

/**
 * Строит подписанный DeviceToDeviceRecoveryEnvelope на старом (source) устройстве.
 *
 * @param targetDeviceAgreementPublicKey X25519 pk нового устройства (32 байта) —
 *   из server-attested записи devices (status pending) той же epoch.
 * @param sourceDeviceSigningPrivateKey Ed25519 sk source-устройства (64 байта libsodium).
 */
export async function buildDeviceRecoveryEnvelope(params: {
  recoveryRequestId: string;
  userUuid: string;
  sourceDeviceUuid: string;
  targetDeviceUuid: string;
  targetDeviceAgreementPublicKey: Uint8Array;
  sourceDeviceSigningPrivateKey: Uint8Array;
  payload: FscpDeviceRecoveryPayload;
}): Promise<FscpDeviceRecoveryEnvelope> {
  if (params.payload.keyEpochs.length === 0) {
    throw new Error("D2D recovery: payload.keyEpochs не может быть пустым.");
  }
  const sodium = await getSodium();

  const transferredKeyEpochIds = params.payload.keyEpochs
    .map((e) => e.keyEpochId.toLowerCase())
    .sort();
  const uniqueCount = new Set(transferredKeyEpochIds).size;
  if (uniqueCount !== transferredKeyEpochIds.length) {
    throw new Error("D2D recovery: дублирующиеся keyEpochId в payload.");
  }

  const targetAgreementPublicKeyId = deviceAgreementPublicKeyId(
    params.userUuid,
    params.targetDeviceUuid,
  );
  const aad = deviceRecoveryAadLine({
    recoveryRequestId: params.recoveryRequestId,
    userUuid: params.userUuid,
    sourceDeviceUuid: params.sourceDeviceUuid,
    targetDeviceUuid: params.targetDeviceUuid,
    targetAgreementPublicKeyId,
    transferredKeyEpochIds,
  });

  // X25519 → HKDF(salt, info=AAD) → wrap key — та же схема, что RKE v1.
  const ephemeralSecret = sodium.randombytes_buf(32);
  const ephemeralPublicKey = scalarmultBase(sodium, ephemeralSecret);
  const salt32 = sodium.randombytes_buf(32);
  const ss = scalarmult(sodium, ephemeralSecret, params.targetDeviceAgreementPublicKey);
  const prk = extract(sha256, ss, salt32);
  const wrapKey = expand(sha256, prk, utf8Bytes(aad), 32);

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plaintextJson = JSON.stringify(params.payload);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    utf8Bytes(plaintextJson),
    aad,
    null,
    nonce,
    wrapKey,
  );

  const envNoSig = {
    version: 1 as const,
    recoveryRequestId: params.recoveryRequestId.toLowerCase(),
    userUuid: params.userUuid.toLowerCase(),
    sourceDeviceUuid: params.sourceDeviceUuid.toLowerCase(),
    targetDeviceUuid: params.targetDeviceUuid.toLowerCase(),
    transferredKeyEpochIds,
    targetAgreementPublicKeyId,
    ephemeralPublicKeyBase64Url: toBase64Url(ephemeralPublicKey),
    saltBase64Url: toBase64Url(salt32),
    aead: { name: "xchacha20-poly1305" as const, nonceBase64Url: toBase64Url(nonce) },
    ciphertextBase64Url: toBase64Url(ciphertext),
  };

  const signature = sodium.crypto_sign_detached(
    signaturePayload(envNoSig),
    params.sourceDeviceSigningPrivateKey,
  );

  return { ...envNoSig, sourceDeviceSignatureBase64Url: toBase64Url(signature) };
}

export type FscpDeviceRecoveryOpenErrorCategory =
  | "malformed_envelope"
  | "binding_mismatch"
  | "signature_invalid"
  | "decrypt_failed"
  | "malformed_payload";

export class FscpDeviceRecoveryOpenError extends Error {
  readonly category: FscpDeviceRecoveryOpenErrorCategory;
  constructor(category: FscpDeviceRecoveryOpenErrorCategory, message: string) {
    super(message);
    this.name = "FscpDeviceRecoveryOpenError";
    this.category = category;
  }
}

/**
 * Открывает DeviceToDeviceRecoveryEnvelope на новом (target) устройстве.
 *
 * Порядок проверок (fail-closed):
 *  1. форма конверта и version=1;
 *  2. binding: recoveryRequestId / userUuid / targetDeviceUuid / (опц.) sourceDeviceUuid
 *     совпадают с ожиданиями вызывающего (полученными вне конверта);
 *  3. Ed25519 подпись source device (pk берётся из server-attested devices list,
 *     НЕ из конверта);
 *  4. AEAD decrypt с AAD, восстановленным из полей конверта;
 *  5. payload.keyEpochs байт-в-байт согласован с transferredKeyEpochIds.
 */
export async function openDeviceRecoveryEnvelope(params: {
  envelope: FscpDeviceRecoveryEnvelope;
  expected: {
    recoveryRequestId: string;
    userUuid: string;
    targetDeviceUuid: string;
    /** Если известно заранее — жёсткая сверка source device. */
    sourceDeviceUuid?: string;
  };
  /** Ed25519 pk source-устройства из server-attested записи devices (32 байта). */
  sourceDeviceSigningPublicKey: Uint8Array;
  /** X25519 sk agreement-ключа target-устройства (32 байта). */
  targetDeviceAgreementPrivateKey: Uint8Array;
}): Promise<FscpDeviceRecoveryPayload> {
  const sodium = await getSodium();
  const env = params.envelope;

  if (
    !env ||
    env.version !== 1 ||
    typeof env.ciphertextBase64Url !== "string" ||
    env.aead?.name !== "xchacha20-poly1305" ||
    !Array.isArray(env.transferredKeyEpochIds) ||
    env.transferredKeyEpochIds.length === 0
  ) {
    throw new FscpDeviceRecoveryOpenError(
      "malformed_envelope",
      "Повреждённый или неподдерживаемый D2D recovery конверт.",
    );
  }

  const exp = params.expected;
  const bindingOk =
    env.recoveryRequestId.toLowerCase() === exp.recoveryRequestId.toLowerCase() &&
    env.userUuid.toLowerCase() === exp.userUuid.toLowerCase() &&
    env.targetDeviceUuid.toLowerCase() === exp.targetDeviceUuid.toLowerCase() &&
    (exp.sourceDeviceUuid === undefined ||
      env.sourceDeviceUuid.toLowerCase() === exp.sourceDeviceUuid.toLowerCase());
  if (!bindingOk) {
    throw new FscpDeviceRecoveryOpenError(
      "binding_mismatch",
      "Конверт привязан к другому recovery-запросу/пользователю/устройству.",
    );
  }
  const expectedAgreementId = deviceAgreementPublicKeyId(env.userUuid, env.targetDeviceUuid);
  if (env.targetAgreementPublicKeyId.toLowerCase() !== expectedAgreementId) {
    throw new FscpDeviceRecoveryOpenError(
      "binding_mismatch",
      "targetAgreementPublicKeyId не соответствует target-устройству.",
    );
  }

  let signatureOk = false;
  try {
    signatureOk = sodium.crypto_sign_verify_detached(
      fromBase64Url(env.sourceDeviceSignatureBase64Url),
      signaturePayload(envelopeWithoutSignature(env)),
      params.sourceDeviceSigningPublicKey,
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new FscpDeviceRecoveryOpenError(
      "signature_invalid",
      "Подпись source-устройства не прошла проверку.",
    );
  }

  const aad = deviceRecoveryAadLine({
    recoveryRequestId: env.recoveryRequestId,
    userUuid: env.userUuid,
    sourceDeviceUuid: env.sourceDeviceUuid,
    targetDeviceUuid: env.targetDeviceUuid,
    targetAgreementPublicKeyId: env.targetAgreementPublicKeyId,
    transferredKeyEpochIds: env.transferredKeyEpochIds,
  });

  let plaintextJson: string;
  try {
    const ss = scalarmult(
      sodium,
      params.targetDeviceAgreementPrivateKey,
      fromBase64Url(env.ephemeralPublicKeyBase64Url),
    );
    const prk = extract(sha256, ss, fromBase64Url(env.saltBase64Url));
    const wrapKey = expand(sha256, prk, utf8Bytes(aad), 32);
    const plainBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(env.ciphertextBase64Url),
      aad,
      fromBase64Url(env.aead.nonceBase64Url),
      wrapKey,
    );
    plaintextJson = new TextDecoder().decode(plainBytes);
  } catch {
    throw new FscpDeviceRecoveryOpenError(
      "decrypt_failed",
      "AEAD D2D recovery конверта не расшифровался (ключ/AAD/повреждение).",
    );
  }

  let payload: FscpDeviceRecoveryPayload;
  try {
    const parsed: unknown = JSON.parse(plaintextJson);
    payload = normalizePayload(parsed);
  } catch (e) {
    if (e instanceof FscpDeviceRecoveryOpenError) throw e;
    throw new FscpDeviceRecoveryOpenError(
      "malformed_payload",
      "Plaintext D2D recovery конверта имеет неверную форму.",
    );
  }

  const payloadEpochIds = payload.keyEpochs.map((e) => e.keyEpochId.toLowerCase()).sort();
  const declaredEpochIds = [...env.transferredKeyEpochIds].map((e) => e.toLowerCase()).sort();
  if (
    payloadEpochIds.length !== declaredEpochIds.length ||
    payloadEpochIds.some((id, i) => id !== declaredEpochIds[i])
  ) {
    throw new FscpDeviceRecoveryOpenError(
      "malformed_payload",
      "keyEpochs в plaintext не совпадают с transferredKeyEpochIds конверта.",
    );
  }

  return payload;
}

function normalizePayload(parsed: unknown): FscpDeviceRecoveryPayload {
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keyEpochs?: unknown }).keyEpochs)) {
    throw new FscpDeviceRecoveryOpenError(
      "malformed_payload",
      "Plaintext D2D recovery конверта: нет keyEpochs.",
    );
  }
  const keyEpochs: FscpDeviceRecoveryEpoch[] = [];
  for (const raw of (parsed as { keyEpochs: unknown[] }).keyEpochs) {
    if (!raw || typeof raw !== "object") {
      throw new FscpDeviceRecoveryOpenError(
        "malformed_payload",
        "Plaintext D2D recovery конверта: элемент keyEpochs не объект.",
      );
    }
    const e = raw as Record<string, unknown>;
    if (
      typeof e.keyEpochId !== "string" ||
      typeof e.rootKeyBase64Url !== "string" ||
      typeof e.epochAccountIdentityPrivateKeyBase64Url !== "string" ||
      typeof e.epochAccountIdentityPublicKeyBase64Url !== "string"
    ) {
      throw new FscpDeviceRecoveryOpenError(
        "malformed_payload",
        "Plaintext D2D recovery конверта: неполный материал epoch.",
      );
    }
    keyEpochs.push({
      keyEpochId: e.keyEpochId,
      rootKeyBase64Url: e.rootKeyBase64Url,
      epochAccountIdentityPrivateKeyBase64Url: e.epochAccountIdentityPrivateKeyBase64Url,
      epochAccountIdentityPublicKeyBase64Url: e.epochAccountIdentityPublicKeyBase64Url,
      conversationKeyBackups: Array.isArray(e.conversationKeyBackups) ? e.conversationKeyBackups : [],
    });
  }
  return { keyEpochs };
}
