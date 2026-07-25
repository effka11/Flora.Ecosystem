export type Argon2idParams = {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputLength?: number;
};

export type KdfDeriveFn = (params: Argon2idParams) => Promise<Uint8Array>;

/**
 * Host-provided Argon2id (Web Worker / native JSI), so the 64 MiB derivation does not block
 * the main thread. Module-scope state lives here and NOT in sodium.ts on purpose: kdf.ts has
 * zero imports, so sodium.ts can read it without creating an import cycle.
 *
 * The main-thread `crypto_pwhash` path always stays available as a fallback — see
 * deriveKeyArgon2id in sodium.ts. A failing worker must degrade to "slow", never to "no keys".
 */
let _injectedKdf: KdfDeriveFn | null = null;

/** Pass null to go back to the built-in main-thread implementation. */
export function configureFscpKdf(fn: KdfDeriveFn | null): void {
  _injectedKdf = fn;
}

export function getConfiguredFscpKdf(): KdfDeriveFn | null {
  return _injectedKdf;
}
