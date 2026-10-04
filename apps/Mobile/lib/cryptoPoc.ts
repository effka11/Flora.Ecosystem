/**
 * Mobile crypto PoC gate: react-native-libsodium + quick-crypto.
 * Run on device/emulator via `npx expo run:android` — skipped in plain Node CI.
 */
export const CRYPTO_POC_PRIMITIVES = [
  "crypto_box_keypair",
  "crypto_scalarmult",
  "crypto_aead_xchacha20poly1305_ietf",
  "crypto_pwhash_argon2id",
  "aes-gcm via quick-crypto",
] as const;
