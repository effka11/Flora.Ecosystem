import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../src/canonicalJson.js";
import { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID } from "../src/constants.js";
import { agreementPublicKeyId, dmConversationUuid } from "../src/deriveIds.js";
import { buildNotificationPreviewEnvelope } from "../src/notificationPreview.js";
import { configureSodiumLoader, scalarmultBase, type SodiumModule } from "../src/sodium.js";
import { utf8Bytes } from "../src/base64url.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;
await sodium.ready;
configureSodiumLoader(async () => sodium);

const sender = "55555555-5555-4555-8555-555555555555";
const recipient = "77777777-7777-4777-8777-777777777777";
const installation = "88888888-8888-4888-8888-888888888888";
const previewKeyId = "99999999-9999-4999-8999-999999999999";
const messageUuid = "33333333-3333-4333-8333-333333333333";
const messageKeyId = "44444444-4444-4444-8444-444444444444";
const conversationUuid = dmConversationUuid(sender, recipient);
const b64 = (bytes: Uint8Array) =>
  sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const bytes = (start: number, length: number) =>
  Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);

const signing = sodium.crypto_sign_seed_keypair!(bytes(1, 32));
const rke = (userUuid: string, offset: number) => ({
  userUuid,
  deviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
  recipientKeyEnvelope: {
    version: 1,
    algorithm: "x25519-hkdf-xchacha20poly1305",
    ephemeralPublicKeyBase64Url: b64(bytes(offset, 32)),
    recipientAgreementPublicKeyId: agreementPublicKeyId(
      userUuid,
      FSCP_BOOTSTRAP_KEY_EPOCH_ID,
    ),
    preKeyId: null,
    saltBase64Url: b64(bytes(offset + 32, 32)),
    aead: { name: "xchacha20-poly1305", nonceBase64Url: b64(bytes(offset + 64, 24)) },
    ciphertextBase64Url: b64(bytes(offset + 88, 48)),
  },
});
const noSignature = {
  version: 1,
  messageUuid,
  conversationUuid,
  keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
  senderUserUuid: sender,
  senderDeviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
  messageKeyId,
  createdAt: "2026-07-23T00:00:00.000Z",
  ciphertextBase64Url: b64(bytes(140, 48)),
  aead: { name: "xchacha20-poly1305", nonceBase64Url: b64(bytes(188, 24)) },
  recipients: [rke(sender, 20), rke(recipient, 80)].sort((a, b) =>
    a.userUuid.localeCompare(b.userUuid),
  ),
  senderSigningPublicKeyBase64Url: b64(signing.publicKey),
};
const signature = sodium.crypto_sign_detached(
  utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(noSignature)}`),
  signing.privateKey,
);
const messageWire = `fscp1:${b64(
  utf8Bytes(JSON.stringify({ ...noSignature, senderSignatureBase64Url: b64(signature) })),
)}`;

const previewPrivateKey = bytes(211, 32);
const previewPublicKey = scalarmultBase(sodium, previewPrivateKey);
const previewWire = await buildNotificationPreviewEnvelope({
  messageWire,
  recipientUserUuid: recipient,
  recipientInstallationUuid: installation,
  previewKeyId,
  recipientPreviewPublicKey: previewPublicKey,
  senderSigningPrivateKey: signing.privateKey,
  preview: "Golden preview",
  kind: "text",
  issuedAt: "2026-07-23T00:00:00.000Z",
  vectorOverrides: {
    previewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ephemeralSecret: bytes(33, 32),
    salt: bytes(65, 32),
    nonce: bytes(97, 24),
  },
});

const vector = {
  vectorId: "fscp_notification_preview_v1",
  generatedBy: "Products/FSCP/ts/scripts/generateNotificationPreviewVector.ts",
  messageWire,
  previewWire,
  recipientUserUuid: recipient,
  recipientInstallationUuid: installation,
  previewKeyId,
  previewPrivateKeyBase64Url: b64(previewPrivateKey),
  previewPublicKeyBase64Url: b64(previewPublicKey),
  expected: { preview: "Golden preview", kind: "text" },
  openAt: "2026-07-23T12:00:00.000Z",
};

const output = resolve(process.cwd(), "../../Documents/test-vectors/fscp-notification-preview-v1.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`, "utf8");
console.log(output);
