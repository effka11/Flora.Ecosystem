/**
 * FSCP-FRANK, дельта wire v1.1 (Documents/fscp/franking.md §4.1, §4.2, §4.6).
 *
 * Эмиссия тега — явный параметр вызова, по умолчанию выключенный: продуктовой
 * конфигурации в ядре FSCP нет, франковать решает приложение. Выключенный
 * параметр обязан быть no-op по байтам относительно замороженного v1
 * (FSCP.md §Versioning): проверяются и plaintext-байты, и порядок ключей конверта.
 *
 * AAD-строки здесь собраны литералами, а не вызовом `messageBodyAadLine`, —
 * иначе тест повторил бы возможную ошибку реализации вместо того, чтобы её ловить.
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { recipientKeyEnvelopeAadLine } from "./aad.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { canonicalJson } from "./canonicalJson.js";
import { FSCP_WIRE_PREFIX } from "./constants.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelopeDetailed,
  padPlaintextJsonV1,
  peekFscpWireFrankTagBase64Url,
  type FscpEnvelopeWire,
} from "./envelope.js";
import {
  computeFrankTagV1,
  frankCommitInputV1,
  frankReceiptPayloadV1,
  verifyFrankedMessageV1,
  type FrankCommitContextV1,
} from "./franking.js";
import type { FscpLocalMaterial } from "./keys.js";
import { withFloraGoldenClock } from "./floraUuid.js";
import { buildBlocksMessageWire } from "./messaging.js";
import { rkeUnwrapMessageKey } from "./rke.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Порядок ключей — это байты wire-JSON; франкование добавляет ровно одно поле перед подписью. */
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

async function buildWire(opts: {
  sender: Party;
  receiver: Party;
  body: string;
  emitFrankTag?: boolean;
}): Promise<string> {
  return buildFscpWireEnvelope({
    senderUserUuid: SENDER,
    receiverUserUuid: RECEIVER,
    senderAgreementPrivateKey: opts.sender.box.privateKey.subarray(0, 32),
    senderSigningPrivateKey: opts.sender.sign.privateKey,
    receiverAgreementPublicKey: opts.receiver.box.publicKey,
    messageBody: opts.body,
    // Умолчание проверяется отсутствием ключа, а не `emitFrankTag: undefined`.
    ...(opts.emitFrankTag === undefined ? {} : { emitFrankTag: opts.emitFrankTag }),
  });
}

function decodeEnvelope(wire: string): FscpEnvelopeWire {
  const json = new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_WIRE_PREFIX.length)));
  return JSON.parse(json) as FscpEnvelopeWire;
}

function encodeEnvelope(env: FscpEnvelopeWire): string {
  return `${FSCP_WIRE_PREFIX}${toBase64Url(utf8Bytes(JSON.stringify(env)))}`;
}

/** Пересборка подписи атакующим, который владеет ключом отправителя, — изолирует AAD от подписи. */
function resign(env: FscpEnvelopeWire, signingPrivateKey: Uint8Array): FscpEnvelopeWire {
  const { senderSignatureBase64Url: _omit, ...noSig } = env;
  const payload = utf8Bytes(`flora.messaging.envelope-signature.v1 | ${canonicalJson(noSig)}`);
  return {
    ...env,
    senderSignatureBase64Url: toBase64Url(sodium.crypto_sign_detached(payload, signingPrivateKey)),
  };
}

function bodyAadLiteral(env: FscpEnvelopeWire, frankTagBase64Url?: string): string {
  const head = [
    frankTagBase64Url ? "flora.messaging.message.v1_1" : "flora.messaging.message.v1",
    env.conversationUuid.toLowerCase(),
    env.keyEpochId.toLowerCase(),
    env.messageUuid.toLowerCase(),
    env.messageKeyId.toLowerCase(),
    env.senderUserUuid.toLowerCase(),
    env.senderDeviceUuid.toLowerCase(),
    env.createdAt,
  ];
  return (frankTagBase64Url ? [...head, frankTagBase64Url] : head).join(" | ");
}

