/**
 * Safety number (fingerprint) v1 — Documents/fscp/FSCP.md §Safety number.
 * Два клиента при одинаковых входах обязаны получить одинаковый hex; сверка OOB.
 * Golden: Documents/test-vectors/fingerprint-v1.json (consumer: goldenVectors.test.ts).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { utf8Bytes } from "./base64url.js";
import { toBase64Url } from "./unlockFlow.js";

export const FSCP_SAFETY_NUMBER_CONTEXT_V1 = "flora.fscp.v1.safety-number";

/** memcmp: лексикографическое сравнение байтов (порядок pk_low/pk_high в preimage). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export type SafetyNumberInputV1 = {
  keyEpochId: string;
  conversationUuid: string;
  /** Ed25519 epoch account identity public key участника A (32 байта). */
  identityPublicKeyA: Uint8Array;
  /** Ed25519 epoch account identity public key участника B (32 байта). */
  identityPublicKeyB: Uint8Array;
};

export function safetyNumberPreimageV1(input: SafetyNumberInputV1): string {
  if (input.identityPublicKeyA.length !== 32 || input.identityPublicKeyB.length !== 32) {
    throw new Error("Safety number: identity public key должен быть 32 байта.");
  }
  const [low, high] =
    compareBytes(input.identityPublicKeyA, input.identityPublicKeyB) <= 0
      ? [input.identityPublicKeyA, input.identityPublicKeyB]
      : [input.identityPublicKeyB, input.identityPublicKeyA];
  return [
    FSCP_SAFETY_NUMBER_CONTEXT_V1,
    input.keyEpochId.toLowerCase(),
    input.conversationUuid.toLowerCase(),
    toBase64Url(low),
    toBase64Url(high),
  ].join("|");
}

/** Возвращает lowercase hex SHA-256 (64 символа) от UTF-8 preimage. */
export function computeSafetyNumberV1(input: SafetyNumberInputV1): string {
  return bytesToHex(sha256(utf8Bytes(safetyNumberPreimageV1(input))));
}

/** Группировка для UI: "aabbcc… → aabb ccdd …" (8 групп по 8 hex на строку — решает UI). */
export function formatSafetyNumberGroups(hex64: string, groupSize = 8): string[] {
  const groups: string[] = [];
  for (let i = 0; i < hex64.length; i += groupSize) {
    groups.push(hex64.slice(i, i + groupSize));
  }
  return groups;
}
