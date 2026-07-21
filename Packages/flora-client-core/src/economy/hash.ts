/**
 * SHA-256 tagged-хеши FEP — зеркало `flora-economy-crypto::hash`.
 *
 * Все хеши валютного слоя — над доменно-тегированным входом: `SHA-256(label ‖ data…)`.
 * SHA-256 зафиксирован протоколом v1 (FEP.md §9.1); смена хеша = FEP v2.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Bytes } from "./encoding.js";

/** 32-байтовый дайджест. */
export type Hash32 = Uint8Array;

/** Нулевой хеш — родитель genesis-записи. */
export function zeroHash(): Hash32 {
  return new Uint8Array(32);
}

/** `SHA-256(label ‖ part₀ ‖ part₁ ‖ …)` — зеркало `hash::tagged` / `hash::tagged_parts`. */
export function sha256Tagged(label: string, ...parts: Uint8Array[]): Hash32 {
  const hasher = sha256.create();
  hasher.update(utf8Bytes(label));
  for (const part of parts) {
    hasher.update(part);
  }
  return hasher.digest();
}
