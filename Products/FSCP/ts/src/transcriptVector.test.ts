/**
 * Consumer полного транскрипт-вектора fscp-message-transcript-v1.json
 * (Documents/fscp/FSCP.md §Test vectors): единственный вектор, покрывающий ВЕСЬ путь
 * Algorithm A/B — plaintext → body AEAD → RKE → canonical JSON → Ed25519 → wire.
 * Проверяется публичное API decryptFscpWireEnvelope (не внутренности), плюс
 * побайтовое воспроизведение canonical signing payload и plaintext JSON.
 * Файл вектора — regenerate-only: python Documents/test-vectors/_gen_fscp_message_transcript_v1.py
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { messageBodyAadLine } from "./aad.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";
import { dmConversationUuid } from "./deriveIds.js";
import { decryptFscpWireEnvelope, isFscpWirePayload, type FscpEnvelopeWire } from "./envelope.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors",
);

type TranscriptVector = {
  vectorId: string;
  uuids: Record<string, string>;
  createdAt: string;
  text: string;
  plaintextUtf8: string;
  keys: Record<string, string>;
  body: { aadUtf8: string; nonceBase64Url: string; ciphertextBase64Url: string };
  recipients: {
    userUuid: string;
    deviceUuid: string;
    aadUtf8: string;
    ephemeralPrivateKeyBase64Url: string;
    ephemeralPublicKeyBase64Url: string;
    saltBase64Url: string;
    x25519SharedSecretBase64Url: string;
    wrapKeyBase64Url: string;
    nonceBase64Url: string;
    ciphertextBase64Url: string;
  }[];
  canonicalSigningPayloadUtf8: string;
  signatureBase64Url: string;
  envelopeJsonUtf8: string;
  wire: string;
  variants: {
    variantId: string;
    wire: string;
    clientDecrypt: "reject-signature" | "reject-unsigned";
  }[];
};

const v = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-message-transcript-v1.json"), "utf8"),
) as TranscriptVector;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("golden: fscp-message-transcript-v1.json (полный путь Algorithm A/B)", () => {
  it("wire = fscp1: + base64url(envelopeJsonUtf8), envelope-JSON — байт-в-байт", () => {
    expect(isFscpWirePayload(v.wire)).toBe(true);
    const decoded = new TextDecoder().decode(fromBase64Url(v.wire.slice("fscp1:".length)));
    expect(decoded).toBe(v.envelopeJsonUtf8);
  });

  it("conversationUuid детерминирован из пары участников (uuid v5)", () => {
    expect(dmConversationUuid(v.uuids.senderUserUuid!, v.uuids.receiverUserUuid!)).toBe(
      v.uuids.conversationUuid,
    );
  });

  it("plaintextUtf8 совпадает с JSON.stringify объекта blocks (unicode без экранирования)", () => {
    const obj = {
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: v.text }],
      clientCreatedAt: v.createdAt,
    };
    expect(JSON.stringify(obj)).toBe(v.plaintextUtf8);
  });

  it("canonicalJson(envelope без подписи) воспроизводит canonical signing payload", () => {
    const env = JSON.parse(v.envelopeJsonUtf8) as FscpEnvelopeWire;
    const { senderSignatureBase64Url: _omit, ...noSig } = env;
    expect(`flora.messaging.envelope-signature.v1 | ${canonicalJson(noSig)}`).toBe(
      v.canonicalSigningPayloadUtf8,
    );
  });

  it("подпись Ed25519 над canonical payload верифицируется публичным ключом из конверта", () => {
    const ok = sodium.crypto_sign_verify_detached(
      fromBase64Url(v.signatureBase64Url),
      utf8Bytes(v.canonicalSigningPayloadUtf8),
      fromBase64Url(v.keys.senderSigningPublicKeyBase64Url!),
    );
    expect(ok).toBe(true);
  });

  it("тело: AEAD с фиксированным nonce воспроизводит golden ciphertext", () => {
    const u = v.uuids;
    const aad = messageBodyAadLine({
      conversationUuid: u.conversationUuid!,
      keyEpochId: u.keyEpochId!,
      messageUuid: u.messageUuid!,
      messageKeyId: u.messageKeyId!,
      senderUserUuid: u.senderUserUuid!,
      senderDeviceUuid: u.senderDeviceUuid!,
      createdAt: v.createdAt,
    });
    expect(aad).toBe(v.body.aadUtf8);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8Bytes(v.plaintextUtf8),
      aad,
      null,
      fromBase64Url(v.body.nonceBase64Url),
      fromBase64Url(v.keys.messageKeyBase64Url!),
    );
    expect(toBase64Url(ct)).toBe(v.body.ciphertextBase64Url);
  });

  it("получатель расшифровывает wire через публичное API", async () => {
    const plain = await decryptFscpWireEnvelope({
      wire: v.wire,
      viewerUserUuid: v.uuids.receiverUserUuid!,
      agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
    });
    expect(plain.type).toBe("blocks");
    expect(plain.blocks).toEqual([{ kind: "text", body: v.text }]);
    expect(plain.clientCreatedAt).toBe(v.createdAt);
  });

  it("отправитель расшифровывает свою self-копию тем же wire", async () => {
    const plain = await decryptFscpWireEnvelope({
      wire: v.wire,
      viewerUserUuid: v.uuids.senderUserUuid!,
      agreementPrivateKey: fromBase64Url(v.keys.senderAgreementPrivateKeyBase64Url!),
    });
    expect(plain.blocks).toEqual([{ kind: "text", body: v.text }]);
  });

  it("вариант signature_tampered: клиент обязан отклонить до расшифровки", async () => {
    const variant = v.variants.find((x) => x.variantId === "signature_tampered")!;
    expect(variant.clientDecrypt).toBe("reject-signature");
    await expect(
      decryptFscpWireEnvelope({
        wire: variant.wire,
        viewerUserUuid: v.uuids.receiverUserUuid!,
        agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
      }),
    ).rejects.toThrow("Подпись конверта не прошла проверку.");
  });

  it("вариант legacy_unsigned: по умолчанию отклоняется (downgrade-защита, errata-5)", async () => {
    const variant = v.variants.find((x) => x.variantId === "legacy_unsigned")!;
    expect(variant.clientDecrypt).toBe("reject-unsigned");
    await expect(
      decryptFscpWireEnvelope({
        wire: variant.wire,
        viewerUserUuid: v.uuids.receiverUserUuid!,
        agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
      }),
    ).rejects.toMatchObject({ name: "FscpDecryptError", category: "signature_missing" });
  });

  it("вариант legacy_unsigned: архивное чтение только через явный allowUnsignedLegacy", async () => {
    const variant = v.variants.find((x) => x.variantId === "legacy_unsigned")!;
    const plain = await decryptFscpWireEnvelope({
      wire: variant.wire,
      viewerUserUuid: v.uuids.receiverUserUuid!,
      agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
      allowUnsignedLegacy: true,
    });
    expect(plain.blocks).toEqual([{ kind: "text", body: v.text }]);
  });

  it("чужой ключ не расшифровывает (негатив)", async () => {
    await expect(
      decryptFscpWireEnvelope({
        wire: v.wire,
        viewerUserUuid: v.uuids.receiverUserUuid!,
        agreementPrivateKey: fromBase64Url(v.keys.senderAgreementPrivateKeyBase64Url!),
      }),
    ).rejects.toThrow();
  });
});
