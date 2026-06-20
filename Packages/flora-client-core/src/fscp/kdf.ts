export type Argon2idParams = {
  passwordBytes: Uint8Array;
  salt: Uint8Array;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  outputLength?: number;
};

export type KdfDeriveFn = (params: Argon2idParams) => Promise<Uint8Array>;
