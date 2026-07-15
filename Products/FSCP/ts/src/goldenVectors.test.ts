/**
 * Consumer-тесты golden-векторов FSCP (Documents/fscp/FSCP.md §Test vectors, «требование
 * потребления»): вектор без потребителя = невыполненный compliance-пункт.
 * Файлы Documents/test-vectors/** — regenerate-only, руками не редактировать.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeAll, describe, expect, it } from "vitest";
import { recipientKeyEnvelopeAadLine } from "./aad.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { agreementPublicKeyId, dmConversationUuid } from "./deriveIds.js";
import { rkeUnwrapMessageKey } from "./rke.js";
import { computeSafetyNumberV1, safetyNumberPreimageV1 } from "./safetyNumber.js";
import { configureSodiumLoader, scalarmult, scalarmultBase, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "docs", "test-vectors",
);

function loadVector<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(vectorsDir, name), "utf8")) as T;
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("golden: fscp-rke-wrap-key-v1.json", () => {
  type RkeVector = {
    vectorId: string;
    uuids: Record<string, string>;
    aadUtf8: string;
    aliceEphemeralPrivateKeyBase64Url: string;
    aliceEphemeralPublicKeyBase64Url: string;
    bobAgreementPrivateKeyBase64Url: string;
    bobAgreementPublicKeyBase64Url: string;
    x25519SharedSecretBase64Url: string;
    hkdfSaltBase64Url: string;
    wrapKeyBase64Url: string;
    messageKeyBase64Url: string;
    aead: { name: string; nonceBase64Url: string; ciphertextBase64Url: string };
  };
  const v = loadVector<RkeVector>("fscp-rke-wrap-key-v1.json");

  it("reproduces the AAD line byte-for-byte", () => {
    const u = v.uuids;
    const line = recipientKeyEnvelopeAadLine({
      conversationUuid: u.conversationUuid!,
      keyEpochId: u.keyEpochId!,
      messageUuid: u.messageUuid!,
      messageKeyId: u.messageKeyId!,
      senderUserUuid: u.senderUserUuid!,
      senderDeviceUuid: u.senderDeviceUuid!,
      recipientUserUuid: u.recipientUserUuid!,
      recipientDeviceUuid: u.recipientDeviceUuid!,
      recipientAgreementPublicKeyId: u.recipientAgreementPublicKeyId!,
    });
    expect(line).toBe(v.aadUtf8);
  });

  it("derives X25519 public keys and shared secret", () => {
    const alicePriv = fromBase64Url(v.aliceEphemeralPrivateKeyBase64Url);
    const bobPriv = fromBase64Url(v.bobAgreementPrivateKeyBase64Url);
    expect(toBase64Url(scalarmultBase(sodium, alicePriv))).toBe(v.aliceEphemeralPublicKeyBase64Url);
    expect(toBase64Url(scalarmultBase(sodium, bobPriv))).toBe(v.bobAgreementPublicKeyBase64Url);

    const ssAlice = scalarmult(sodium, alicePriv, fromBase64Url(v.bobAgreementPublicKeyBase64Url));
    const ssBob = scalarmult(sodium, bobPriv, fromBase64Url(v.aliceEphemeralPublicKeyBase64Url));
    expect(toBase64Url(ssAlice)).toBe(v.x25519SharedSecretBase64Url);
    expect(toBase64Url(ssBob)).toBe(v.x25519SharedSecretBase64Url);
  });

  it("derives the HKDF wrap key (info = AAD)", () => {
    const prk = extract(sha256, fromBase64Url(v.x25519SharedSecretBase64Url), fromBase64Url(v.hkdfSaltBase64Url));
    const wrapKey = expand(sha256, prk, utf8Bytes(v.aadUtf8), 32);
    expect(toBase64Url(wrapKey)).toBe(v.wrapKeyBase64Url);
  });

  it("encrypt with fixed nonce reproduces the golden ciphertext", () => {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      fromBase64Url(v.messageKeyBase64Url),
      v.aadUtf8,
      null,
      fromBase64Url(v.aead.nonceBase64Url),
      fromBase64Url(v.wrapKeyBase64Url),
    );
    expect(toBase64Url(ct)).toBe(v.aead.ciphertextBase64Url);
  });

  it("public unwrap API recovers the 32-byte messageKey", () => {
    const messageKey = rkeUnwrapMessageKey({
      sodium,
      agreementPrivateKey: fromBase64Url(v.bobAgreementPrivateKeyBase64Url),
      ephemeralPublicKey: fromBase64Url(v.aliceEphemeralPublicKeyBase64Url),
      salt32: fromBase64Url(v.hkdfSaltBase64Url),
      aadUtf8Line: v.aadUtf8,
      nonce: fromBase64Url(v.aead.nonceBase64Url),
      ciphertext: fromBase64Url(v.aead.ciphertextBase64Url),
    });
    expect(messageKey.length).toBe(32);
    expect(toBase64Url(messageKey)).toBe(v.messageKeyBase64Url);
  });

  it("rejects a tampered AAD (negative)", () => {
    expect(() =>
      rkeUnwrapMessageKey({
        sodium,
        agreementPrivateKey: fromBase64Url(v.bobAgreementPrivateKeyBase64Url),
        ephemeralPublicKey: fromBase64Url(v.aliceEphemeralPublicKeyBase64Url),
        salt32: fromBase64Url(v.hkdfSaltBase64Url),
        aadUtf8Line: v.aadUtf8.replace("recipient-key-envelope.v1", "recipient-key-envelope.v2"),
        nonce: fromBase64Url(v.aead.nonceBase64Url),
        ciphertext: fromBase64Url(v.aead.ciphertextBase64Url),
      }),
    ).toThrow();
  });
});

describe("golden: fingerprint-v1.json (safety number)", () => {
  type FingerprintVector = {
    keyEpochId: string;
    conversationUuid: string;
    epochAccountIdentityPublicKeysBase64UrlSorted: string[];
    preimageUtf8: string;
    fingerprintSha256Hex: string;
  };
  const v = loadVector<FingerprintVector>("fingerprint-v1.json");
  const [pk1, pk2] = v.epochAccountIdentityPublicKeysBase64UrlSorted;

  it("reproduces the preimage regardless of participant order", () => {
    const base = {
      keyEpochId: v.keyEpochId,
      conversationUuid: v.conversationUuid,
    };
    const direct = safetyNumberPreimageV1({
      ...base,
      identityPublicKeyA: fromBase64Url(pk1!),
      identityPublicKeyB: fromBase64Url(pk2!),
    });
    const swapped = safetyNumberPreimageV1({
      ...base,
      identityPublicKeyA: fromBase64Url(pk2!),
      identityPublicKeyB: fromBase64Url(pk1!),
    });
    expect(direct).toBe(v.preimageUtf8);
    expect(swapped).toBe(v.preimageUtf8);
  });

  it("computes the golden SHA-256 fingerprint", () => {
    const hex = computeSafetyNumberV1({
      keyEpochId: v.keyEpochId,
      conversationUuid: v.conversationUuid,
      identityPublicKeyA: fromBase64Url(pk2!),
      identityPublicKeyB: fromBase64Url(pk1!),
    });
    expect(hex).toBe(v.fingerprintSha256Hex);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("golden: backend-parity/uuid-v1.json (клиент ↔ C#-эталон)", () => {
  type UuidVector = {
    dmConversationUuid: { userA: string; userB: string; expected: string }[];
    agreementPublicKeyId: { userUuid: string; keyEpochId: string; expected: string }[];
  };
  const v = loadVector<UuidVector>(path.join("backend-parity", "uuid-v1.json"));

  it("dmConversationUuid matches the C# reference for every case", () => {
    for (const c of v.dmConversationUuid) {
      expect(dmConversationUuid(c.userA, c.userB), `userA=${c.userA} userB=${c.userB}`).toBe(c.expected);
    }
  });

  it("agreementPublicKeyId matches the C# reference for every case", () => {
    for (const c of v.agreementPublicKeyId) {
      expect(agreementPublicKeyId(c.userUuid, c.keyEpochId)).toBe(c.expected);
    }
  });
});
