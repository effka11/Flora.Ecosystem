/**
 * Message franking v1 — эталонная реализация FSCP-FRANK (Documents/fscp/franking.md).
 *
 * Wire-активация — v1.1+ (после снятия заморозки, next-architecture.md §1.2);
 * сами примитивы — чистые функции без wire-побочек, реализованы заранее, чтобы
 * RFC был исполняемым и закреплён golden-вектором (franking-v1.json) до активации.
 *
 * Роли: отправитель — commitInput + frankTag; сервер — receiptPayload + подпись
 * (реф. подписант — генератор вектора, серверная реализация при v1.1);
 * жюри — verifyFrankedMessageV1 (полная проверка жалобы).
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Bytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";
import { floraNewUuid } from "./floraUuid.js";
import { rkeUnwrapMessageKey, rkeWrapMessageKey } from "./rke.js";
import type { SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const URLSAFE_NO_PADDING = 7;

export const FSCP_FRANKING_CONTEXT_V1 = "flora.fscp.franking.v1";
export const FSCP_FRANKING_RECEIPT_CONTEXT_V1 = "flora.fscp.franking-receipt.v1";

export type FrankCommitContextV1 = {
  conversationUuid: string;
  messageUuid: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  receiverUserUuid: string;
  /** RFC3339 UTC из конверта (`createdAt`) — байт-в-байт, без нормализации. */
  createdAt: string;
};

/** Строка коммита (franking.md §4.1): контекст + base64url(SHA-256(plaintext)). */
export function frankCommitInputV1(ctx: FrankCommitContextV1, plaintextUtf8: Uint8Array): string {
  return [
    FSCP_FRANKING_CONTEXT_V1,
    ctx.conversationUuid.toLowerCase(),
    ctx.messageUuid.toLowerCase(),
    ctx.senderUserUuid.toLowerCase(),
    ctx.senderDeviceUuid.toLowerCase(),
    ctx.receiverUserUuid.toLowerCase(),
    ctx.createdAt,
    toBase64Url(sha256(plaintextUtf8)),
  ].join(" | ");
}

/** frankTag = HMAC-SHA-256(frankingKey, commitInput). Ключ — ровно 32 байта, per-message. */
export function computeFrankTagV1(frankingKey: Uint8Array, commitInputUtf8: string): Uint8Array {
  if (frankingKey.length !== 32) {
    throw new Error("frankingKey должен быть 32 байта (per-message, CSPRNG).");
  }
  return hmac(sha256, frankingKey, utf8Bytes(commitInputUtf8));
}

export type FrankReceiptContextV1 = {
  frankTagBase64Url: string;
  messageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  receiverUserUuid: string;
  /** RFC3339 UTC, проставляет сервер при приёме. */
  serverReceivedAt: string;
};

/** Подписываемая серверная квитанция (franking.md §4.3). */
export function frankReceiptPayloadV1(ctx: FrankReceiptContextV1): string {
  return [
    FSCP_FRANKING_RECEIPT_CONTEXT_V1,
    ctx.frankTagBase64Url,
    ctx.messageUuid.toLowerCase(),
    ctx.conversationUuid.toLowerCase(),
    ctx.senderUserUuid.toLowerCase(),
    ctx.receiverUserUuid.toLowerCase(),
    ctx.serverReceivedAt,
  ].join(" | ");
}

export type ServerFrankReceiptV1 = {
  signatureBase64Url: string;
  serverFrankingKeyId: string;
  serverReceivedAt: string;
};

export type FrankComplaintTupleV1 = {
  plaintextUtf8: Uint8Array;
  frankingKey: Uint8Array;
  frankTag: Uint8Array;
  receipt: ServerFrankReceiptV1;
  commit: FrankCommitContextV1;
};

export type FrankVerifyResultV1 =
  | { ok: true; commitInputUtf8: string; receiptPayloadUtf8: string }
  | { ok: false; reason: "commit-mismatch" | "receipt-signature-invalid" };

/** Timing-safe сравнение тегов (жюри держит все секреты, но оракул не создаём из принципа). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Полная проверка жалобы жюри (franking.md §4.4). Метаданные receipt не принимаются
 * на веру: receiptPayload пересобирается из кортежа + полей receipt, любое расхождение
 * (подменённый messageUuid, чужой участник, другое время) ломает подпись сервера.
 */
