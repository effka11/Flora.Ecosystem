/**
 * Cross-impl parity (Documents/fscp/FSCP.md §Test vectors): байт-критичные модули
 * Apps/Web/lib/fscp обязаны давать идентичный результат с @flora/fscp
 * (Products/FSCP/ts) до консолидации клиентов (next-architecture.md §9). Дрейф =
 * молчаливая потеря совместимости wire между Web и Mobile.
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { messageBodyAadLine, recipientKeyEnvelopeAadLine } from "./aad.js";
import { fromBase64Url } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";
import {
  FLORA_UUID_NAMESPACE,
  FSCP_BOOTSTRAP_DEVICE_UUID,
  FSCP_BOOTSTRAP_KEY_EPOCH_ID,
  FSCP_WIRE_PREFIX,
} from "./constants.js";
import { agreementPublicKeyId, dmConversationUuid } from "./deriveIds.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  peekFscpWireFrankTagBase64Url,
  type FscpEnvelopeWire,
} from "./envelope.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import {
  messageBodyAadLine as webMessageBodyAadLine,
  recipientKeyEnvelopeAadLine as webRecipientKeyEnvelopeAadLine,
} from "../../../../Apps/Web/lib/fscp/aad";
import { canonicalJson as webCanonicalJson } from "../../../../Apps/Web/lib/fscp/canonicalJson";
import * as webConstants from "../../../../Apps/Web/lib/fscp/constants";
import {
  agreementPublicKeyId as webAgreementPublicKeyId,
  dmConversationUuid as webDmConversationUuid,
} from "../../../../Apps/Web/lib/fscp/deriveIds";
import {
  buildFscpWireEnvelope as webBuildFscpWireEnvelope,
  decryptFscpWireEnvelope as webDecryptFscpWireEnvelope,
  peekFscpWireFrankTagBase64Url as webPeekFscpWireFrankTagBase64Url,
} from "../../../../Apps/Web/lib/fscp/envelope";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Порядок ключей конверта — часть замороженного wire (franking.md §4.2). */
const V1_ENVELOPE_KEYS = [
  "version",
  "messageUuid",
  "conversationUuid",
  "keyEpochId",
  "senderUserUuid",
  "senderDeviceUuid",
  "messageKeyId",
  "createdAt",
  "ciphertextBase64Url",
  "aead",
  "recipients",
  "senderSigningPublicKeyBase64Url",
  "senderSignatureBase64Url",
];
const V1_1_ENVELOPE_KEYS = [
  ...V1_ENVELOPE_KEYS.slice(0, -1),
  "frankTagBase64Url",
  "senderSignatureBase64Url",
];

type Party = {
  box: { publicKey: Uint8Array; privateKey: Uint8Array };
  sign: { publicKey: Uint8Array; privateKey: Uint8Array };
};

function newParty(): Party {
  return { box: sodium.crypto_box_keypair(), sign: sodium.crypto_sign_keypair() };
}

function decodeEnvelope(wire: string): FscpEnvelopeWire {
  const json = new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_WIRE_PREFIX.length)));
  return JSON.parse(json) as FscpEnvelopeWire;
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

const AAD_PARAMS = {
  conversationUuid: "11111111-1111-4111-8111-111111111111",
  keyEpochId: "22222222-2222-4222-8222-222222222222",
  messageUuid: "33333333-3333-4333-8333-333333333333",
  messageKeyId: "44444444-4444-4444-8444-444444444444",
  senderUserUuid: "55555555-5555-4555-8555-555555555555",
  senderDeviceUuid: "66666666-6666-4666-8666-666666666666",
};

const MIXED_CASE = {
  ...AAD_PARAMS,
  conversationUuid: "11111111-1111-4111-8111-111111111111".toUpperCase(),
  senderUserUuid: "0198C5B6-7E2D-7ABC-9DEF-0123456789AB",
};

