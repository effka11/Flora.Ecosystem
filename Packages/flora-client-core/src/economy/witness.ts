/**
 * Витнесс-косайны head журнала на клиенте (LIV.md §4) — зеркало
 * `flora-economy-crypto::witness`.
 *
 * Клиент проверяет косайны из STH-ответа: подпись валидна и ключ входит в реестр.
 * Совпадение head с историей журнала проверяет сервер при приёме (LIV.md §4.3);
 * клиентская политика кворума — уровень выше (LIV.md §4.2).
 */

import { FEP_LEDGER_STH } from "./domainTags.js";
import { EconomyCodecError, fromHex, toHex } from "./encoding.js";
import { headCanonicalBytes, parseLedgerHead, type LedgerHeadJson } from "./ledger.js";
import { publicKeyFromSeed, signDomainTagged, verifyDomainTagged } from "./sign.js";

/** Косайн: подпись витнесса над каноническими байтами head (hex-поля — транспорт). */
export type HeadCosignJson = {
  head: LedgerHeadJson;
  witness: string;
  signature: string;
};

/** Криптографическая проверка косайна: подпись действительна для заявленного head. */
export function verifyHeadCosign(cosign: HeadCosignJson): boolean {
  let payload: Uint8Array;
  let witness: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = headCanonicalBytes(cosign.head);
    witness = fromHex(cosign.witness, 32);
    signature = fromHex(cosign.signature, 64);
  } catch {
    return false;
  }
  return verifyDomainTagged(FEP_LEDGER_STH, payload, signature, witness);
}

/** Ключ косайна входит в реестр витнессов (hex-ключи, регистр не значим)? */
export function isRegisteredWitness(
  cosign: HeadCosignJson,
  witnessesHex: readonly string[],
): boolean {
  const key = cosign.witness.toLowerCase();
  return witnessesHex.some((w) => w.toLowerCase() === key);
}

/**
 * Подписать head ключом витнесса. На клиенте — для тестов и TS-витнессов;
 * reference-демон — `flora-economy-witness` (Rust).
 */
export function cosignHead(head: LedgerHeadJson, witnessSeed: Uint8Array): HeadCosignJson {
  return {
    head,
    witness: toHex(publicKeyFromSeed(witnessSeed)),
    signature: toHex(signDomainTagged(FEP_LEDGER_STH, headCanonicalBytes(head), witnessSeed)),
  };
}

/** Строгий разбор косайна из JSON (граница системы). */
export function parseHeadCosign(value: unknown): HeadCosignJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EconomyCodecError("HeadCosign: ожидался JSON-объект");
  }
  const o = value as Record<string, unknown>;
  if (typeof o.witness !== "string" || typeof o.signature !== "string") {
    throw new EconomyCodecError("HeadCosign: witness/signature обязаны быть hex-строками");
  }
  fromHex(o.witness, 32);
  fromHex(o.signature, 64);
  return {
    head: parseLedgerHead(o.head),
    witness: o.witness,
    signature: o.signature,
  };
}