export function verifyFrankedMessageV1(params: {
  sodium: Pick<SodiumModule, "crypto_sign_verify_detached">;
  tuple: FrankComplaintTupleV1;
  receiptSignature: Uint8Array;
  serverFrankingPublicKey: Uint8Array;
}): FrankVerifyResultV1 {
  const { tuple } = params;

  // Шаг 1: plaintext → commitInput → HMAC == frankTag.
  const commitInputUtf8 = frankCommitInputV1(tuple.commit, tuple.plaintextUtf8);
  const expectedTag = computeFrankTagV1(tuple.frankingKey, commitInputUtf8);
  if (!constantTimeEqual(expectedTag, tuple.frankTag)) {
    return { ok: false, reason: "commit-mismatch" };
  }

  // Шаги 2–3: подпись сервера над пересобранным payload (включает согласованность метаданных).
  const receiptPayloadUtf8 = frankReceiptPayloadV1({
    frankTagBase64Url: toBase64Url(tuple.frankTag),
    messageUuid: tuple.commit.messageUuid,
    conversationUuid: tuple.commit.conversationUuid,
    senderUserUuid: tuple.commit.senderUserUuid,
    receiverUserUuid: tuple.commit.receiverUserUuid,
    serverReceivedAt: tuple.receipt.serverReceivedAt,
  });
  const signatureValid = params.sodium.crypto_sign_verify_detached(
    params.receiptSignature,
    utf8Bytes(receiptPayloadUtf8),
    params.serverFrankingPublicKey,
  );
  if (!signatureValid) {
    return { ok: false, reason: "receipt-signature-invalid" };
  }

  return { ok: true, commitInputUtf8, receiptPayloadUtf8 };
}

/** AAD непрозрачного disclosureCiphertext (franking.md §4.7). */
export const FSCP_FRANKING_DISCLOSURE_AAD_V1 = "flora.fscp.franking-disclosure.v1";
export const FSCP_FRANKING_DISCLOSURE_NONCE_BYTES = 24;
export const FSCP_FRANKING_REPORT_CONTENT_KEY_BYTES = 32;

export type FrankingDisclosureSealV1 = {
  reportContentKey: Uint8Array;
  sealed: Uint8Array;
};

export type FrankingDisclosureSodium = {
  randombytes_buf(length: number): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secret_nonce: Uint8Array | null,
    ciphertext: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
};

/**
 * Шифрует кортеж жалобы на случайный reportContentKey.
 * Формат sealed: nonce (24) || ciphertext. Сервер видит только opaque bytes.
 */
export function sealFrankingDisclosureV1(
  sodium: FrankingDisclosureSodium,
  plaintext: Uint8Array,
): FrankingDisclosureSealV1 {
  const reportContentKey = sodium.randombytes_buf(FSCP_FRANKING_REPORT_CONTENT_KEY_BYTES);
  const nonce = sodium.randombytes_buf(FSCP_FRANKING_DISCLOSURE_NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    FSCP_FRANKING_DISCLOSURE_AAD_V1,
    null,
    nonce,
    reportContentKey,
  );
  const sealed = new Uint8Array(nonce.length + ciphertext.length);
  sealed.set(nonce, 0);
  sealed.set(ciphertext, nonce.length);
  return { reportContentKey, sealed };
}

export function openFrankingDisclosureV1(
  sodium: FrankingDisclosureSodium,
  sealed: Uint8Array,
  reportContentKey: Uint8Array,
): Uint8Array {
  if (sealed.length <= FSCP_FRANKING_DISCLOSURE_NONCE_BYTES) {
    throw new Error("franking disclosure слишком короткий.");
  }
  if (reportContentKey.length !== FSCP_FRANKING_REPORT_CONTENT_KEY_BYTES) {
    throw new Error("reportContentKey должен быть 32 байта.");
  }
  const nonce = sealed.subarray(0, FSCP_FRANKING_DISCLOSURE_NONCE_BYTES);
  const ciphertext = sealed.subarray(FSCP_FRANKING_DISCLOSURE_NONCE_BYTES);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    FSCP_FRANKING_DISCLOSURE_AAD_V1,
    nonce,
    reportContentKey,
  );
}

