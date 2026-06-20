/**
 * Web Worker: runs Argon2id key derivation off the main thread.
 * Loaded by keyBackup.ts via:
 *   new Worker(new URL('./kdfWorker.ts', import.meta.url), { type: 'module' })
 *
 * All keys are passed as base64url strings to avoid Transferable complexity.
 */

import libsodium from "libsodium-wrappers-sumo";

export type KdfWorkerRequest = {
  /** Correlation ID so the caller can match responses. */
  id: string;
  /** UTF-8 password encoded as base64url (the caller encodes). */
  passwordBase64Url: string;
  /** 16-byte Argon2id salt as base64url. */
  saltBase64Url: string;
  /** Output key length in bytes. */
  keyLen: number;
  /** Argon2id memory in KiB (e.g. 65536 = 64 MiB). */
  memoryKiB: number;
  /** Argon2id time cost (iterations). */
  iterations: number;
};

export type KdfWorkerResponse =
  | { id: string; ok: true; keyBase64Url: string }
  | { id: string; ok: false; error: string };

self.addEventListener("message", async (e: MessageEvent<KdfWorkerRequest>) => {
  const { id, passwordBase64Url, saltBase64Url, keyLen, memoryKiB, iterations } =
    e.data;
  try {
    await libsodium.ready;
    const sodium = libsodium;

    const pwBytes = sodium.from_base64(
      passwordBase64Url,
      sodium.base64_variants.URLSAFE_NO_PADDING
    );
    const saltBytes = sodium.from_base64(
      saltBase64Url,
      sodium.base64_variants.URLSAFE_NO_PADDING
    );

    const key = sodium.crypto_pwhash(
      keyLen,
      pwBytes,
      saltBytes,
      iterations,
      memoryKiB * 1024,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    const keyBase64Url = sodium.to_base64(
      key,
      sodium.base64_variants.URLSAFE_NO_PADDING
    );

    const response: KdfWorkerResponse = { id, ok: true, keyBase64Url };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: KdfWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
});
