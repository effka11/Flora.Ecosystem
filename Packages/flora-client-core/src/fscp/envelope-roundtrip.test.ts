import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { buildFscpWireEnvelope, decryptFscpWireEnvelope } from "./envelope.js";
import { extractTextFromPlaintext } from "./preview.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("FSCP envelope roundtrip", () => {
  it("encrypts and decrypts a text message", async () => {
    const senderBox = sodium.crypto_box_keypair();
    const senderSign = sodium.crypto_sign_keypair();
    const receiverBox = sodium.crypto_box_keypair();
    const senderUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const receiverUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const senderAg = senderBox.privateKey.subarray(0, 32);
    const wire = await buildFscpWireEnvelope({
      senderUserUuid: senderUuid,
      receiverUserUuid: receiverUuid,
      senderAgreementPrivateKey: senderAg,
      senderSigningPrivateKey: senderSign.privateKey,
      receiverAgreementPublicKey: receiverBox.publicKey,
      messageBody: "Hello from cross-fixture test",
    });
    const plain = await decryptFscpWireEnvelope({
      wire,
      viewerUserUuid: receiverUuid,
      agreementPrivateKey: receiverBox.privateKey.subarray(0, 32),
    });
    expect(extractTextFromPlaintext(plain)).toBe("Hello from cross-fixture test");
  });
});