/** Открывает тело под явно заданной AAD-строкой: показывает, какую строку требует шифртекст. */
function openBodyWithAad(env: FscpEnvelopeWire, viewer: { userUuid: string; agreementPrivateKey: Uint8Array }, aadLine: string): string {
  const row = env.recipients.find((r) => r.userUuid === viewer.userUuid);
  if (!row) throw new Error("нет RKE для участника");
  const rke = row.recipientKeyEnvelope;
  const messageKey = rkeUnwrapMessageKey({
    sodium,
    agreementPrivateKey: viewer.agreementPrivateKey,
    ephemeralPublicKey: fromBase64Url(rke.ephemeralPublicKeyBase64Url),
    salt32: fromBase64Url(rke.saltBase64Url),
    aadUtf8Line: recipientKeyEnvelopeAadLine({
      conversationUuid: env.conversationUuid,
      keyEpochId: env.keyEpochId,
      messageUuid: env.messageUuid,
      messageKeyId: env.messageKeyId,
      senderUserUuid: env.senderUserUuid,
      senderDeviceUuid: env.senderDeviceUuid,
      recipientUserUuid: row.userUuid,
      recipientDeviceUuid: row.deviceUuid,
      recipientAgreementPublicKeyId: rke.recipientAgreementPublicKeyId,
    }),
    nonce: fromBase64Url(rke.aead.nonceBase64Url),
    ciphertext: fromBase64Url(rke.ciphertextBase64Url),
  });
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64Url(env.ciphertextBase64Url),
    aadLine,
    fromBase64Url(env.aead.nonceBase64Url),
    messageKey,
  );
  return new TextDecoder().decode(plain);
}

function expectedV1Plaintext(env: FscpEnvelopeWire, body: string): string {
  return padPlaintextJsonV1(
    JSON.stringify({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body }],
      clientCreatedAt: env.createdAt,
    }),
  );
}