export type FscpBase64Sodium = Pick<SodiumModule, "to_base64" | "from_base64"> & {
  base64_variants?: { URLSAFE_NO_PADDING: number };
};

function sodiumUrlSafeVariant(sodium: FscpBase64Sodium): number {
  return sodium.base64_variants?.URLSAFE_NO_PADDING ?? URLSAFE_NO_PADDING;
}

/** Wire base64url без `btoa` — Hermes его не даёт. */
export function encodeFscpBase64Url(sodium: FscpBase64Sodium, bytes: Uint8Array): string {
  if (typeof sodium.to_base64 !== "function") {
    throw new Error("sodium.to_base64 недоступен.");
  }
  return sodium.to_base64(bytes, sodiumUrlSafeVariant(sodium));
}

export function decodeFscpBase64Url(sodium: FscpBase64Sodium, value: string): Uint8Array {
  if (typeof sodium.from_base64 !== "function") {
    throw new Error("sodium.from_base64 недоступен.");
  }
  return sodium.from_base64(value.trim(), sodiumUrlSafeVariant(sodium));
}

/** Кортеж жалобы в sealed disclosure (franking.md §4.4), плюс persisted UUID для POST. */
export type FrankingComplaintDisclosureV1 = {
  v: 1;
  plaintextUtf8Base64Url: string;
  frankingKeyBase64Url: string | null;
  frankTagBase64Url: string | null;
  serverFrankReceipt: ServerFrankReceiptV1 | null;
  messageUuid: string;
  persistedMessageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  receiverUserUuid: string;
  createdAt: string;
};

export type FrankingComplaintDisclosureInputV1 = {
  plaintextUtf8: Uint8Array;
  frankingKeyBase64Url: string | null;
  frankTagBase64Url: string | null;
  serverFrankReceipt: ServerFrankReceiptV1 | null;
  messageUuid: string;
  persistedMessageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  receiverUserUuid: string;
  createdAt: string;
};

function complaintDisclosureRecordV1(
  sodium: FscpBase64Sodium,
  input: FrankingComplaintDisclosureInputV1,
): FrankingComplaintDisclosureV1 {
  return {
    v: 1,
    plaintextUtf8Base64Url: encodeFscpBase64Url(sodium, input.plaintextUtf8),
    frankingKeyBase64Url: input.frankingKeyBase64Url,
    frankTagBase64Url: input.frankTagBase64Url,
    serverFrankReceipt: input.serverFrankReceipt,
    messageUuid: input.messageUuid,
    persistedMessageUuid: input.persistedMessageUuid,
    conversationUuid: input.conversationUuid,
    senderUserUuid: input.senderUserUuid,
    senderDeviceUuid: input.senderDeviceUuid,
    receiverUserUuid: input.receiverUserUuid,
    createdAt: input.createdAt,
  };
}

export function encodeFrankingComplaintDisclosureV1(
  sodium: FscpBase64Sodium,
  input: FrankingComplaintDisclosureInputV1,
): Uint8Array {
  return utf8Bytes(canonicalJson(complaintDisclosureRecordV1(sodium, input)));
}

export const FSCP_FRANKING_BUNDLE_MAX_MESSAGES = 20;

export type FrankingComplaintBundleV2 = {
  v: 2;
  bundleUuid: string;
  messages: FrankingComplaintDisclosureV1[];
};

export type FrankingComplaintBundleInputV2 = {
  bundleUuid: string;
  messages: readonly FrankingComplaintDisclosureInputV1[];
};

const FRANKING_BUNDLE_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FRANKING_BUNDLE_BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const FRANKING_BUNDLE_KEYS: readonly (keyof FrankingComplaintBundleV2)[] = [
  "v",
  "bundleUuid",
  "messages",
];
const FRANKING_BUNDLE_MESSAGE_KEYS: readonly (keyof FrankingComplaintDisclosureV1)[] = [
  "v",
  "plaintextUtf8Base64Url",
  "frankingKeyBase64Url",
  "frankTagBase64Url",
  "serverFrankReceipt",
  "messageUuid",
  "persistedMessageUuid",
  "conversationUuid",
  "senderUserUuid",
  "senderDeviceUuid",
  "receiverUserUuid",
  "createdAt",
];
const FRANKING_BUNDLE_RECEIPT_KEYS: readonly (keyof ServerFrankReceiptV1)[] = [
  "signatureBase64Url",
  "serverFrankingKeyId",
  "serverReceivedAt",
];

