/**
 * Ed25519-подписи над доменно-тегированным сообщением — зеркало
 * `flora-economy-crypto::sig` (RFC 8032, детерминированная схема).
 *
 * Сообщение — `label ‖ payload`: подпись перевода не может быть переиспользована как
 * подпись линии доверия и наоборот (FEP.md §9.2). Верификация строгая (не ZIP215) —
 * та же семантика принятия, что у `ed25519-dalek::verify` на сервере: консенсусный
 * путь обязан принимать и отвергать одни и те же байты на всех платформах.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { EconomyCodecError, utf8Bytes } from "./encoding.js";

/** Публичный ключ Ed25519 (32 байта). */
export type PublicKeyBytes = Uint8Array;

/** Подпись Ed25519 (64 байта). */
export type SignatureBytes = Uint8Array;

function domainMessage(label: string, payload: Uint8Array): Uint8Array {
  const labelBytes = utf8Bytes(label);
  const message = new Uint8Array(labelBytes.length + payload.length);
  message.set(labelBytes, 0);
  message.set(payload, labelBytes.length);
  return message;
}

/** Публичный ключ из 32-байтового seed. */
export function publicKeyFromSeed(seed: Uint8Array): PublicKeyBytes {
  if (seed.length !== 32) {
    throw new EconomyCodecError(`seed обязан быть 32 байта, получено ${seed.length}`);
  }
  return ed25519.getPublicKey(seed);
}

/** Подписать `payload` с доменной меткой `label` (детерминированно, RFC 8032). */
export function signDomainTagged(
  label: string,
  payload: Uint8Array,
  seed: Uint8Array,
): SignatureBytes {
  if (seed.length !== 32) {
    throw new EconomyCodecError(`seed обязан быть 32 байта, получено ${seed.length}`);
  }
  return ed25519.sign(domainMessage(label, payload), seed);
}

/** Проверить подпись над `label ‖ payload`. Любая некорректность входа — `false`. */
export function verifyDomainTagged(
  label: string,
  payload: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(signature, domainMessage(label, payload), publicKey, {
      zip215: false,
    });
  } catch {
    return false;
  }
}