function commitContext(env: FscpEnvelopeWire): FrankCommitContextV1 {
  return {
    conversationUuid: env.conversationUuid,
    messageUuid: env.messageUuid,
    senderUserUuid: env.senderUserUuid,
    senderDeviceUuid: env.senderDeviceUuid,
    receiverUserUuid: RECEIVER,
    createdAt: env.createdAt,
  };
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("emitFrankTag выключен — байты остаются v1", () => {
  it.each([
    ["по умолчанию (параметр не передан)", undefined],
    ["явное emitFrankTag: false", false],
  ] as const)("%s: тега нет ни в конверте, ни в plaintext", async (_case, emitFrankTag) => {
    const sender = newParty();
    const receiver = newParty();
    const body = "сообщение без франкования";
    const wire = await buildWire({ sender, receiver, body, ...(emitFrankTag === undefined ? {} : { emitFrankTag }) });
    const env = decodeEnvelope(wire);

    expect(Object.keys(env)).toEqual(V1_ENVELOPE_KEYS);
    expect(env.frankTagBase64Url).toBeUndefined();
    expect(peekFscpWireFrankTagBase64Url(wire)).toBeNull();

    const detailed = await decryptFscpWireEnvelopeDetailed({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    expect(detailed.frankingKeyBase64Url).toBeNull();
    const plaintextJson = JSON.parse(new TextDecoder().decode(detailed.plaintextUtf8)) as Record<string, unknown>;
    expect(Object.keys(plaintextJson)).toEqual(["type", "version", "blocks", "clientCreatedAt", "pad"]);
  });

  it("plaintext-байты и AAD совпадают с v1 (паддинг не сдвинут)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const body = "проверка no-op по байтам";
    const env = decodeEnvelope(await buildWire({ sender, receiver, body }));
    const viewer = { userUuid: RECEIVER, agreementPrivateKey: receiver.box.privateKey.subarray(0, 32) };

    const opened = openBodyWithAad(env, viewer, bodyAadLiteral(env));
    expect(opened).toBe(expectedV1Plaintext(env, body));
    expect(opened).not.toContain("frankingKeyBase64Url");
  });
});

describe("emitFrankTag включён — дельта v1.1", () => {
  it("frankingKey (32 B) в plaintext, frankTag (32 B) на конверте", async () => {
    const sender = newParty();
    const receiver = newParty();
    const wire = await buildWire({ sender, receiver, body: "жалоба будет доказуема", emitFrankTag: true });
    const env = decodeEnvelope(wire);

    expect(Object.keys(env)).toEqual(V1_1_ENVELOPE_KEYS);
    expect(fromBase64Url(env.frankTagBase64Url ?? "").length).toBe(32);
    expect(peekFscpWireFrankTagBase64Url(wire)).toBe(env.frankTagBase64Url);

    const detailed = await decryptFscpWireEnvelopeDetailed({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    expect(detailed.frankingKeyBase64Url).not.toBeNull();
    expect(fromBase64Url(detailed.frankingKeyBase64Url ?? "").length).toBe(32);
    // Ключ — сосед `blocks` в plaintext JSON, а не поле блока (franking.md §4.2).
    const plaintextJson = JSON.parse(new TextDecoder().decode(detailed.plaintextUtf8)) as Record<string, unknown>;
    expect(Object.keys(plaintextJson)).toEqual([
      "type",
      "version",
      "blocks",
      "clientCreatedAt",
      "frankingKeyBase64Url",
      "pad",
    ]);
    expect(JSON.stringify(plaintextJson.blocks)).not.toContain("frankingKeyBase64Url");
  });

  it("ключ per-message: два сообщения подряд дают разные Kf и разные теги", async () => {
    const sender = newParty();
    const receiver = newParty();
    const asReceiver = { viewerUserUuid: RECEIVER, agreementPrivateKey: receiver.box.privateKey.subarray(0, 32) };
    const first = await buildWire({ sender, receiver, body: "одно и то же", emitFrankTag: true });
    const second = await buildWire({ sender, receiver, body: "одно и то же", emitFrankTag: true });

    const a = await decryptFscpWireEnvelopeDetailed({ wire: first, ...asReceiver });
    const b = await decryptFscpWireEnvelopeDetailed({ wire: second, ...asReceiver });
    expect(a.frankingKeyBase64Url).not.toBe(b.frankingKeyBase64Url);
    expect(decodeEnvelope(first).frankTagBase64Url).not.toBe(decodeEnvelope(second).frankTagBase64Url);
  });

  it("frankTag = HMAC(Kf, commitInput) по padded-байтам, включая pad", async () => {
    const sender = newParty();
    const receiver = newParty();
    const wire = await buildWire({ sender, receiver, body: "commit по AEAD-байтам", emitFrankTag: true });
    const env = decodeEnvelope(wire);
    const detailed = await decryptFscpWireEnvelopeDetailed({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    const frankingKey = fromBase64Url(detailed.frankingKeyBase64Url ?? "");

    const commitInput = frankCommitInputV1(commitContext(env), detailed.plaintextUtf8);
    expect(toBase64Url(computeFrankTagV1(frankingKey, commitInput))).toBe(env.frankTagBase64Url);

    // Тот же plaintext без pad даёт другой commit — доказывает, что коммит покрывает паддинг.
    const padded = new TextDecoder().decode(detailed.plaintextUtf8);
    const unpadded = padded.replace(/,"pad":"0*"}$/, "}");
    expect(unpadded.length).toBeLessThan(padded.length);
    const unpaddedCommit = frankCommitInputV1(commitContext(env), utf8Bytes(unpadded));
    expect(toBase64Url(computeFrankTagV1(frankingKey, unpaddedCommit))).not.toBe(env.frankTagBase64Url);
  });

  it("AAD тела — flora.messaging.message.v1_1 с суффиксом тега; строка v1 больше не подходит", async () => {
    const sender = newParty();
    const receiver = newParty();
    const body = "AAD связывает тег";
    const env = decodeEnvelope(await buildWire({ sender, receiver, body, emitFrankTag: true }));
    const viewer = { userUuid: RECEIVER, agreementPrivateKey: receiver.box.privateKey.subarray(0, 32) };
    const tag = env.frankTagBase64Url ?? "";

    const aadV1_1 = bodyAadLiteral(env, tag);
    expect(aadV1_1.startsWith("flora.messaging.message.v1_1 | ")).toBe(true);
    expect(aadV1_1.endsWith(` | ${tag}`)).toBe(true);

    const opened = openBodyWithAad(env, viewer, aadV1_1);
    expect(JSON.parse(opened)).toMatchObject({ blocks: [{ kind: "text", body }] });
    expect(() => openBodyWithAad(env, viewer, bodyAadLiteral(env))).toThrow();
  });

  it("подпись Ed25519 покрывает тег: подмена без пересборки подписи → signature_invalid", async () => {
    const sender = newParty();
    const receiver = newParty();
    const env = decodeEnvelope(await buildWire({ sender, receiver, body: "подпись покрывает тег", emitFrankTag: true }));
    const forged = { ...env, frankTagBase64Url: toBase64Url(new Uint8Array(32)) };

    await expect(
      decryptFscpWireEnvelopeDetailed({
        wire: encodeEnvelope(forged),
        viewerUserUuid: RECEIVER,
        agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ name: "FscpDecryptError", category: "signature_invalid" });
  });

  it("подмена тега с валидной подписью ломает AEAD (тег привязан к шифртексту)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const env = decodeEnvelope(await buildWire({ sender, receiver, body: "AEAD ловит подмену", emitFrankTag: true }));
    const forged = resign({ ...env, frankTagBase64Url: toBase64Url(new Uint8Array(32)) }, sender.sign.privateKey);

    await expect(
      decryptFscpWireEnvelopeDetailed({
        wire: encodeEnvelope(forged),
        viewerUserUuid: RECEIVER,
        agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ name: "FscpDecryptError", category: "body_decrypt_failed" });
  });

  it("снятие тега с валидной подписью тоже ломает AEAD (downgrade v1.1 → v1 невозможен)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const env = decodeEnvelope(await buildWire({ sender, receiver, body: "downgrade", emitFrankTag: true }));
    const { frankTagBase64Url: _dropped, ...untagged } = env;
    const forged = resign(untagged as FscpEnvelopeWire, sender.sign.privateKey);

    await expect(
      decryptFscpWireEnvelopeDetailed({
        wire: encodeEnvelope(forged),
        viewerUserUuid: RECEIVER,
        agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ name: "FscpDecryptError", category: "body_decrypt_failed" });
  });

  it("жалоба на реальный wire проходит verify-путь жюри целиком (franking.md §4.4)", async () => {
    const sender = newParty();
    const receiver = newParty();
    const serverFranking = sodium.crypto_sign_keypair();
    const wire = await buildWire({ sender, receiver, body: "недопустимое сообщение", emitFrankTag: true });
    const env = decodeEnvelope(wire);
    const detailed = await decryptFscpWireEnvelopeDetailed({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });

    const serverReceivedAt = "2026-08-22T12:00:00.123Z";
    const receiptSignature = sodium.crypto_sign_detached(
      utf8Bytes(
        frankReceiptPayloadV1({
          frankTagBase64Url: env.frankTagBase64Url ?? "",
          messageUuid: env.messageUuid,
          conversationUuid: env.conversationUuid,
          senderUserUuid: env.senderUserUuid,
          receiverUserUuid: RECEIVER,
          serverReceivedAt,
        }),
      ),
      serverFranking.privateKey,
    );

    const verdict = verifyFrankedMessageV1({
      sodium,
      tuple: {
        plaintextUtf8: detailed.plaintextUtf8,
        frankingKey: fromBase64Url(detailed.frankingKeyBase64Url ?? ""),
        frankTag: fromBase64Url(env.frankTagBase64Url ?? ""),
        receipt: {
          signatureBase64Url: toBase64Url(receiptSignature),
          serverFrankingKeyId: "test-franking-key-1",
          serverReceivedAt,
        },
        commit: commitContext(env),
      },
      receiptSignature,
      serverFrankingPublicKey: serverFranking.publicKey,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("замороженные инварианты v1 держатся в обоих режимах", () => {
  it.each([false, true])("emitFrankTag=%s: version 1, префикс fscp1:, preKeyId null", async (emitFrankTag) => {
    const sender = newParty();
    const receiver = newParty();
    const wire = await buildWire({ sender, receiver, body: "инварианты", emitFrankTag });
    const env = decodeEnvelope(wire);

    expect(wire.startsWith(FSCP_WIRE_PREFIX)).toBe(true);
    expect(env.version).toBe(1);
    expect(env.recipients).toHaveLength(2);
    for (const r of env.recipients) {
      expect(r.recipientKeyEnvelope.version).toBe(1);
      expect(r.recipientKeyEnvelope.preKeyId).toBeNull();
    }
  });

  it.each([false, true])("emitFrankTag=%s: получатель и self-копия отправителя открываются", async (emitFrankTag) => {
    const sender = newParty();
    const receiver = newParty();
    const body = "обе стороны читают";
    const wire = await buildWire({ sender, receiver, body, emitFrankTag });

    for (const viewer of [
      { viewerUserUuid: RECEIVER, agreementPrivateKey: receiver.box.privateKey.subarray(0, 32) },
      { viewerUserUuid: SENDER, agreementPrivateKey: sender.box.privateKey.subarray(0, 32) },
    ]) {
      const detailed = await decryptFscpWireEnvelopeDetailed({ wire, ...viewer });
      expect(detailed.plaintext.blocks).toEqual([{ kind: "text", body }]);
      expect(detailed.frankingKeyBase64Url === null).toBe(!emitFrankTag);
    }
  });
});

describe("buildBlocksMessageWire пробрасывает параметр в ядро", () => {
  function material(sender: Party): FscpLocalMaterial {
    return {
      agreementPrivateKey: sender.box.privateKey.subarray(0, 32),
      signingPrivateKey: sender.sign.privateKey,
      deviceUuidFromServer: null,
    };
  }

  it("emitFrankTag: true доходит до конверта", async () => {
    const sender = newParty();
    const receiver = newParty();
    const wire = await buildBlocksMessageWire({
      senderUserUuid: SENDER,
      receiverUserUuid: RECEIVER,
      material: material(sender),
      receiverAgreementPublicKeyBase64: toBase64Url(receiver.box.publicKey),
      blocks: [{ kind: "text", body: "через messaging" }],
      emitFrankTag: true,
    });

    expect(peekFscpWireFrankTagBase64Url(wire)).not.toBeNull();
    const detailed = await decryptFscpWireEnvelopeDetailed({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
    });
    expect(detailed.frankingKeyBase64Url).not.toBeNull();
    expect(detailed.plaintext.blocks).toEqual([{ kind: "text", body: "через messaging" }]);
  });

  it("golden clock pins ids without a send-API override field", async () => {
    const sender = newParty();
    const receiver = newParty();
    const messageUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const messageKeyId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const createdAt = "2026-08-22T13:00:00.000Z";
    const wire = await withFloraGoldenClock(
      { uuids: [messageUuid, messageKeyId], createdAt },
      () =>
        buildWire({
          sender,
          receiver,
          body: "clock",
          emitFrankTag: true,
        }),
    );
    const env = decodeEnvelope(wire);
    expect(env.messageUuid).toBe(messageUuid);
    expect(env.messageKeyId).toBe(messageKeyId);
    expect(env.createdAt).toBe(createdAt);
  });

  it("без параметра — прежний untagged wire", async () => {
    const sender = newParty();
    const receiver = newParty();
    const wire = await buildBlocksMessageWire({
      senderUserUuid: SENDER,
      receiverUserUuid: RECEIVER,
      material: material(sender),
      receiverAgreementPublicKeyBase64: toBase64Url(receiver.box.publicKey),
      blocks: [{ kind: "text", body: "как в v1" }],
    });

    expect(peekFscpWireFrankTagBase64Url(wire)).toBeNull();
    expect(Object.keys(decodeEnvelope(wire))).toEqual(V1_ENVELOPE_KEYS);
  });
});
