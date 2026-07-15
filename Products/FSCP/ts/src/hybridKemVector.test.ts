/**
 * Consumer golden-вектора fscp-hybrid-kem-v2draft-v1.json — прототип гибридного
 * пост-квантового KEM X25519 + ML-KEM-768 (FSCP.md §Целевой алгоритм → Post-quantum).
 *
 * Статус: v2-draft. В норму v1 не входит, wire v1 не меняет, продакшн-кода не добавляет:
 * ML-KEM живёт только в devDependency @noble/post-quantum, классическая часть
 * (HKDF/X25519/XChaCha20-Poly1305) — те же продакшн-примитивы, что в rke.ts.
 *
 * Три независимые реализации ML-KEM: kyber-py (генератор) ↔ @noble/post-quantum (этот
 * тест) ↔ RustCrypto ml-kem (Backend/Tests/parity/tests/fscp_hybrid_kem_vectors.rs).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { configureSodiumLoader, scalarmult, scalarmultBase, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "docs", "test-vectors",
);

type HybridVector = {
  vectorId: string;
  fscpProtocolVersion: string;
  algorithm: string;
  combiner: {
    ikmOrder: string;
    transcriptPrefixUtf8: string;
    hkdfInfoIsAad: boolean;
    aadPrefixUtf8: string;
  };
  uuids: Record<string, string>;
  x25519: {
    aliceEphemeralPrivateKeyBase64Url: string;
    aliceEphemeralPublicKeyBase64Url: string;
    bobAgreementPrivateKeyBase64Url: string;
    bobAgreementPublicKeyBase64Url: string;
    sharedSecretBase64Url: string;
  };
  mlKem768: {
    keygenSeedBase64Url: string;
    encapsulationKeyBase64Url: string;
    decapsulationKeyExpandedBase64Url: string;
    encapsMSeedBase64Url: string;
    ciphertextBase64Url: string;
    sharedSecretBase64Url: string;
  };
  hybrid: {
    transcriptHashBase64Url: string;
    aadUtf8: string;
    hkdfSaltBase64Url: string;
    ikmBase64Url: string;
    wrapKeyBase64Url: string;
  };
  aead: { name: string; messageKeyBase64Url: string; nonceBase64Url: string; ciphertextBase64Url: string };
  negativeCases: {
    caseId: string;
    tamperedCiphertextBase64Url?: string;
    impliedSharedSecretBase64Url?: string;
    tamperedTranscriptHashBase64Url?: string;
    tamperedAadUtf8?: string;
    mismatchedAadUtf8?: string;
    expected: string;
  }[];
};

const v = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-hybrid-kem-v2draft-v1.json"), "utf8"),
) as HybridVector;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

function transcriptHash(ephPub: Uint8Array, agrPub: Uint8Array, ek: Uint8Array, ct: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8Bytes(v.combiner.transcriptPrefixUtf8), ephPub, agrPub, ek, ct));
}

function aadLine(uuids: Record<string, string>, thB64u: string): string {
  const u = (k: string) => uuids[k]!;
  return (
    `${v.combiner.aadPrefixUtf8} | ` +
    `${u("conversationUuid")} | ${u("keyEpochId")} | ${u("messageUuid")} | ${u("messageKeyId")} | ` +
    `${u("senderUserUuid")} | ${u("senderDeviceUuid")} | ${u("recipientUserUuid")} | ` +
    `${u("recipientDeviceUuid")} | ${u("recipientAgreementPublicKeyId")} | ` +
    `${u("recipientMlKemEncapsulationKeyId")} | pq:${thB64u}`
  );
}

function hybridWrapKey(ssX: Uint8Array, ssPq: Uint8Array, aadUtf8: string): Uint8Array {
  const prk = extract(sha256, concatBytes(ssX, ssPq), fromBase64Url(v.hybrid.hkdfSaltBase64Url));
  return expand(sha256, prk, utf8Bytes(aadUtf8), 32);
}

describe("golden: fscp-hybrid-kem-v2draft-v1.json (X25519 + ML-KEM-768, прототип v2)", () => {
  it("вектор объявлен как v2-draft и не претендует на норму v1", () => {
    expect(v.fscpProtocolVersion).toBe("2-draft");
    expect(v.combiner.ikmOrder).toBe("ss_x25519 || ss_mlkem");
    expect(v.combiner.hkdfInfoIsAad).toBe(true);
  });

  it("ML-KEM-768: keygen из seed (d||z) воспроизводит ek и expanded dk", () => {
    const seed = fromBase64Url(v.mlKem768.keygenSeedBase64Url);
    expect(seed.length).toBe(64);
    const kp = ml_kem768.keygen(seed);
    expect(toBase64Url(kp.publicKey)).toBe(v.mlKem768.encapsulationKeyBase64Url);
    expect(toBase64Url(kp.secretKey)).toBe(v.mlKem768.decapsulationKeyExpandedBase64Url);
  });

  it("ML-KEM-768: детерминированный encaps(ek, m) воспроизводит ct и ss", () => {
    const ek = fromBase64Url(v.mlKem768.encapsulationKeyBase64Url);
    const m = fromBase64Url(v.mlKem768.encapsMSeedBase64Url);
    const enc = ml_kem768.encapsulate(ek, m);
    expect(toBase64Url(enc.cipherText)).toBe(v.mlKem768.ciphertextBase64Url);
    expect(toBase64Url(enc.sharedSecret)).toBe(v.mlKem768.sharedSecretBase64Url);
  });

  it("ML-KEM-768: decaps(dk, ct) возвращает тот же ss", () => {
    const dk = fromBase64Url(v.mlKem768.decapsulationKeyExpandedBase64Url);
    const ct = fromBase64Url(v.mlKem768.ciphertextBase64Url);
    const ss = ml_kem768.decapsulate(ct, dk);
    expect(toBase64Url(ss)).toBe(v.mlKem768.sharedSecretBase64Url);
  });

  it("X25519-компонента: публичные ключи и ss с обеих сторон", () => {
    const alicePriv = fromBase64Url(v.x25519.aliceEphemeralPrivateKeyBase64Url);
    const bobPriv = fromBase64Url(v.x25519.bobAgreementPrivateKeyBase64Url);
    expect(toBase64Url(scalarmultBase(sodium, alicePriv))).toBe(v.x25519.aliceEphemeralPublicKeyBase64Url);
    expect(toBase64Url(scalarmultBase(sodium, bobPriv))).toBe(v.x25519.bobAgreementPublicKeyBase64Url);

    const ssAlice = scalarmult(sodium, alicePriv, fromBase64Url(v.x25519.bobAgreementPublicKeyBase64Url));
    const ssBob = scalarmult(sodium, bobPriv, fromBase64Url(v.x25519.aliceEphemeralPublicKeyBase64Url));
    expect(toBase64Url(ssAlice)).toBe(v.x25519.sharedSecretBase64Url);
    expect(toBase64Url(ssBob)).toBe(v.x25519.sharedSecretBase64Url);
  });

  it("transcript hash связывает ephPub, agreementPub, ek и ct; AAD воспроизводится", () => {
    const th = transcriptHash(
      fromBase64Url(v.x25519.aliceEphemeralPublicKeyBase64Url),
      fromBase64Url(v.x25519.bobAgreementPublicKeyBase64Url),
      fromBase64Url(v.mlKem768.encapsulationKeyBase64Url),
      fromBase64Url(v.mlKem768.ciphertextBase64Url),
    );
    expect(toBase64Url(th)).toBe(v.hybrid.transcriptHashBase64Url);
    expect(aadLine(v.uuids, toBase64Url(th))).toBe(v.hybrid.aadUtf8);
  });

  it("гибридный KDF: IKM = ss_x25519 || ss_mlkem, HKDF-SHA-256(info=AAD) → wrapKey", () => {
    const ssX = fromBase64Url(v.x25519.sharedSecretBase64Url);
    const ssPq = fromBase64Url(v.mlKem768.sharedSecretBase64Url);
    expect(toBase64Url(concatBytes(ssX, ssPq))).toBe(v.hybrid.ikmBase64Url);
    expect(toBase64Url(hybridWrapKey(ssX, ssPq, v.hybrid.aadUtf8))).toBe(v.hybrid.wrapKeyBase64Url);
  });

  it("AEAD с фиксированным nonce воспроизводит ciphertext; unwrap возвращает messageKey", () => {
    const wrapKey = fromBase64Url(v.hybrid.wrapKeyBase64Url);
    const nonce = fromBase64Url(v.aead.nonceBase64Url);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      fromBase64Url(v.aead.messageKeyBase64Url),
      v.hybrid.aadUtf8,
      null,
      nonce,
      wrapKey,
    );
    expect(toBase64Url(ct)).toBe(v.aead.ciphertextBase64Url);

    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(v.aead.ciphertextBase64Url),
      v.hybrid.aadUtf8,
      nonce,
      wrapKey,
    );
    expect(toBase64Url(pt)).toBe(v.aead.messageKeyBase64Url);
  });

  it("негатив mlkem_ciphertext_tampered: implicit rejection FIPS 203 + падение AEAD", () => {
    const neg = v.negativeCases.find((c) => c.caseId === "mlkem_ciphertext_tampered")!;
    const dk = fromBase64Url(v.mlKem768.decapsulationKeyExpandedBase64Url);
    const tamperedCt = fromBase64Url(neg.tamperedCiphertextBase64Url!);

    // Decaps подменённого ct не бросает, а даёт K̄ = J(z||c) — сверяем с эталоном kyber-py.
    const implied = ml_kem768.decapsulate(tamperedCt, dk);
    expect(toBase64Url(implied)).toBe(neg.impliedSharedSecretBase64Url);
    expect(toBase64Url(implied)).not.toBe(v.mlKem768.sharedSecretBase64Url);

    // Транскрипт-хэш получателя тоже расходится — фиксируем и его.
    const tamperedTh = transcriptHash(
      fromBase64Url(v.x25519.aliceEphemeralPublicKeyBase64Url),
      fromBase64Url(v.x25519.bobAgreementPublicKeyBase64Url),
      fromBase64Url(v.mlKem768.encapsulationKeyBase64Url),
      tamperedCt,
    );
    expect(toBase64Url(tamperedTh)).toBe(neg.tamperedTranscriptHashBase64Url);
    expect(aadLine(v.uuids, toBase64Url(tamperedTh))).toBe(neg.tamperedAadUtf8);

    const receiverWrapKey = hybridWrapKey(
      fromBase64Url(v.x25519.sharedSecretBase64Url),
      implied,
      neg.tamperedAadUtf8!,
    );
    expect(() =>
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        fromBase64Url(v.aead.ciphertextBase64Url),
        neg.tamperedAadUtf8!,
        fromBase64Url(v.aead.nonceBase64Url),
        receiverWrapKey,
      ),
    ).toThrow();
  });

  it("негатив aad_metadata_mismatch: чужой recipientDeviceUuid роняет расшифровку", () => {
    const neg = v.negativeCases.find((c) => c.caseId === "aad_metadata_mismatch")!;
    const wrapKey = hybridWrapKey(
      fromBase64Url(v.x25519.sharedSecretBase64Url),
      fromBase64Url(v.mlKem768.sharedSecretBase64Url),
      neg.mismatchedAadUtf8!,
    );
    expect(() =>
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        fromBase64Url(v.aead.ciphertextBase64Url),
        neg.mismatchedAadUtf8!,
        fromBase64Url(v.aead.nonceBase64Url),
        wrapKey,
      ),
    ).toThrow();
  });

  it("размеры ML-KEM-768 соответствуют FIPS 203 и укладываются в лимит RKE 8 KiB", () => {
    expect(fromBase64Url(v.mlKem768.encapsulationKeyBase64Url).length).toBe(1184);
    expect(fromBase64Url(v.mlKem768.decapsulationKeyExpandedBase64Url).length).toBe(2400);
    expect(fromBase64Url(v.mlKem768.ciphertextBase64Url).length).toBe(1088);
    expect(fromBase64Url(v.mlKem768.sharedSecretBase64Url).length).toBe(32);
    // Гибридный RKE: X25519 ephPub (32) + ML-KEM ct (1088) + AEAD ct (48) + метаданные « 8192.
    expect(32 + 1088 + fromBase64Url(v.aead.ciphertextBase64Url).length).toBeLessThan(8192);
  });
});
