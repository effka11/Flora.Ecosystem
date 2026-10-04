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

import { getTelemetry } from "@flora/client-core/telemetry/index.js";
import { getConfiguredFscpKdf } from "./kdf.js";
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

export type DeriveKeyArgon2idParams = {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  keyLen: number;
};

/**
 * Upper bound for an injected KDF before we give up on it and derive on the main thread.
 * Argon2id at 64 MiB is well under a second on desktop and a few seconds on a weak phone, so
 * this only fires on a genuinely stuck worker. The cost of firing is doing the work twice —
 * the cost of not having it is an unlock that never completes.
 */
export const FSCP_INJECTED_KDF_TIMEOUT_MS = 10_000;

/**
 * FSCP key backups are always written with Argon2id parallelism = 1 (see createKeyBackup), and
 * libsodium's crypto_pwhash cannot do anything else. The injected KDF MUST use 1 as well: a
 * different lane count derives a different key, and the main-thread fallback would then silently
 * produce a key that does not match the one the backup was sealed with.
 */
const FSCP_ARGON2ID_PARALLELISM = 1;

/** Argon2id KDF for key backup; requires sumo libsodium (crypto_pwhash). */
async function deriveKeyArgon2idOnMainThread(params: DeriveKeyArgon2idParams): Promise<Uint8Array> {
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

/** Portable surface: bare ES2022 lib (no DOM / no @types/node), so timers come from globalThis. */
const hostTimers = globalThis as unknown as {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: unknown;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = hostTimers.setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) hostTimers.clearTimeout(timer);
    void promise.catch(() => {});
  }
}

/**
 * Argon2id KDF for key backup. Delegates to a host-injected implementation
 * (`configureFscpKdf`, e.g. a Web Worker) and ALWAYS falls back to main-thread `crypto_pwhash`
 * when that implementation throws, hangs or returns a key of the wrong length.
 *
 * The fallback is mandatory, not a nicety: a failed KDF means the key backup cannot be decrypted
 * at all, and asking the user for the password again does not help. Worker startup legitimately
 * fails (CSP forbids workers, SSR, exotic browser), and turning a slow-but-working path into a
 * hard failure would cost the user their keys. The degradation is silent to the user and visible
 * in telemetry (`kdf_fallback_used`).
 */
export async function deriveKeyArgon2id(params: DeriveKeyArgon2idParams): Promise<Uint8Array> {
  const injected = getConfiguredFscpKdf();
  if (!injected) return deriveKeyArgon2idOnMainThread(params);

  try {
    const derived = await withTimeout(
      injected({
        passwordBytes: params.passwordBytes,
        salt: params.salt,
        memoryKiB: params.memoryKiB,
        iterations: params.iterations,
        parallelism: FSCP_ARGON2ID_PARALLELISM,
        outputLength: params.keyLen,
      }),
      FSCP_INJECTED_KDF_TIMEOUT_MS,
      "FSCP: инъектированный KDF не ответил в отведённое время.",
    );
    if (derived instanceof Uint8Array && derived.byteLength === params.keyLen) {
      return derived;
    }
    getTelemetry().capture({ type: "kdf_fallback_used", reason: "invalid_output" });
  } catch {
    getTelemetry().capture({ type: "kdf_fallback_used", reason: "worker_failed" });
  }

  return deriveKeyArgon2idOnMainThread(params);
}