function bundleError(message: string): Error {
  return new Error(`franking complaint bundle v2: ${message}`);
}

function assertBundleExactKeys(
  obj: Record<string, unknown>,
  expected: readonly string[],
  objectName: string,
): void {
  const at = objectName ? `${objectName}: ` : "";
  for (const key of Object.keys(obj)) {
    if (!expected.includes(key)) throw bundleError(`${at}лишнее поле «${key}».`);
  }
  for (const key of expected) {
    if (!(key in obj)) throw bundleError(`${at}отсутствует поле «${key}».`);
  }
}

function readBundleString(
  obj: Record<string, unknown>,
  key: string,
  objectName: string,
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw bundleError(`${objectName}.${key}: ожидается строка.`);
  }
  return value;
}

function readBundleUuid(
  obj: Record<string, unknown>,
  key: string,
  objectName: string,
): string {
  const value = readBundleString(obj, key, objectName);
  if (!FRANKING_BUNDLE_UUID_RE.test(value)) {
    throw bundleError(`${objectName}.${key}: ожидается UUID в форме 8-4-4-4-12.`);
  }
  return value;
}

function readBundleBase64Url(
  obj: Record<string, unknown>,
  key: string,
  objectName: string,
): string {
  const value = readBundleString(obj, key, objectName);
  if (!FRANKING_BUNDLE_BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw bundleError(`${objectName}.${key}: не base64url без паддинга.`);
  }
  return value;
}

function readNullableBundleBase64Url(
  obj: Record<string, unknown>,
  key: string,
  objectName: string,
): string | null {
  return obj[key] === null ? null : readBundleBase64Url(obj, key, objectName);
}

function readBundleReceipt(
  raw: unknown,
  objectName: string,
): ServerFrankReceiptV1 | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw bundleError(`${objectName}: ожидается объект или null.`);
  }
  const receipt = raw as Record<string, unknown>;
  assertBundleExactKeys(receipt, FRANKING_BUNDLE_RECEIPT_KEYS, objectName);
  return {
    signatureBase64Url: readBundleBase64Url(receipt, "signatureBase64Url", objectName),
    serverFrankingKeyId: readBundleString(receipt, "serverFrankingKeyId", objectName),
    serverReceivedAt: readBundleString(receipt, "serverReceivedAt", objectName),
  };
}

