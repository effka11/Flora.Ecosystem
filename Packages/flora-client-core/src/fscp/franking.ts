/**
 * Message franking v1 — эталонная реализация FSCP-FRANK (docs/fscp/franking.md).
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
import type { SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

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
