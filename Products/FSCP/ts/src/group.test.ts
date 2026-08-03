import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import {
  FSCP_GROUP_MAX_MEMBERS,
  FSCP_GROUP_WIRE_PREFIX,
  buildFscpGroupWireEnvelope,
  decryptFscpGroupWireEnvelope,
  groupMessageBodyAadLine,
  groupRecipientKeyEnvelopeAadLine,
  isFscpGroupWirePayload,
} from "./group.js";
import { FscpDecryptError, fscpDecryptFailureCategory, isFscpWirePayload } from "./envelope.js";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  messagePlaintextFromBlocks,
} from "./preview.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const CONV = "11111111-2222-4333-8444-555555555555";

type Member = {
  uuid: string;
  box: { publicKey: Uint8Array; privateKey: Uint8Array };
  sign: { publicKey: Uint8Array; privateKey: Uint8Array };
};

function makeMember(uuid: string): Member {
  return {
    uuid,
    box: sodium.crypto_box_keypair(),
    sign: sodium.crypto_sign_keypair(),
  };
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("FSCP-G v1 group envelope", () => {
  it("encrypts once and decrypts for every member incl. sender self-copy", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const memberC = makeMember("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [
        { userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey },
        { userUuid: memberC.uuid, agreementPublicKey: memberC.box.publicKey },
      ],
      messageBody: "Привет, группа!",
    });

    expect(wire.startsWith(FSCP_GROUP_WIRE_PREFIX)).toBe(true);
    expect(isFscpGroupWirePayload(wire)).toBe(true);
    // Групповой wire не является DM-wire — доменное разделение на уровне префикса.
    expect(isFscpWirePayload(wire)).toBe(false);

    for (const viewer of [sender, memberB, memberC]) {
      const opened = await decryptFscpGroupWireEnvelope({
        wire,
        viewerUserUuid: viewer.uuid,
        agreementPrivateKey: viewer.box.privateKey.subarray(0, 32),
      });
      expect(extractTextFromPlaintext(opened.plaintext)).toBe("Привет, группа!");
      expect(opened.conversationUuid).toBe(CONV);
      expect(opened.senderUserUuid).toBe(sender.uuid);
    }
  });

  it("envelope contains one RKE per member, sorted, with fresh ephemerals", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messageBody: "x",
    });

    const env = JSON.parse(
      new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_GROUP_WIRE_PREFIX.length))),
    );
    expect(env.version).toBe(1);
    expect(env.recipients).toHaveLength(2);
    const userUuids = env.recipients.map((r: { userUuid: string }) => r.userUuid);
    expect(userUuids).toEqual([...userUuids].sort());
    const ephemerals = env.recipients.map(
      (r: { recipientKeyEnvelope: { ephemeralPublicKeyBase64Url: string } }) =>
        r.recipientKeyEnvelope.ephemeralPublicKeyBase64Url,
    );
    expect(new Set(ephemerals).size).toBe(ephemerals.length);
  });

  it("non-member has no RKE entry and cannot decrypt", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const outsider = makeMember("dddddddd-dddd-4ddd-8ddd-dddddddddddd");

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messageBody: "секрет",
    });

    await expect(
      decryptFscpGroupWireEnvelope({
        wire,
        viewerUserUuid: outsider.uuid,
        agreementPrivateKey: outsider.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "no_recipient_entry" });
  });

  it("wrong agreement key fails as rke_unwrap_failed (key_mismatch class)", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const wrongKeys = sodium.crypto_box_keypair();

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messageBody: "x",
    });

    try {
      await decryptFscpGroupWireEnvelope({
        wire,
        viewerUserUuid: memberB.uuid,
        agreementPrivateKey: wrongKeys.privateKey.subarray(0, 32),
      });
      expect.unreachable("должен был упасть");
    } catch (error) {
      expect(error).toBeInstanceOf(FscpDecryptError);
      expect(fscpDecryptFailureCategory(error)).toBe("rke_unwrap_failed");
    }
  });

  it("tampering with signed fields is rejected (signature_invalid)", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messageBody: "x",
    });

    const env = JSON.parse(
      new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_GROUP_WIRE_PREFIX.length))),
    );
    // Сервер/атакующий пытается незаметно выкинуть участника из recipients.
    env.recipients = env.recipients.slice(0, 1);
    const tampered =
      FSCP_GROUP_WIRE_PREFIX + toBase64Url(utf8Bytes(JSON.stringify(env)));

    await expect(
      decryptFscpGroupWireEnvelope({
        wire: tampered,
        viewerUserUuid: sender.uuid,
        agreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "signature_invalid" });
  });

  it("unsigned group envelope is always rejected (no legacy window)", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messageBody: "x",
    });
    const env = JSON.parse(
      new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_GROUP_WIRE_PREFIX.length))),
    );
    delete env.senderSigningPublicKeyBase64Url;
    const unsigned = FSCP_GROUP_WIRE_PREFIX + toBase64Url(utf8Bytes(JSON.stringify(env)));

    await expect(
      decryptFscpGroupWireEnvelope({
        wire: unsigned,
        viewerUserUuid: memberB.uuid,
        agreementPrivateKey: memberB.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "signature_missing" });
  });

  it("roundtrips voice and image blocks in group plaintext", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const memberB = makeMember("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const payload = messagePlaintextFromBlocks([
      {
        kind: "voice",
        assetUuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        durationMs: 1500,
        waveform: [0.1, 0.5, 0.2],
        contentType: "audio/webm",
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          nonceBase64Url: "AAAAAAAAAAAAAAAA",
        },
      },
      {
        kind: "image",
        assetUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        contentType: "image/jpeg",
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          nonceBase64Url: "BBBBBBBBBBBBBBBB",
        },
      },
    ]);

    const wire = await buildFscpGroupWireEnvelope({
      conversationUuid: CONV,
      senderUserUuid: sender.uuid,
      senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: sender.sign.privateKey,
      recipients: [{ userUuid: memberB.uuid, agreementPublicKey: memberB.box.publicKey }],
      messagePayload: payload,
    });

    const opened = await decryptFscpGroupWireEnvelope({
      wire,
      viewerUserUuid: memberB.uuid,
      agreementPrivateKey: memberB.box.privateKey.subarray(0, 32),
    });
    const voice = getPrimaryVoiceBlock(opened.plaintext);
    expect(voice?.assetUuid).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(voice?.durationMs).toBe(1500);
    const images = getImageBlocksFromPlaintext(opened.plaintext);
    expect(images).toHaveLength(1);
    expect(images[0]?.assetUuid).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  });

  it("rejects more than FSCP_GROUP_MAX_MEMBERS members", async () => {
    const sender = makeMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const one = sodium.crypto_box_keypair();
    const recipients = Array.from({ length: FSCP_GROUP_MAX_MEMBERS }, (_, i) => ({
      userUuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      agreementPublicKey: one.publicKey,
    }));

    await expect(
      buildFscpGroupWireEnvelope({
        conversationUuid: CONV,
        senderUserUuid: sender.uuid,
        senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
        senderSigningPrivateKey: sender.sign.privateKey,
        recipients,
        messageBody: "x",
      }),
    ).rejects.toThrow(/участников/);
  });

  it("AAD lines are domain-separated from DM v1", () => {
    const common = {
      conversationUuid: CONV,
      keyEpochId: "00000000-0000-4000-8000-000000000001",
      messageUuid: "99999999-9999-4999-8999-999999999999",
      messageKeyId: "88888888-8888-4888-8888-888888888888",
      senderUserUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      senderDeviceUuid: "00000000-0000-4000-8000-000000000002",
    };
    expect(groupMessageBodyAadLine({ ...common, createdAt: "2026-08-02T00:00:00.000Z" })).toBe(
      "flora.messaging.group-message.v1 | " +
        `${CONV} | 00000000-0000-4000-8000-000000000001 | 99999999-9999-4999-8999-999999999999 | ` +
        "88888888-8888-4888-8888-888888888888 | aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa | " +
        "00000000-0000-4000-8000-000000000002 | 2026-08-02T00:00:00.000Z",
    );
    expect(
      groupRecipientKeyEnvelopeAadLine({
        ...common,
        recipientUserUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        recipientDeviceUuid: "00000000-0000-4000-8000-000000000002",
        recipientAgreementPublicKeyId: "77777777-7777-4777-8777-777777777777",
      }).startsWith("flora.messaging.group-recipient-key-envelope.v1 | "),
    ).toBe(true);
  });
});
