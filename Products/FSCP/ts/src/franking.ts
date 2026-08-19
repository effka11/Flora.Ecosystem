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

type FrankingDisclosureSodium = {
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

type FscpBase64Sodium = Pick<SodiumModule, "to_base64" | "from_base64"> & {
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

export function encodeFrankingComplaintDisclosureV1(
  sodium: FscpBase64Sodium,
  input: FrankingComplaintDisclosureInputV1,
): Uint8Array {
  const disclosure: FrankingComplaintDisclosureV1 = {
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
  return utf8Bytes(canonicalJson(disclosure));
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

/** Tagged v1.1+ без квитанции — не жаловаться (franking.md §4.3). Untagged v1 — unverifiable, можно. */
export function frankingReportBlockedByMissingReceipt(input: {
  frankTagBase64Url?: string | null;
  hasServerFrankReceipt: boolean;
}): boolean {
  return Boolean(input.frankTagBase64Url?.trim()) && !input.hasServerFrankReceipt;
}
