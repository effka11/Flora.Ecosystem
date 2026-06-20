import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Bytes } from "./base64url.js";
import { getSodium, scalarmult, scalarmultBase } from "./sodium.js";

type Sodium = Awaited<ReturnType<typeof getSodium>>;

export function rkeWrapMessageKey(params: {
  sodium: Sodium;
  ephemeralSecret: Uint8Array;
  recipientAgreementPublicKey: Uint8Array;
  salt32: Uint8Array;
  aadUtf8Line: string;
  messageKey32: Uint8Array;
}): {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  wrapKey: Uint8Array;
} {
  const { sodium } = params;
  const ephemeralPublicKey = scalarmultBase(params.sodium, params.ephemeralSecret);
  const ss = scalarmult(params.sodium, params.ephemeralSecret, params.recipientAgreementPublicKey);
  const prk = extract(sha256, ss, params.salt32);
  const wrapKey = expand(sha256, prk, utf8Bytes(params.aadUtf8Line), 32);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    params.messageKey32,
    params.aadUtf8Line,
    null,
    nonce,
    wrapKey
  );
  return { ephemeralPublicKey, nonce, ciphertext, wrapKey };
}

export function rkeUnwrapMessageKey(params: {
  sodium: Sodium;
  agreementPrivateKey: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  salt32: Uint8Array;
  aadUtf8Line: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  const { sodium } = params;
  const ss = scalarmult(sodium, params.agreementPrivateKey, params.ephemeralPublicKey);
  const prk = extract(sha256, ss, params.salt32);
  const wrapKey = expand(sha256, prk, utf8Bytes(params.aadUtf8Line), 32);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    params.ciphertext,
    params.aadUtf8Line,
    params.nonce,
    wrapKey,
  );
}