describe("web ↔ client-core parity (byte-critical fscp modules)", () => {
  it("constants are identical", () => {
    expect(webConstants.FSCP_WIRE_PREFIX).toBe(FSCP_WIRE_PREFIX);
    expect(webConstants.FSCP_BOOTSTRAP_KEY_EPOCH_ID).toBe(FSCP_BOOTSTRAP_KEY_EPOCH_ID);
    expect(webConstants.FSCP_BOOTSTRAP_DEVICE_UUID).toBe(FSCP_BOOTSTRAP_DEVICE_UUID);
    expect(webConstants.FLORA_UUID_NAMESPACE).toBe(FLORA_UUID_NAMESPACE);
  });

  it("recipientKeyEnvelopeAadLine is identical (incl. mixed-case input)", () => {
    for (const base of [AAD_PARAMS, MIXED_CASE]) {
      const params = {
        ...base,
        recipientUserUuid: "77777777-7777-4777-8777-777777777777",
        recipientDeviceUuid: "88888888-8888-4888-8888-888888888888",
        recipientAgreementPublicKeyId: "99999999-9999-4999-8999-999999999999",
      };
      expect(webRecipientKeyEnvelopeAadLine(params)).toBe(recipientKeyEnvelopeAadLine(params));
    }
  });

  it("messageBodyAadLine is identical", () => {
    const params = { ...AAD_PARAMS, createdAt: "2026-07-13T00:00:00.000Z" };
    expect(webMessageBodyAadLine(params)).toBe(messageBodyAadLine(params));
  });

  it("messageBodyAadLine with frankTag is identical (v1_1)", () => {
    const params = {
      ...AAD_PARAMS,
      createdAt: "2026-07-13T00:00:00.000Z",
      frankTagBase64Url: "dGVzdFRhZ0Jhc2U2NFVybA",
    };
    expect(webMessageBodyAadLine(params)).toBe(messageBodyAadLine(params));
    expect(webMessageBodyAadLine(params).startsWith("flora.messaging.message.v1_1 | ")).toBe(true);
    expect(webMessageBodyAadLine(params).endsWith(` | ${params.frankTagBase64Url}`)).toBe(true);
  });

  it.each([
    ["пустая строка", ""],
    ["пробелы", "   "],
    ["null", null],
    ["undefined", undefined],
  ] as const)("messageBodyAadLine без тега при %s — побайтово v1", (_case, frankTagBase64Url) => {
    const params = { ...AAD_PARAMS, createdAt: "2026-07-13T00:00:00.000Z", frankTagBase64Url };
    expect(webMessageBodyAadLine(params)).toBe(messageBodyAadLine(params));
    expect(webMessageBodyAadLine(params).startsWith("flora.messaging.message.v1 | ")).toBe(true);
  });

  it("canonicalJson is identical on nested mixed-case structures", () => {
    const samples: unknown[] = [
      { b: 1, a: 2, B: 3, nested: { z: [3, 1, { y: null, x: "т" }], A: true } },
      { version: 1, recipients: [{ userUuid: "AA" }, { userUuid: "aa" }], preKeyId: null },
      ["mixed", 1, null, { k: "v" }],
    ];
    for (const s of samples) {
      expect(webCanonicalJson(s)).toBe(canonicalJson(s));
    }
  });

  it("deriveIds are identical (incl. argument order and case)", () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "0198C5B6-7E2D-7ABC-9DEF-0123456789AB";
    expect(webDmConversationUuid(a, b)).toBe(dmConversationUuid(a, b));
    expect(webDmConversationUuid(b, a)).toBe(dmConversationUuid(a, b));
    expect(webAgreementPublicKeyId(b, FSCP_BOOTSTRAP_KEY_EPOCH_ID)).toBe(
      agreementPublicKeyId(b, FSCP_BOOTSTRAP_KEY_EPOCH_ID),
    );
  });
});

describe("web ↔ SoT franking wire parity (FSCP-FRANK v1.1)", () => {
  async function buildBoth(opts: {
    sender: Party;
    receiver: Party;
    body: string;
    emitFrankTag?: boolean;
  }) {
    const common = {
      senderUserUuid: SENDER,
      receiverUserUuid: RECEIVER,
      senderAgreementPrivateKey: opts.sender.box.privateKey.subarray(0, 32),
      senderSigningPrivateKey: opts.sender.sign.privateKey,
      receiverAgreementPublicKey: opts.receiver.box.publicKey,
      messageBody: opts.body,
      ...(opts.emitFrankTag === undefined ? {} : { emitFrankTag: opts.emitFrankTag }),
    };
    return {
      sot: await buildFscpWireEnvelope(common),
      web: await webBuildFscpWireEnvelope(common),
    };
  }

  it("emitFrankTag выключен — состав конверта совпадает (v1)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const { sot, web } = await buildBoth({ sender, receiver, body: "без франкования" });

    expect(Object.keys(decodeEnvelope(web))).toEqual(V1_ENVELOPE_KEYS);
    expect(Object.keys(decodeEnvelope(sot))).toEqual(V1_ENVELOPE_KEYS);
    expect(webPeekFscpWireFrankTagBase64Url(web)).toBeNull();
    expect(peekFscpWireFrankTagBase64Url(sot)).toBeNull();
  });

  it("emitFrankTag включён — состав конверта совпадает (v1_1)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const { sot, web } = await buildBoth({ sender, receiver, body: "с франкованием", emitFrankTag: true });

    expect(Object.keys(decodeEnvelope(web))).toEqual(V1_1_ENVELOPE_KEYS);
    expect(Object.keys(decodeEnvelope(sot))).toEqual(V1_1_ENVELOPE_KEYS);
    expect(webPeekFscpWireFrankTagBase64Url(web)).not.toBeNull();
    expect(peekFscpWireFrankTagBase64Url(sot)).not.toBeNull();
  });

  it("SoT wire v1.1 открывается Web-форком", async () => {
    const sender = newParty();
    const receiver = newParty();
    const body = "SoT → Web";
    const sotWire = (await buildBoth({ sender, receiver, body, emitFrankTag: true })).sot;

    const plain = await webDecryptFscpWireEnvelope({
      wire: sotWire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    expect(plain.blocks).toEqual([{ kind: "text", body }]);
  });

  it("Web wire v1.1 открывается SoT", async () => {
    const sender = newParty();
    const receiver = newParty();
    const body = "Web → SoT";
    const webWire = (await buildBoth({ sender, receiver, body, emitFrankTag: true })).web;

    const plain = await decryptFscpWireEnvelope({
      wire: webWire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    expect(plain.blocks).toEqual([{ kind: "text", body }]);
  });
});
