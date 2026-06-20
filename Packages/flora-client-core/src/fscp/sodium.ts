/** Injectable libsodium-compatible API for FSCP (web: libsodium-wrappers, mobile: react-native-libsodium). */
export type SodiumModule = {
  ready: Promise<void>;
  randombytes_buf(length: number): Uint8Array;
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_seed_keypair?(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_scalarmult?(n: Uint8Array, p: Uint8Array): Uint8Array;
  crypto_scalarmult_base?(n: Uint8Array): Uint8Array;
  crypto_sign_detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  crypto_sign_verify_detached(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ): boolean;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array | null,
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
  crypto_pwhash(
    outputLength: number,
    password: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash_SALTBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  base64_variants: { URLSAFE_NO_PADDING: number };
  from_base64(input: string, variant: number): Uint8Array;
  to_base64(input: Uint8Array, variant: number): string;
  from_string?(input: string): Uint8Array;
};

import { nobleScalarmult, nobleScalarmultBase } from "./x25519Compat.js";

let _loader: (() => Promise<SodiumModule>) | null = null;
let _sodiumRef: SodiumModule | null = null;

export function configureSodiumLoader(loader: () => Promise<SodiumModule>): void {
  _loader = loader;
  _sodiumRef = null;
}

export async function getSodium(): Promise<SodiumModule> {
  if (_sodiumRef) return _sodiumRef;
  if (!_loader) {
    throw new Error("configureSodiumLoader() must be called before FSCP crypto.");
  }
  const mod = await _loader();
  await mod.ready;
  _sodiumRef = mod;
  return _sodiumRef;
}

/** X25519 base point u = 9 (libsodium crypto_scalarmult_base). */
const X25519_BASEPOINT = new Uint8Array(32);
X25519_BASEPOINT[0] = 9;

/** Derive public key from scalar; falls back to @noble/curves on RN native. */
export function scalarmultBase(sodium: SodiumModule, scalar: Uint8Array): Uint8Array {
  const n = scalar.byteLength >= 32 ? scalar.subarray(0, 32) : scalar;
  if (typeof sodium.crypto_scalarmult_base === "function") {
    return sodium.crypto_scalarmult_base(n);
  }
  if (typeof sodium.crypto_scalarmult === "function") {
    return sodium.crypto_scalarmult(n, X25519_BASEPOINT);
  }
  return nobleScalarmultBase(n);
}

/** Montgomery u-coordinate n*P; falls back to @noble/curves on RN native. */
export function scalarmult(sodium: SodiumModule, scalar: Uint8Array, point: Uint8Array): Uint8Array {
  const n = scalar.byteLength >= 32 ? scalar.subarray(0, 32) : scalar;
  const p = point.byteLength >= 32 ? point.subarray(0, 32) : point;
  if (typeof sodium.crypto_scalarmult === "function") {
    return sodium.crypto_scalarmult(n, p);
  }
  return nobleScalarmult(n, p);
}

/** Argon2id KDF for key backup; requires sumo libsodium (crypto_pwhash). */
export async function deriveKeyArgon2id(params: {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  keyLen: number;
}): Promise<Uint8Array> {
  const sodium = await getSodium();
  const pwhash = sodium.crypto_pwhash;
  if (typeof pwhash !== "function") {
    throw new Error(
      "crypto_pwhash недоступен: для веба используйте libsodium-wrappers-sumo, " +
        "для мобилки — react-native-libsodium с нативным JSI.",
    );
  }
  return pwhash(
    params.keyLen,
    params.passwordBytes,
    params.salt,
    params.iterations,
    params.memoryKiB * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}
