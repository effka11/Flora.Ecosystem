import { x25519 } from "@noble/curves/ed25519";

/** X25519 scalarmult_base when libsodium binding is unavailable (RN native). */
export function nobleScalarmultBase(scalar: Uint8Array): Uint8Array {
  const n = scalar.byteLength >= 32 ? scalar.subarray(0, 32) : scalar;
  return x25519.getPublicKey(n);
}

/** X25519 scalarmult when libsodium binding is unavailable (RN native). */
export function nobleScalarmult(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  const n = scalar.byteLength >= 32 ? scalar.subarray(0, 32) : scalar;
  const p = point.byteLength >= 32 ? point.subarray(0, 32) : point;
  return x25519.scalarMult(n, p);
}
