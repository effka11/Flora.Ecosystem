/**
 * Раскрытие у ревьюера (Documents/fscp/franking.md §4.4, §4.7): обратный путь к
 * сборке жалобы — строгий разбор кортежа, разбор plaintext для показа, фасад с вердиктом.
 *
 * Кортеж приходит от жалобщика, поэтому негативы здесь — не «а вдруг сеть побила
 * байты», а «жалобщик подсунул»: чужая версия, лишнее поле, не-UUID, битый base64url,
 * обрезанный JSON. На каждом из них разбор обязан бросить, а не отдать половину кортежа.
 *
 * Источник истины для блоков — не ожидание в тесте, а другой путь той же библиотеки:
 * `decryptFscpWireEnvelope` на том же сообщении (транскрипт-вектор и живой wire).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { FSCP_BOOTSTRAP_DEVICE_UUID } from "./constants.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  decryptFscpWireEnvelopeDetailed,
  padPlaintextJsonV1,
  type FscpDecryptedWire,
  type FscpEnvelopeWire,
  type FscpMessagePlaintext,
} from "./envelope.js";
import {
  assembleFrankingReportV1,
  decodeFscpBase64Url,
  encodeFrankingComplaintDisclosureV1,
  frankReceiptPayloadV1,
  sealFrankingComplaintDisclosureV1,
  sealFrankingDisclosureV1,
  unwrapReportContentKeyV1,
  type FrankingComplaintDisclosureInputV1,
  type FrankingComplaintDisclosureV1,
} from "./franking.js";
import {
  decodeFrankingComplaintDisclosureV1,
  parseFrankedPlaintextV1,
  reviewFrankingComplaintDisclosureV1,
} from "./frankingDisclosure.js";
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
  text: string;
  plaintextUtf8: string;
  wire: string;
  uuids: Record<string, string | undefined>;
  keys: Record<string, string | undefined>;
};

const transcript = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-message-transcript-v1.json"), "utf8"),
) as TranscriptVector;

const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSISTED_MESSAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERVER_RECEIVED_AT = "2026-08-22T12:00:00.123Z";

type Party = {
  box: { publicKey: Uint8Array; privateKey: Uint8Array };
  sign: { publicKey: Uint8Array; privateKey: Uint8Array };
};

function newParty(): Party {
  return { box: sodium.crypto_box_keypair(), sign: sodium.crypto_sign_keypair() };
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

// ── 1. Строгий разбор кортежа ────────────────────────────────────────────────

function sampleComplaint(
  overrides: Partial<FrankingComplaintDisclosureInputV1> = {},
): FrankingComplaintDisclosureInputV1 {
  return {
    plaintextUtf8: utf8Bytes(padPlaintextJsonV1('{"type":"blocks","version":1,"blocks":[]}')),
    frankingKeyBase64Url: toBase64Url(new Uint8Array(32).fill(7)),
    frankTagBase64Url: toBase64Url(new Uint8Array(32).fill(9)),
    serverFrankReceipt: {
      signatureBase64Url: toBase64Url(new Uint8Array(64).fill(3)),
      serverFrankingKeyId: "franking-key-1",
      serverReceivedAt: SERVER_RECEIVED_AT,
    },
    messageUuid: "11111111-1111-4111-8111-111111111111",
    persistedMessageUuid: PERSISTED_MESSAGE,
    conversationUuid: "22222222-2222-4222-8222-222222222222",
    senderUserUuid: SENDER,
    senderDeviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
    receiverUserUuid: RECEIVER,
    createdAt: "2026-08-22T11:59:59.001Z",
    ...overrides,
  };
}

function expectedRecord(input: FrankingComplaintDisclosureInputV1): FrankingComplaintDisclosureV1 {
  return {
    v: 1,
    plaintextUtf8Base64Url: toBase64Url(input.plaintextUtf8),
    frankingKeyBase64Url: input.frankingKeyBase64Url,
    frankTagBase64Url: input.frankTagBase64Url,
    serverFrankReceipt: input.serverFrankReceipt,
    messageUuid: input.messageUuid,
    persistedMessageUuid: input.persistedMessageUuid,
    conversationUuid: input.conversationUuid,
    senderUserUuid: input.senderUserUuid,
    senderDeviceUuid: input.senderDeviceUuid,
    receiverUserUuid: input.receiverUserUuid,
    createdAt: input.createdAt,
  };
}

function encodedJson(input: FrankingComplaintDisclosureInputV1 = sampleComplaint()): string {
  return new TextDecoder().decode(encodeFrankingComplaintDisclosureV1(sodium, input));
}

function mutatedBytes(mutate: (o: Record<string, unknown>) => void): Uint8Array {
  const o = JSON.parse(encodedJson()) as Record<string, unknown>;
  mutate(o);
  return utf8Bytes(JSON.stringify(o));
}

describe("decodeFrankingComplaintDisclosureV1 — обратная к encode", () => {
  it("decode(encode(x)) совпадает по всем полям", () => {
    const input = sampleComplaint();
    const decoded = decodeFrankingComplaintDisclosureV1(
      encodeFrankingComplaintDisclosureV1(sodium, input),
    );

    expect(decoded).toEqual(expectedRecord(input));
    expect(decodeFscpBase64Url(sodium, decoded.plaintextUtf8Base64Url)).toEqual(input.plaintextUtf8);
  });

  it("нулевые поля untagged v1 переживают round-trip как null, а не как пустые строки", () => {
    const input = sampleComplaint({
      frankingKeyBase64Url: null,
      frankTagBase64Url: null,
      serverFrankReceipt: null,
    });
    const decoded = decodeFrankingComplaintDisclosureV1(
      encodeFrankingComplaintDisclosureV1(sodium, input),
    );

    expect(decoded).toEqual(expectedRecord(input));
    expect(decoded.frankingKeyBase64Url).toBeNull();
    expect(decoded.frankTagBase64Url).toBeNull();
    expect(decoded.serverFrankReceipt).toBeNull();
  });

  it("байты encode не меняются: re-encode разобранного кортежа даёт те же байты", () => {
    const original = encodeFrankingComplaintDisclosureV1(sodium, sampleComplaint());
    const decoded = decodeFrankingComplaintDisclosureV1(original);
    const reEncoded = encodeFrankingComplaintDisclosureV1(sodium, {
      plaintextUtf8: decodeFscpBase64Url(sodium, decoded.plaintextUtf8Base64Url),
      frankingKeyBase64Url: decoded.frankingKeyBase64Url,
      frankTagBase64Url: decoded.frankTagBase64Url,
      serverFrankReceipt: decoded.serverFrankReceipt,
      messageUuid: decoded.messageUuid,
      persistedMessageUuid: decoded.persistedMessageUuid,
      conversationUuid: decoded.conversationUuid,
      senderUserUuid: decoded.senderUserUuid,
      senderDeviceUuid: decoded.senderDeviceUuid,
      receiverUserUuid: decoded.receiverUserUuid,
      createdAt: decoded.createdAt,
    });

    expect(reEncoded).toEqual(original);
  });

  const NEGATIVES: readonly (readonly [string, () => Uint8Array, RegExp])[] = [
    ["чужая версия v", () => mutatedBytes((o) => { o.v = 2; }), /версия v=2 не поддерживается/],
    [
      "битый base64url",
      () => mutatedBytes((o) => { o.frankTagBase64Url = "AA+/BB=="; }),
      /frankTagBase64Url: не base64url/,
    ],
    ["не-UUID", () => mutatedBytes((o) => { o.messageUuid = "12345"; }), /messageUuid: ожидается UUID/],
    ["обрезанный JSON", () => utf8Bytes(encodedJson().slice(0, 64)), /не разбираются как JSON/],
    ["лишнее поле", () => mutatedBytes((o) => { o.reporterNote = "hi"; }), /лишнее поле «reporterNote»/],
  ];

  it.each(NEGATIVES)("негатив «%s» бросает и не отдаёт частичный кортеж", (_caseId, bytes, message) => {
    let decoded: FrankingComplaintDisclosureV1 | undefined;
    expect(() => {
      decoded = decodeFrankingComplaintDisclosureV1(bytes());
    }).toThrow(message);
    expect(decoded).toBeUndefined();
  });

  it("строгость распространяется на пропуски, форму и вложенную квитанцию", () => {
    expect(() =>
      decodeFrankingComplaintDisclosureV1(mutatedBytes((o) => { delete o.createdAt; })),
    ).toThrow(/отсутствует поле «createdAt»/);
    expect(() =>
      decodeFrankingComplaintDisclosureV1(mutatedBytes((o) => { delete o.v; })),
    ).toThrow(/нет поля версии/);
    expect(() =>
      decodeFrankingComplaintDisclosureV1(mutatedBytes((o) => { o.serverFrankReceipt = "sig"; })),
    ).toThrow(/serverFrankReceipt: ожидается объект или null/);
    expect(() =>
      decodeFrankingComplaintDisclosureV1(
        mutatedBytes((o) => {
          o.serverFrankReceipt = { ...(o.serverFrankReceipt as object), keyEpoch: 2 };
        }),
      ),
    ).toThrow(/serverFrankReceipt: лишнее поле «keyEpoch»/);
    expect(() =>
      decodeFrankingComplaintDisclosureV1(
        mutatedBytes((o) => {
          o.serverFrankReceipt = { ...(o.serverFrankReceipt as object), signatureBase64Url: null };
        }),
      ),
    ).toThrow(/serverFrankReceipt\.signatureBase64Url: ожидается строка/);
    // Длина base64url с остатком 1 по модулю 4 недостижима — libsodium её тоже отвергает.
    expect(() =>
      decodeFrankingComplaintDisclosureV1(mutatedBytes((o) => { o.frankingKeyBase64Url = "AAAAA"; })),
    ).toThrow(/frankingKeyBase64Url: не base64url/);
    expect(() => decodeFrankingComplaintDisclosureV1(utf8Bytes("[]"))).toThrow(/ожидается JSON-объект/);
  });
});

// ── 2. Разбор plaintext для просмотра ────────────────────────────────────────

async function wireWithPayload(payload: FscpMessagePlaintext): Promise<FscpDecryptedWire> {
  const sender = newParty();
  const receiver = newParty();
  const wire = await buildFscpWireEnvelope({
    senderUserUuid: SENDER,
    receiverUserUuid: RECEIVER,
    senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
    senderSigningPrivateKey: sender.sign.privateKey,
    receiverAgreementPublicKey: receiver.box.publicKey,
    messagePayload: payload,
    emitFrankTag: true,
  });
  return decryptFscpWireEnvelopeDetailed({
    wire,
    viewerUserUuid: RECEIVER,
    agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
  });
}

describe("parseFrankedPlaintextV1 — те же блоки, что видел получатель", () => {
  it("на байтах транскрипт-вектора совпадает с decryptFscpWireEnvelope", async () => {
    const viaDecrypt = await decryptFscpWireEnvelope({
      wire: transcript.wire,
      viewerUserUuid: transcript.uuids.receiverUserUuid ?? "",
      agreementPrivateKey: fromBase64Url(transcript.keys.receiverAgreementPrivateKeyBase64Url ?? ""),
    });
    const viaDisclosure = parseFrankedPlaintextV1(utf8Bytes(transcript.plaintextUtf8));

    expect(viaDisclosure).toEqual(viaDecrypt);
    expect(viaDisclosure.blocks).toEqual([{ kind: "text", body: transcript.text }]);
  });

  it("паддинг снят: результат не содержит ни pad, ни frankingKey из plaintext", async () => {
    const detailed = await wireWithPayload({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: "паддинг не должен доехать до ревьюера" }],
      clientCreatedAt: "2026-08-22T11:00:00.000Z",
    });
    const paddedJson = new TextDecoder().decode(detailed.plaintextUtf8);
    expect(paddedJson).toContain('"pad":"');
    expect(paddedJson).toContain('"frankingKeyBase64Url":');

    const parsed = parseFrankedPlaintextV1(detailed.plaintextUtf8);
    expect(parsed).toEqual(detailed.plaintext);
    expect(Object.keys(parsed)).toEqual(["type", "version", "blocks", "clientCreatedAt"]);
  });

  it("блок неизвестного вида доезжает placeholder'ом kind: unknown, как при decrypt", async () => {
    const detailed = await wireWithPayload({
      type: "blocks",
      version: 1,
      blocks: [
        { kind: "text", body: "старый клиент" },
        { kind: "hologram", payload: "из более новой схемы" },
      ],
      clientCreatedAt: "2026-08-22T11:05:00.000Z",
    } as unknown as FscpMessagePlaintext);

    const parsed = parseFrankedPlaintextV1(detailed.plaintextUtf8);
    expect(parsed.blocks).toEqual([
      { kind: "text", body: "старый клиент" },
      { kind: "unknown", originalKind: "hologram" },
    ]);
    expect(parsed).toEqual(detailed.plaintext);
  });

  it("медиа-блок отдаётся с метаданными и AES-ключом как есть (§4.6)", async () => {
    const image = {
      kind: "image" as const,
      assetUuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      contentType: "image/webp",
      encryption: {
        algorithm: "aes-gcm" as const,
        keyBase64Url: toBase64Url(new Uint8Array(32).fill(5)),
        nonceBase64Url: toBase64Url(new Uint8Array(12).fill(6)),
      },
    };
    const detailed = await wireWithPayload({
      type: "blocks",
      version: 1,
      blocks: [image],
      clientCreatedAt: "2026-08-22T11:10:00.000Z",
    });

    expect(parseFrankedPlaintextV1(detailed.plaintextUtf8).blocks).toEqual([image]);
  });

  it("не-JSON и не-plaintext байты бросают", () => {
    expect(() => parseFrankedPlaintextV1(utf8Bytes("не json"))).toThrow(/не разбирается как JSON/);
    expect(() => parseFrankedPlaintextV1(utf8Bytes('{"type":"blocks"}'))).toThrow(
      /Неверный plaintext сообщения/,
    );
  });
});

// ── 3. Фасад ревьюера ────────────────────────────────────────────────────────

type FrankedComplaint = {
  env: FscpEnvelopeWire;
  detailed: FscpDecryptedWire;
  complaint: FrankingComplaintDisclosureInputV1;
  serverFranking: { publicKey: Uint8Array; privateKey: Uint8Array };
};

async function frankedComplaint(body: string, emitFrankTag = true): Promise<FrankedComplaint> {
  const sender = newParty();
  const receiver = newParty();
  const serverFranking = sodium.crypto_sign_keypair();
  const wire = await buildFscpWireEnvelope({
    senderUserUuid: SENDER,
    receiverUserUuid: RECEIVER,
    senderAgreementPrivateKey: sender.box.privateKey.subarray(0, 32),
    senderSigningPrivateKey: sender.sign.privateKey,
    receiverAgreementPublicKey: receiver.box.publicKey,
    messageBody: body,
    emitFrankTag,
  });
  const detailed = await decryptFscpWireEnvelopeDetailed({
    wire,
    viewerUserUuid: RECEIVER,
    agreementPrivateKey: receiver.box.privateKey.subarray(0, 32),
  });
  const env = detailed.envelope;
  const frankTagBase64Url = env.frankTagBase64Url ?? null;

  const serverFrankReceipt = frankTagBase64Url
    ? {
        signatureBase64Url: toBase64Url(
          sodium.crypto_sign_detached(
            utf8Bytes(
              frankReceiptPayloadV1({
                frankTagBase64Url,
                messageUuid: env.messageUuid,
                conversationUuid: env.conversationUuid,
                senderUserUuid: env.senderUserUuid,
                receiverUserUuid: RECEIVER,
                serverReceivedAt: SERVER_RECEIVED_AT,
              }),
            ),
            serverFranking.privateKey,
          ),
        ),
        serverFrankingKeyId: "franking-key-1",
        serverReceivedAt: SERVER_RECEIVED_AT,
      }
    : null;

  return {
    env,
    detailed,
    serverFranking,
    complaint: {
      plaintextUtf8: detailed.plaintextUtf8,
      frankingKeyBase64Url: detailed.frankingKeyBase64Url,
      frankTagBase64Url,
      serverFrankReceipt,
      messageUuid: env.messageUuid,
      persistedMessageUuid: PERSISTED_MESSAGE,
      conversationUuid: env.conversationUuid,
      senderUserUuid: env.senderUserUuid,
      senderDeviceUuid: env.senderDeviceUuid,
      receiverUserUuid: RECEIVER,
      createdAt: env.createdAt,
    },
  };
}

function review(fixture: FrankedComplaint, complaint = fixture.complaint) {
  const sealed = sealFrankingDisclosureV1(
    sodium,
    encodeFrankingComplaintDisclosureV1(sodium, complaint),
  );
  return reviewFrankingComplaintDisclosureV1(sodium, {
    sealed: sealed.sealed,
    reportContentKey: sealed.reportContentKey,
    serverFrankingPublicKey: fixture.serverFranking.publicKey,
  });
}

describe("reviewFrankingComplaintDisclosureV1 — фасад ревьюера", () => {
  it("на реальном wire: verified, кортеж и блоки совпадают с тем, что открыл получатель", async () => {
    const fixture = await frankedComplaint("недопустимое сообщение");
    const result = review(fixture);

    expect(result.verification.ok).toBe(true);
    expect(result.verification).toMatchObject({
      commitInputUtf8: expect.stringContaining("flora.fscp.franking.v1 | "),
      receiptPayloadUtf8: expect.stringContaining("flora.fscp.franking-receipt.v1 | "),
    });
    expect(result.plaintext).toEqual(fixture.detailed.plaintext);
    expect(result.plaintext?.blocks).toEqual([{ kind: "text", body: "недопустимое сообщение" }]);
    expect(result.tuple?.plaintextUtf8).toEqual(fixture.detailed.plaintextUtf8);
    expect(result.tuple?.frankTag).toEqual(fromBase64Url(fixture.env.frankTagBase64Url ?? ""));
    expect(result.tuple?.commit).toEqual({
      conversationUuid: fixture.env.conversationUuid,
      messageUuid: fixture.env.messageUuid,
      senderUserUuid: fixture.env.senderUserUuid,
      senderDeviceUuid: fixture.env.senderDeviceUuid,
      receiverUserUuid: RECEIVER,
      createdAt: fixture.env.createdAt,
    });
    expect(result.disclosure.persistedMessageUuid).toBe(PERSISTED_MESSAGE);
  });

  it("подменённый plaintext — not verified (commit-mismatch)", async () => {
    const fixture = await frankedComplaint("исходное сообщение");
    const tampered = new TextDecoder()
      .decode(fixture.detailed.plaintextUtf8)
      .replace("исходное сообщение", "подмененное сообщ");
    expect(tampered).not.toBe(new TextDecoder().decode(fixture.detailed.plaintextUtf8));

    const result = review(fixture, { ...fixture.complaint, plaintextUtf8: utf8Bytes(tampered) });

    expect(result.verification).toEqual({ ok: false, reason: "commit-mismatch" });
    // Ревьюер всё равно видит, что именно ему показывают, — иначе не написать отказ.
    expect(result.plaintext?.blocks).toEqual([{ kind: "text", body: "подмененное сообщ" }]);
  });

  it("чужой frankingKey — not verified (commit-mismatch)", async () => {
    const fixture = await frankedComplaint("сообщение с чужим ключом");
    const result = review(fixture, {
      ...fixture.complaint,
      frankingKeyBase64Url: toBase64Url(sodium.randombytes_buf(32)),
    });

    expect(result.verification).toEqual({ ok: false, reason: "commit-mismatch" });
    expect(result.tuple).not.toBeNull();
  });

  it("испорченная подпись квитанции — not verified (receipt-signature-invalid)", async () => {
    const fixture = await frankedComplaint("сообщение с битой квитанцией");
    const receipt = fixture.complaint.serverFrankReceipt;
    if (!receipt) throw new Error("фикстура обязана содержать квитанцию");
    const signature = fromBase64Url(receipt.signatureBase64Url);
    signature[0] = (signature[0] ?? 0) ^ 0xff;

    const result = review(fixture, {
      ...fixture.complaint,
      serverFrankReceipt: { ...receipt, signatureBase64Url: toBase64Url(signature) },
    });

    expect(result.verification).toEqual({ ok: false, reason: "receipt-signature-invalid" });
  });

  it("подпись не той длины — тоже вердикт, а не исключение libsodium", async () => {
    const fixture = await frankedComplaint("обрезанная подпись");
    const receipt = fixture.complaint.serverFrankReceipt;
    if (!receipt) throw new Error("фикстура обязана содержать квитанцию");

    const result = review(fixture, {
      ...fixture.complaint,
      serverFrankReceipt: {
        ...receipt,
        signatureBase64Url: toBase64Url(fromBase64Url(receipt.signatureBase64Url).subarray(0, 32)),
      },
    });

    expect(result.verification).toEqual({ ok: false, reason: "receipt-signature-invalid" });
  });

  it("frankingKey не 32 байта — вердикт commit-mismatch, а не падение фасада", async () => {
    const fixture = await frankedComplaint("короткий ключ");
    const result = review(fixture, {
      ...fixture.complaint,
      frankingKeyBase64Url: toBase64Url(new Uint8Array(16)),
    });

    expect(result.verification).toEqual({ ok: false, reason: "commit-mismatch" });
  });

  it("чужой серверный ключ — not verified (receipt-signature-invalid)", async () => {
    const fixture = await frankedComplaint("подписано не тем сервером");
    const sealed = sealFrankingComplaintDisclosureV1(sodium, fixture.complaint);
    const result = reviewFrankingComplaintDisclosureV1(sodium, {
      sealed: sealed.disclosureCiphertext,
      reportContentKey: sealed.reportContentKey,
      serverFrankingPublicKey: sodium.crypto_sign_keypair().publicKey,
    });

    expect(result.verification).toEqual({ ok: false, reason: "receipt-signature-invalid" });
  });

  it("жалоба на untagged v1 — unverifiable с перечнем отсутствующего, блоки всё равно видны", async () => {
    const fixture = await frankedComplaint("сообщение без франкования", false);
    expect(fixture.env.frankTagBase64Url).toBeUndefined();

    const result = review(fixture);

    expect(result.verification).toEqual({
      ok: false,
      reason: "unverifiable",
      missing: ["frankingKeyBase64Url", "frankTagBase64Url", "serverFrankReceipt"],
    });
    expect(result.tuple).toBeNull();
    expect(result.plaintext?.blocks).toEqual([{ kind: "text", body: "сообщение без франкования" }]);
  });

  it("нечитаемый plaintext не прячет вердикт: блоки null, причина видна", async () => {
    const fixture = await frankedComplaint("мусор вместо plaintext");
    const result = review(fixture, {
      ...fixture.complaint,
      plaintextUtf8: utf8Bytes("не json вовсе"),
    });

    expect(result.plaintext).toBeNull();
    expect(result.verification).toEqual({ ok: false, reason: "commit-mismatch" });
  });

  it("путь клиента целиком: assemble → unwrap wrapped key → один вызов фасада", async () => {
    const fixture = await frankedComplaint("жалоба через полный путь");
    const reviewerDevice = sodium.crypto_box_keypair();
    const reviewerTarget = {
      userUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      deviceUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      agreementPublicKey: reviewerDevice.publicKey,
    };

    const assembled = assembleFrankingReportV1(sodium, {
      complaint: fixture.complaint,
      wrapTargets: [reviewerTarget],
    });
    const wrap = assembled.wraps[0];
    if (!wrap) throw new Error("wrap ревьюера не собран");

    const result = reviewFrankingComplaintDisclosureV1(sodium, {
      sealed: assembled.disclosureCiphertext,
      reportContentKey: unwrapReportContentKeyV1(sodium, {
        wrappedKey: wrap.wrappedKey,
        persistedMessageUuid: PERSISTED_MESSAGE,
        userUuid: reviewerTarget.userUuid,
        deviceUuid: reviewerTarget.deviceUuid,
        agreementPrivateKey: reviewerDevice.privateKey.subarray(0, 32),
      }),
      serverFrankingPublicKey: fixture.serverFranking.publicKey,
    });

    expect(result.verification.ok).toBe(true);
    expect(result.plaintext?.blocks).toEqual([{ kind: "text", body: "жалоба через полный путь" }]);
  });

  it("чужой reportContentKey не открывает заявку", async () => {
    const fixture = await frankedComplaint("не для этого ревьюера");
    const sealed = sealFrankingComplaintDisclosureV1(sodium, fixture.complaint);

    expect(() =>
      reviewFrankingComplaintDisclosureV1(sodium, {
        sealed: sealed.disclosureCiphertext,
        reportContentKey: sodium.randombytes_buf(32),
        serverFrankingPublicKey: fixture.serverFranking.publicKey,
      }),
    ).toThrow();
  });
});
