/**
 * Кошелёк LIV (LIV.md §3): ключи Ed25519 живут **на устройстве**, сервер видит только
 * публичный ключ. Кошелёк строит канонические байты транзакции (бит-в-бит с ядром,
 * проверено golden-векторами) и подписывает локально; наружу уходят hex-поля для
 * HTTP API — секретный seed не покидает процесс.
 *
 * Nonce (16 байт) — криптографически случайный, одноразовый на весь журнал:
 * потерянный ответ сервера безопасно ретраится тем же nonce (идемпотентность).
 */

import {
  FEP_CREDIT_TRANSFER_AUTH,
  FEP_TRANSFER_AUTH,
  FEP_TRUSTLINE_AUTH,
} from "./domainTags.js";
import { compareBytes, toHex } from "./encoding.js";
import {
  accountBytesFromUuid,
  creditTransferSigningBytes,
  transferSigningBytes,
  trustlineSigningBytes,
} from "./ledger.js";
import { publicKeyFromSeed, signDomainTagged } from "./sign.js";

function cryptoApi(): Crypto {
  const api = globalThis.crypto;
  if (!api || typeof api.getRandomValues !== "function") {
    throw new Error(
      "Кошельку LIV требуется WebCrypto (crypto.getRandomValues): генерация ключей и nonce без CSPRNG запрещена.",
    );
  }
  return api;
}

/** Сгенерировать seed ключа владения (32 байта, CSPRNG платформы). */
export function generateWalletSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  cryptoApi().getRandomValues(seed);
  return seed;
}

/** Сгенерировать одноразовый nonce транзакции (16 байт, CSPRNG платформы). */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(16);
  cryptoApi().getRandomValues(nonce);
  return nonce;
}

/** Публичный ключ владения (hex) — для `POST /api/economy/accounts` при онбординге. */
export function ownerKeyHexFromSeed(seed: Uint8Array): string {
  return toHex(publicKeyFromSeed(seed));
}

/** Канонический порядок пары аккаунтов (лексикографический по байтам id, FEP §4.1). */
export function canonicalPairUuids(a: string, b: string): [string, string] {
  const bytesA = accountBytesFromUuid(a);
  const bytesB = accountBytesFromUuid(b);
  return compareBytes(bytesA, bytesB) <= 0 ? [a, b] : [b, a];
}

/** Подписанный перевод — тело `POST /api/economy/transfers`. */
export type SignedTransfer = {
  fromUuid: string;
  toUuid: string;
  amountGrains: bigint;
  nonceHex: string;
  signatureHex: string;
};

/** Построить и подписать перевод LIV (LIV.md §3.3: канонические байты + Ed25519). */
export function authorizeTransfer(input: {
  seed: Uint8Array;
  fromUuid: string;
  toUuid: string;
  amountGrains: bigint;
  /** Одноразовый nonce; по умолчанию генерируется CSPRNG. Для ретрая передайте прежний. */
  nonce?: Uint8Array;
}): SignedTransfer {
  const nonce = input.nonce ?? generateNonce();
  const payload = transferSigningBytes(
    accountBytesFromUuid(input.fromUuid),
    accountBytesFromUuid(input.toUuid),
    input.amountGrains,
    nonce,
  );
  return {
    fromUuid: input.fromUuid,
    toUuid: input.toUuid,
    amountGrains: input.amountGrains,
    nonceHex: toHex(nonce),
    signatureHex: toHex(signDomainTagged(FEP_TRANSFER_AUTH, payload, input.seed)),
  };
}

/**
 * Подпись одной стороны линии доверия. Обе стороны подписывают **одни и те же**
 * канонические байты (lo/hi — канонический порядок пары); сервер требует обе подписи.
 */
export function signTrustline(input: {
  seed: Uint8Array;
  loUuid: string;
  hiUuid: string;
  limitLoToHiGrains: bigint;
  limitHiToLoGrains: bigint;
}): string {
  const [lo, hi] = canonicalPairUuids(input.loUuid, input.hiUuid);
  if (lo !== input.loUuid || hi !== input.hiUuid) {
    throw new Error(
      "Линия доверия подписывается в каноническом порядке пары (lo < hi по байтам id); поменяйте стороны местами.",
    );
  }
  const payload = trustlineSigningBytes(
    accountBytesFromUuid(lo),
    accountBytesFromUuid(hi),
    input.limitLoToHiGrains,
    input.limitHiToLoGrains,
  );
  return toHex(signDomainTagged(FEP_TRUSTLINE_AUTH, payload, input.seed));
}

/** Подписанный платёж по цепочке доверия — тело `POST /api/economy/credit-transfers`. */
export type SignedCreditTransfer = {
  pathUuids: string[];
  amountGrains: bigint;
  nonceHex: string;
  signatureHex: string;
};

/** Построить и подписать платёж по цепочке линий доверия (подписывает плательщик — path[0]). */
export function authorizeCreditTransfer(input: {
  seed: Uint8Array;
  pathUuids: string[];
  amountGrains: bigint;
  nonce?: Uint8Array;
}): SignedCreditTransfer {
  const nonce = input.nonce ?? generateNonce();
  const payload = creditTransferSigningBytes(
    input.pathUuids.map(accountBytesFromUuid),
    input.amountGrains,
    nonce,
  );
  return {
    pathUuids: [...input.pathUuids],
    amountGrains: input.amountGrains,
    nonceHex: toHex(nonce),
    signatureHex: toHex(signDomainTagged(FEP_CREDIT_TRANSFER_AUTH, payload, input.seed)),
  };
}
