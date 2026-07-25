/**
 * Shared Argon2id KDF Web Worker RPC client.
 *
 * One Worker instance for the whole app, used by both:
 *  - the FSCP SoT (`@flora/client-core/fscp` via `configureFscpKdf`, wired in `clientCore.ts`);
 *  - the divergent Apps/Web legacy copy (`keyBackup.ts`, used by recovery-phrase / settings UI).
 * Before this module existed each had its own `new Worker(...)`, i.e. two workers computing the
 * same 64 MiB Argon2id independently. See plan `fscp_restore_reliability` §web-wiring.
 *
 * Parallelism invariant: FSCP key backups are always sealed with Argon2id parallelism = 1 (see
 * Products/FSCP/ts/src/sodium.ts FSCP_ARGON2ID_PARALLELISM), and libsodium's `crypto_pwhash` has
 * no lane parameter at all — it is inherently single-lane. That means this worker cannot derive
 * with any other parallelism than the one FSCP requires, by construction; there is nothing to
 * configure or get wrong here.
 */

import { getSodium } from "./sodium";
import type { KdfWorkerRequest, KdfWorkerResponse } from "./kdfWorker";

let _workerInstance: Worker | null = null;
let _workerCounter = 0;
const _pendingKdf = new Map<
  string,
  { resolve: (key: string) => void; reject: (e: Error) => void }
>();

function getKdfWorker(): Worker {
  if (_workerInstance) return _workerInstance;
  _workerInstance = new Worker(new URL("./kdfWorker.ts", import.meta.url), { type: "module" });
  _workerInstance.addEventListener("message", (e: MessageEvent<KdfWorkerResponse>) => {
    const { id } = e.data;
    const pending = _pendingKdf.get(id);
    if (!pending) return;
    _pendingKdf.delete(id);
    if (e.data.ok) pending.resolve(e.data.keyBase64Url);
    else pending.reject(new Error(`KDF worker: ${e.data.error}`));
  });
  _workerInstance.addEventListener("error", (e) => {
    // Broadcast failure to all pending requests; every caller (SoT + legacy) falls back on its own.
    const err = new Error(`KDF worker fatal: ${e.message}`);
    for (const p of _pendingKdf.values()) p.reject(err);
    _pendingKdf.clear();
    _workerInstance = null;
  });
  return _workerInstance;
}

export type DeriveKeyArgon2idViaWorkerParams = {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  /** Output key length in bytes. Defaults to 32 (FSCP wrap-key size). */
  outputLength?: number;
};

/** Argon2id derivation delegated to the shared KDF worker. Rejects if the worker is unusable. */
export async function deriveKeyArgon2idViaWorker(
  params: DeriveKeyArgon2idViaWorkerParams,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
  const keyLen = params.outputLength ?? 32;

  const id = `kdf-${++_workerCounter}`;
  const request: KdfWorkerRequest = {
    id,
    passwordBase64Url: b64(params.passwordBytes),
    saltBase64Url: b64(params.salt),
    keyLen,
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
  };

  const keyBase64Url = await new Promise<string>((resolve, reject) => {
    _pendingKdf.set(id, { resolve, reject });
    try {
      getKdfWorker().postMessage(request);
    } catch (e) {
      _pendingKdf.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

  return sodium.from_base64(keyBase64Url, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * True only in a real browser where `Worker` can be constructed. SSR (no `window`/`Worker`) and
 * a CSP that forbids workers must both configure nothing rather than throw — the FSCP kernel's
 * `deriveKeyArgon2id` (sodium.ts) falls back to main-thread `crypto_pwhash` on its own and reports
 * `kdf_fallback_used`; a synchronous crash here would turn that graceful path into a hard failure.
 */
export function isKdfWorkerAvailable(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}
