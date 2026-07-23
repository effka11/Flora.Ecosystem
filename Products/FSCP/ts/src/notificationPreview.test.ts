import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFscpWireEnvelope } from "./envelope.js";
import {
  buildNotificationPreviewEnvelope,
  openNotificationPreviewEnvelope,
  parseNotificationPreviewEnvelope,
} from "./notificationPreview.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";

const require = createRequire(import.meta.url);
const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTALLATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("NotificationPreviewEnvelope v1", () => {
  let sodium: SodiumModule;

  beforeAll(async () => {
    configureSodiumLoader(async () => {
      const loaded = require("libsodium-wrappers-sumo") as SodiumModule;
      await loaded.ready;
      return loaded;
    });
    sodium = await (async () => {
      const loaded = require("libsodium-wrappers-sumo") as SodiumModule;
      await loaded.ready;
      return loaded;
    })();
  });

  it("encrypts for one installation and opens only there", async () => {
    const senderAgreement = sodium.crypto_box_keypair();
    const senderSigning = sodium.crypto_sign_keypair();
    const receiverAgreement = sodium.crypto_box_keypair();
    const previewKey = sodium.crypto_box_keypair();
    const mainWire = await buildFscpWireEnvelope({
      senderUserUuid: SENDER,
      receiverUserUuid: RECIPIENT,
      senderAgreementPrivateKey: senderAgreement.privateKey,
      senderSigningPrivateKey: senderSigning.privateKey,
      receiverAgreementPublicKey: receiverAgreement.publicKey,
      messageBody: "Секретный текст",
    });
    const wire = await buildNotificationPreviewEnvelope({
      messageWire: mainWire,
      recipientUserUuid: RECIPIENT,
      recipientInstallationUuid: INSTALLATION,
      previewKeyId: KEY_ID,
      recipientPreviewPublicKey: previewKey.publicKey,
      senderSigningPrivateKey: senderSigning.privateKey,
      preview: "Секретный текст",
      kind: "text",
    });

    const env = parseNotificationPreviewEnvelope(wire);
    const opened = await openNotificationPreviewEnvelope({
      wire,
      recipientUserUuid: RECIPIENT,
      recipientInstallationUuid: INSTALLATION,
      previewKeyId: KEY_ID,
      recipientPreviewPrivateKey: previewKey.privateKey,
      expectedSenderSigningPublicKeyBase64Url: env.senderSigningPublicKeyBase64Url,
    });
    expect(opened).toEqual({ preview: "Секретный текст", kind: "text" });

    await expect(
      openNotificationPreviewEnvelope({
        wire,
        recipientUserUuid: RECIPIENT,
        recipientInstallationUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        previewKeyId: KEY_ID,
        recipientPreviewPrivateKey: previewKey.privateKey,
      }),
    ).rejects.toThrow("binding mismatch");

    const otherPreviewKey = sodium.crypto_box_keypair();
    await expect(
      openNotificationPreviewEnvelope({
        wire,
        recipientUserUuid: RECIPIENT,
        recipientInstallationUuid: INSTALLATION,
        previewKeyId: KEY_ID,
        recipientPreviewPrivateKey: otherPreviewKey.privateKey,
      }),
    ).rejects.toThrow();
  });

  it("rejects expiry and tampering", async () => {
    const senderAgreement = sodium.crypto_box_keypair();
    const senderSigning = sodium.crypto_sign_keypair();
    const receiverAgreement = sodium.crypto_box_keypair();
    const previewKey = sodium.crypto_box_keypair();
    const issuedAt = "2026-07-20T00:00:00.000Z";
    const mainWire = await buildFscpWireEnvelope({
      senderUserUuid: SENDER,
      receiverUserUuid: RECIPIENT,
      senderAgreementPrivateKey: senderAgreement.privateKey,
      senderSigningPrivateKey: senderSigning.privateKey,
      receiverAgreementPublicKey: receiverAgreement.publicKey,
      messageBody: "test",
    });
    const wire = await buildNotificationPreviewEnvelope({
      messageWire: mainWire,
      recipientUserUuid: RECIPIENT,
      recipientInstallationUuid: INSTALLATION,
      previewKeyId: KEY_ID,
      recipientPreviewPublicKey: previewKey.publicKey,
      senderSigningPrivateKey: senderSigning.privateKey,
      preview: "test",
      kind: "text",
      issuedAt,
    });
    await expect(
      openNotificationPreviewEnvelope({
        wire,
        recipientUserUuid: RECIPIENT,
        recipientInstallationUuid: INSTALLATION,
        previewKeyId: KEY_ID,
        recipientPreviewPrivateKey: previewKey.privateKey,
        nowMs: Date.parse(issuedAt) + 25 * 60 * 60 * 1_000,
      }),
    ).rejects.toThrow("expired");

    const env = parseNotificationPreviewEnvelope(wire);
    const withUnknown = {
      ...env,
      futureField: "must be rejected",
    };
    const unknownWire = `fscpnp1:${sodium.to_base64(
      new TextEncoder().encode(JSON.stringify(withUnknown)),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    )}`;
    expect(() => parseNotificationPreviewEnvelope(unknownWire)).toThrow("shape");

    env.conversationUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const encoded = sodium.to_base64(
      new TextEncoder().encode(JSON.stringify(env)),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    await expect(
      openNotificationPreviewEnvelope({
        wire: `fscpnp1:${encoded}`,
        recipientUserUuid: RECIPIENT,
        recipientInstallationUuid: INSTALLATION,
        previewKeyId: KEY_ID,
        recipientPreviewPrivateKey: previewKey.privateKey,
        nowMs: Date.parse(issuedAt),
      }),
    ).rejects.toThrow("signature");
  });
});