function readBundleMessage(raw: unknown, index: number): FrankingComplaintDisclosureV1 {
  const objectName = `messages[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw bundleError(`${objectName}: ожидается JSON-объект.`);
  }
  const message = raw as Record<string, unknown>;
  if (message.v !== 1) {
    throw bundleError(`${objectName}.v=${JSON.stringify(message.v)} не поддерживается; ожидается v=1.`);
  }
  assertBundleExactKeys(message, FRANKING_BUNDLE_MESSAGE_KEYS, objectName);
  return {
    v: 1,
    plaintextUtf8Base64Url: readBundleBase64Url(
      message,
      "plaintextUtf8Base64Url",
      objectName,
    ),
    frankingKeyBase64Url: readNullableBundleBase64Url(
      message,
      "frankingKeyBase64Url",
      objectName,
    ),
    frankTagBase64Url: readNullableBundleBase64Url(message, "frankTagBase64Url", objectName),
    serverFrankReceipt: readBundleReceipt(
      message.serverFrankReceipt,
      `${objectName}.serverFrankReceipt`,
    ),
    messageUuid: readBundleUuid(message, "messageUuid", objectName),
    persistedMessageUuid: readBundleUuid(message, "persistedMessageUuid", objectName),
    conversationUuid: readBundleUuid(message, "conversationUuid", objectName),
    senderUserUuid: readBundleUuid(message, "senderUserUuid", objectName),
    senderDeviceUuid: readBundleUuid(message, "senderDeviceUuid", objectName),
    receiverUserUuid: readBundleUuid(message, "receiverUserUuid", objectName),
    createdAt: readBundleString(message, "createdAt", objectName),
  };
}

function assertFrankingBundleMessageCount(count: number): void {
  if (count < 1 || count > FSCP_FRANKING_BUNDLE_MAX_MESSAGES) {
    throw bundleError(
      `messages должен содержать от 1 до ${FSCP_FRANKING_BUNDLE_MAX_MESSAGES} сообщений; получено ${count}.`,
    );
  }
}

function assertFrankingBundleUuid(bundleUuid: string): void {
  if (!FRANKING_BUNDLE_UUID_RE.test(bundleUuid)) {
    throw bundleError("bundleUuid: ожидается UUID в форме 8-4-4-4-12.");
  }
}

export function encodeFrankingComplaintBundleV2(
  sodium: FscpBase64Sodium,
  input: FrankingComplaintBundleInputV2,
): Uint8Array {
  assertFrankingBundleUuid(input.bundleUuid);
  assertFrankingBundleMessageCount(input.messages.length);
  const bundle: FrankingComplaintBundleV2 = {
    v: 2,
    bundleUuid: input.bundleUuid,
    messages: input.messages.map((message) => complaintDisclosureRecordV1(sodium, message)),
  };
  return utf8Bytes(canonicalJson(bundle));
}

export function decodeFrankingComplaintBundleV2(bytes: Uint8Array): FrankingComplaintBundleV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw bundleError("байты не разбираются как JSON (обрезанный или повреждённый bundle).");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bundleError("ожидается JSON-объект.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 2) {
    throw bundleError(`версия v=${JSON.stringify(obj.v)} не поддерживается; ожидается v=2.`);
  }
  assertBundleExactKeys(obj, FRANKING_BUNDLE_KEYS, "");
  if (!Array.isArray(obj.messages)) {
    throw bundleError("messages: ожидается массив.");
  }
  assertFrankingBundleMessageCount(obj.messages.length);
  return {
    v: 2,
    bundleUuid: readBundleUuid(obj, "bundleUuid", "bundle"),
    messages: obj.messages.map((message, index) => readBundleMessage(message, index)),
  };
}

export type FrankingSealedReportV1 = {
  reportContentKey: Uint8Array;
  disclosureCiphertext: string;
};

export function sealFrankingComplaintDisclosureV1(
  sodium: FrankingDisclosureSodium & FscpBase64Sodium,
  input: FrankingComplaintDisclosureInputV1,
): FrankingSealedReportV1 {
  const { reportContentKey, sealed } = sealFrankingDisclosureV1(
    sodium,
    encodeFrankingComplaintDisclosureV1(sodium, input),
  );
  return {
    reportContentKey,
    disclosureCiphertext: encodeFscpBase64Url(sodium, sealed),
  };
}

export type FrankingSealedReportV2 = FrankingSealedReportV1 & {
  bundleUuid: string;
};

export function sealFrankingComplaintBundleV2(
  sodium: FrankingDisclosureSodium & FscpBase64Sodium,
  input: FrankingComplaintBundleInputV2,
): FrankingSealedReportV2 {
  const { reportContentKey, sealed } = sealFrankingDisclosureV1(
    sodium,
    encodeFrankingComplaintBundleV2(sodium, input),
  );
  return {
    bundleUuid: input.bundleUuid,
    reportContentKey,
    disclosureCiphertext: encodeFscpBase64Url(sodium, sealed),
  };
}

export const FSCP_FRANKING_WRAP_CONTEXT_V1 = "flora.fscp.franking-wrap.v1";
export const FSCP_FRANKING_WRAP_EPH_BYTES = 32;
export const FSCP_FRANKING_WRAP_SALT_BYTES = 32;
export const FSCP_FRANKING_WRAP_NONCE_BYTES = 24;

export function frankingWrapAadV1(params: {
  persistedMessageUuid: string;
  userUuid: string;
  deviceUuid: string;
}): string {
  return [
    FSCP_FRANKING_WRAP_CONTEXT_V1,
    params.persistedMessageUuid.toLowerCase(),
    params.userUuid.toLowerCase(),
    params.deviceUuid.toLowerCase(),
  ].join(" | ");
}

export type FrankingWrapTargetV1 = {
  userUuid: string;
  deviceUuid: string;
  agreementPublicKey: Uint8Array;
};

export type FrankingWrappedKeyV1 = {
  userUuid: string;
  deviceUuid: string;
  wrappedKey: string;
};

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type FrankingWrapSodium = FrankingDisclosureSodium & FscpBase64Sodium & SodiumModule;

export function wrapReportContentKeyV1(
  sodium: FrankingWrapSodium,
  params: {
    reportContentKey: Uint8Array;
    persistedMessageUuid: string;
    target: FrankingWrapTargetV1;
  },
): FrankingWrappedKeyV1 {
  if (params.reportContentKey.length !== FSCP_FRANKING_REPORT_CONTENT_KEY_BYTES) {
    throw new Error("reportContentKey должен быть 32 байта.");
  }
  const aadUtf8Line = frankingWrapAadV1({
    persistedMessageUuid: params.persistedMessageUuid,
    userUuid: params.target.userUuid,
    deviceUuid: params.target.deviceUuid,
  });
  const salt32 = sodium.randombytes_buf(FSCP_FRANKING_WRAP_SALT_BYTES);
  const wrapped = rkeWrapMessageKey({
    sodium,
    ephemeralSecret: sodium.randombytes_buf(FSCP_FRANKING_WRAP_EPH_BYTES),
    recipientAgreementPublicKey: params.target.agreementPublicKey,
    salt32,
    aadUtf8Line,
    messageKey32: params.reportContentKey,
  });
  const packed = concatBytes([
    wrapped.ephemeralPublicKey,
    salt32,
    wrapped.nonce,
    wrapped.ciphertext,
  ]);
  return {
    userUuid: params.target.userUuid,
    deviceUuid: params.target.deviceUuid,
    wrappedKey: encodeFscpBase64Url(sodium, packed),
  };
}

export function unwrapReportContentKeyV1(
  sodium: FrankingWrapSodium,
  params: {
    wrappedKey: string;
    persistedMessageUuid: string;
    userUuid: string;
    deviceUuid: string;
    agreementPrivateKey: Uint8Array;
  },
): Uint8Array {
  const packed = decodeFscpBase64Url(sodium, params.wrappedKey);
  const header =
    FSCP_FRANKING_WRAP_EPH_BYTES + FSCP_FRANKING_WRAP_SALT_BYTES + FSCP_FRANKING_WRAP_NONCE_BYTES;
  if (packed.length <= header) {
    throw new Error("franking wrap слишком короткий.");
  }
  return rkeUnwrapMessageKey({
    sodium,
    agreementPrivateKey: params.agreementPrivateKey,
    ephemeralPublicKey: packed.subarray(0, FSCP_FRANKING_WRAP_EPH_BYTES),
    salt32: packed.subarray(
      FSCP_FRANKING_WRAP_EPH_BYTES,
      FSCP_FRANKING_WRAP_EPH_BYTES + FSCP_FRANKING_WRAP_SALT_BYTES,
    ),
    aadUtf8Line: frankingWrapAadV1({
      persistedMessageUuid: params.persistedMessageUuid,
      userUuid: params.userUuid,
      deviceUuid: params.deviceUuid,
    }),
    nonce: packed.subarray(header - FSCP_FRANKING_WRAP_NONCE_BYTES, header),
    ciphertext: packed.subarray(header),
  });
}

export const FSCP_FRANKING_WRAP_CONTEXT_V2 = "flora.fscp.franking-wrap.v2";

export function frankingWrapAadV2(params: {
  bundleUuid: string;
  userUuid: string;
  deviceUuid: string;
}): string {
  return [
    FSCP_FRANKING_WRAP_CONTEXT_V2,
    params.bundleUuid.toLowerCase(),
    params.userUuid.toLowerCase(),
    params.deviceUuid.toLowerCase(),
  ].join(" | ");
}

export type FrankingWrapTargetV2 = FrankingWrapTargetV1;
export type FrankingWrappedKeyV2 = FrankingWrappedKeyV1;

export function wrapReportContentKeyV2(
  sodium: FrankingWrapSodium,
  params: {
    reportContentKey: Uint8Array;
    bundleUuid: string;
    target: FrankingWrapTargetV2;
  },
): FrankingWrappedKeyV2 {
  if (params.reportContentKey.length !== FSCP_FRANKING_REPORT_CONTENT_KEY_BYTES) {
    throw new Error("reportContentKey должен быть 32 байта.");
  }
  const aadUtf8Line = frankingWrapAadV2({
    bundleUuid: params.bundleUuid,
    userUuid: params.target.userUuid,
    deviceUuid: params.target.deviceUuid,
  });
  const salt32 = sodium.randombytes_buf(FSCP_FRANKING_WRAP_SALT_BYTES);
  const wrapped = rkeWrapMessageKey({
    sodium,
    ephemeralSecret: sodium.randombytes_buf(FSCP_FRANKING_WRAP_EPH_BYTES),
    recipientAgreementPublicKey: params.target.agreementPublicKey,
    salt32,
    aadUtf8Line,
    messageKey32: params.reportContentKey,
  });
  const packed = concatBytes([
    wrapped.ephemeralPublicKey,
    salt32,
    wrapped.nonce,
    wrapped.ciphertext,
  ]);
  return {
    userUuid: params.target.userUuid,
    deviceUuid: params.target.deviceUuid,
    wrappedKey: encodeFscpBase64Url(sodium, packed),
  };
}

export function unwrapReportContentKeyV2(
  sodium: FrankingWrapSodium,
  params: {
    wrappedKey: string;
    bundleUuid: string;
    userUuid: string;
    deviceUuid: string;
    agreementPrivateKey: Uint8Array;
  },
): Uint8Array {
  const packed = decodeFscpBase64Url(sodium, params.wrappedKey);
  const header =
    FSCP_FRANKING_WRAP_EPH_BYTES + FSCP_FRANKING_WRAP_SALT_BYTES + FSCP_FRANKING_WRAP_NONCE_BYTES;
  if (packed.length <= header) {
    throw new Error("franking wrap слишком короткий.");
  }
  return rkeUnwrapMessageKey({
    sodium,
    agreementPrivateKey: params.agreementPrivateKey,
    ephemeralPublicKey: packed.subarray(0, FSCP_FRANKING_WRAP_EPH_BYTES),
    salt32: packed.subarray(
      FSCP_FRANKING_WRAP_EPH_BYTES,
      FSCP_FRANKING_WRAP_EPH_BYTES + FSCP_FRANKING_WRAP_SALT_BYTES,
    ),
    aadUtf8Line: frankingWrapAadV2({
      bundleUuid: params.bundleUuid,
      userUuid: params.userUuid,
      deviceUuid: params.deviceUuid,
    }),
    nonce: packed.subarray(header - FSCP_FRANKING_WRAP_NONCE_BYTES, header),
    ciphertext: packed.subarray(header),
  });
}

export function assembleFrankingReportV1(
  sodium: FrankingWrapSodium,
  params: {
    complaint: FrankingComplaintDisclosureInputV1;
    wrapTargets: readonly FrankingWrapTargetV1[];
  },
): { disclosureCiphertext: string; wraps: FrankingWrappedKeyV1[] } {
  const sealed = sealFrankingComplaintDisclosureV1(sodium, params.complaint);
  const wraps = params.wrapTargets.map((target) =>
    wrapReportContentKeyV1(sodium, {
      reportContentKey: sealed.reportContentKey,
      persistedMessageUuid: params.complaint.persistedMessageUuid,
      target,
    }),
  );
  return { disclosureCiphertext: sealed.disclosureCiphertext, wraps };
}

export function assembleFrankingReportV2(
  sodium: FrankingWrapSodium,
  params: {
    bundleUuid?: string;
    messages: readonly FrankingComplaintDisclosureInputV1[];
    wrapTargets: readonly FrankingWrapTargetV2[];
  },
): { bundleUuid: string; disclosureCiphertext: string; wraps: FrankingWrappedKeyV2[] } {
  const bundleUuid = params.bundleUuid ?? floraNewUuid();
  const sealed = sealFrankingComplaintBundleV2(sodium, {
    bundleUuid,
    messages: params.messages,
  });
  const wraps = params.wrapTargets.map((target) =>
    wrapReportContentKeyV2(sodium, {
      reportContentKey: sealed.reportContentKey,
      bundleUuid,
      target,
    }),
  );
  return { bundleUuid, disclosureCiphertext: sealed.disclosureCiphertext, wraps };
}

/** Tagged v1.1+ без квитанции — не жаловаться (franking.md §4.3). Untagged v1 — unverifiable, можно. */
export function frankingReportBlockedByMissingReceipt(input: {
  frankTagBase64Url?: string | null;
  hasServerFrankReceipt: boolean;
}): boolean {
  return Boolean(input.frankTagBase64Url?.trim()) && !input.hasServerFrankReceipt;
}
