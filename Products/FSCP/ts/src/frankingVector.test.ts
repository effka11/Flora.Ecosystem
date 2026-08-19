/**
 * Consumer golden-вектора franking-v1.json (Documents/fscp/franking.md §5):
 * эталонная реализация franking.ts воспроизводит commitInput/frankTag/receiptPayload
 * байт-в-байт и проходит полный verify-путь жюри; негативы падают с задекларированной
 * причиной. Вектор франкует сообщение из fscp-message-transcript-v1.json — жалоба
 * доказуема для реального транскрипта.
 * Регенерация: python Documents/test-vectors/_gen_fscp_franking_v1.py
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { peekFscpWireFrankTagBase64Url } from "./envelope.js";
import { FSCP_WIRE_PREFIX } from "./constants.js";
import {
  assembleFrankingReportV1,
  computeFrankTagV1,
  constantTimeEqual,
  decodeFscpBase64Url,
  encodeFscpBase64Url,
  encodeFrankingComplaintDisclosureV1,
  frankingReportBlockedByMissingReceipt,
  frankCommitInputV1,
  frankReceiptPayloadV1,
  openFrankingDisclosureV1,
  sealFrankingComplaintDisclosureV1,
  sealFrankingDisclosureV1,
  unwrapReportContentKeyV1,
  verifyFrankedMessageV1,
  wrapReportContentKeyV1,
  type FrankComplaintTupleV1,
} from "./franking.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors",
);

type FrankingVector = {
  vectorId: string;
  uuids: {
    conversationUuid: string;
    messageUuid: string;
    senderUserUuid: string;
    senderDeviceUuid: string;
    receiverUserUuid: string;
  };
  createdAt: string;
  plaintextUtf8: string;
  plaintextSha256Base64Url: string;
  frankingKeyBase64Url: string;
  commitInputUtf8: string;
  frankTagBase64Url: string;
  server: { frankingPublicKeyBase64Url: string };
  receiptPayloadUtf8: string;
  receipt: { signatureBase64Url: string; serverFrankingKeyId: string; serverReceivedAt: string };
  negatives: {
    caseId: string;
    plaintextUtf8?: string;
    frankingKeyBase64Url?: string;
    receiptSignatureBase64Url?: string;
    messageUuid?: string;
    serverReceivedAt?: string;
    expectedFailure: "commit-mismatch" | "receipt-signature-invalid";
  }[];
};

const v = JSON.parse(readFileSync(path.join(vectorsDir, "franking-v1.json"), "utf8")) as FrankingVector;

const transcript = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-message-transcript-v1.json"), "utf8"),
) as { plaintextUtf8: string; uuids: Record<string, string>; createdAt: string };

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

function goldenTuple(): FrankComplaintTupleV1 {
  return {
    plaintextUtf8: utf8Bytes(v.plaintextUtf8),
    frankingKey: fromBase64Url(v.frankingKeyBase64Url),
    frankTag: fromBase64Url(v.frankTagBase64Url),
    receipt: v.receipt,
    commit: {
      conversationUuid: v.uuids.conversationUuid,
      messageUuid: v.uuids.messageUuid,
      senderUserUuid: v.uuids.senderUserUuid,
      senderDeviceUuid: v.uuids.senderDeviceUuid,
      receiverUserUuid: v.uuids.receiverUserUuid,
      createdAt: v.createdAt,
    },
  };
}

describe("golden: franking-v1.json (FSCP-FRANK, эталонная реализация)", () => {
  it("франкуется ровно сообщение транскрипт-вектора (связка векторов)", () => {
    expect(v.plaintextUtf8).toBe(transcript.plaintextUtf8);
    expect(v.uuids.messageUuid).toBe(transcript.uuids.messageUuid);
    expect(v.createdAt).toBe(transcript.createdAt);
  });

  it("commitInput воспроизводится байт-в-байт (включая SHA-256 plaintext)", () => {
    const ci = frankCommitInputV1(goldenTuple().commit, utf8Bytes(v.plaintextUtf8));
    expect(ci).toBe(v.commitInputUtf8);
    expect(ci).toContain(v.plaintextSha256Base64Url);
  });

  it("frankTag = HMAC-SHA-256(frankingKey, commitInput)", () => {
    const tag = computeFrankTagV1(fromBase64Url(v.frankingKeyBase64Url), v.commitInputUtf8);
    expect(tag.length).toBe(32);
    expect(toBase64Url(tag)).toBe(v.frankTagBase64Url);
  });

  it("receiptPayload воспроизводится байт-в-байт", () => {
    expect(
      frankReceiptPayloadV1({
        frankTagBase64Url: v.frankTagBase64Url,
        messageUuid: v.uuids.messageUuid,
        conversationUuid: v.uuids.conversationUuid,
        senderUserUuid: v.uuids.senderUserUuid,
        receiverUserUuid: v.uuids.receiverUserUuid,
        serverReceivedAt: v.receipt.serverReceivedAt,
      }),
    ).toBe(v.receiptPayloadUtf8);
  });

  it("полный verify-путь жюри проходит на golden-кортеже", () => {
    const result = verifyFrankedMessageV1({
      sodium,
      tuple: goldenTuple(),
      receiptSignature: fromBase64Url(v.receipt.signatureBase64Url),
      serverFrankingPublicKey: fromBase64Url(v.server.frankingPublicKeyBase64Url),
    });
    expect(result).toMatchObject({
      ok: true,
      commitInputUtf8: v.commitInputUtf8,
      receiptPayloadUtf8: v.receiptPayloadUtf8,
    });
  });

  it.each(v.negatives.map((n) => [n.caseId, n] as const))(
    "негатив %s падает с задекларированной причиной",
    (_caseId, negative) => {
      const tuple = goldenTuple();
      if (negative.plaintextUtf8 !== undefined) tuple.plaintextUtf8 = utf8Bytes(negative.plaintextUtf8);
      if (negative.frankingKeyBase64Url !== undefined) {
        tuple.frankingKey = fromBase64Url(negative.frankingKeyBase64Url);
      }
      if (negative.messageUuid !== undefined) tuple.commit.messageUuid = negative.messageUuid;
      if (negative.serverReceivedAt !== undefined) {
        tuple.receipt = { ...tuple.receipt, serverReceivedAt: negative.serverReceivedAt };
      }
      const signature = fromBase64Url(negative.receiptSignatureBase64Url ?? v.receipt.signatureBase64Url);

      const result = verifyFrankedMessageV1({
        sodium,
        tuple,
        receiptSignature: signature,
        serverFrankingPublicKey: fromBase64Url(v.server.frankingPublicKeyBase64Url),
      });
      expect(result).toEqual({ ok: false, reason: negative.expectedFailure });
    },
  );

  it("frankingKey строго 32 байта; constantTimeEqual честно сравнивает", () => {
    expect(() => computeFrankTagV1(new Uint8Array(16), "x")).toThrow("32 байта");
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it("disclosure seal roundtrip: nonce||ciphertext, AAD привязан", () => {
    const plaintext = utf8Bytes('{"v":1,"persistedMessageUuid":"x"}');
    const { reportContentKey, sealed } = sealFrankingDisclosureV1(sodium, plaintext);
    expect(reportContentKey.length).toBe(32);
    expect(sealed.length).toBeGreaterThan(24);
    expect(openFrankingDisclosureV1(sodium, sealed, reportContentKey)).toEqual(plaintext);
  });

  it("encodeFscpBase64Url uses sodium.to_base64 URLSAFE_NO_PADDING, not btoa", () => {
    const calls: number[] = [];
    const encoded = encodeFscpBase64Url(
      {
        to_base64: (_bytes, variant) => {
          calls.push(variant);
          return "ok";
        },
        from_base64: () => new Uint8Array(),
        base64_variants: { URLSAFE_NO_PADDING: 7 },
      },
      new Uint8Array([1, 2, 3]),
    );
    expect(encoded).toBe("ok");
    expect(calls).toEqual([7]);
  });

  it("complaint disclosure encodes AEAD plaintext bytes, not preview text", () => {
    const plaintextUtf8 = utf8Bytes('{"type":"blocks","pad":"000"}');
    const encoded = encodeFrankingComplaintDisclosureV1(sodium, {
      plaintextUtf8,
      frankingKeyBase64Url: "kf",
      frankTagBase64Url: "tag",
      serverFrankReceipt: {
        signatureBase64Url: "sig",
        serverFrankingKeyId: "kid",
        serverReceivedAt: "2026-01-01T00:00:00.000Z",
      },
      messageUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      persistedMessageUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      conversationUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      senderUserUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      senderDeviceUuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      receiverUserUuid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const json = JSON.parse(new TextDecoder().decode(encoded)) as {
      plaintextUtf8Base64Url: string;
      frankingKeyBase64Url: string;
    };
    expect(decodeFscpBase64Url(sodium, json.plaintextUtf8Base64Url)).toEqual(plaintextUtf8);
    expect(json.frankingKeyBase64Url).toBe("kf");
    const { disclosureCiphertext } = sealFrankingComplaintDisclosureV1(sodium, {
      plaintextUtf8,
      frankingKeyBase64Url: null,
      frankTagBase64Url: null,
      serverFrankReceipt: null,
      messageUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      persistedMessageUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      conversationUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      senderUserUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      senderDeviceUuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      receiverUserUuid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(disclosureCiphertext.length).toBeGreaterThan(8);
    expect(disclosureCiphertext.includes("+")).toBe(false);
    expect(disclosureCiphertext.includes("/")).toBe(false);
  });

  it("wraps reportContentKey to a device agreement key", () => {
    const recipient = sodium.crypto_box_keypair();
    const reportContentKey = sodium.randombytes_buf(32);
    const target = {
      userUuid: "11111111-1111-1111-1111-111111111111",
      deviceUuid: "22222222-2222-2222-2222-222222222222",
      agreementPublicKey: recipient.publicKey,
    };
    const wrapped = wrapReportContentKeyV1(sodium, {
      reportContentKey,
      persistedMessageUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      target,
    });
    expect(
      unwrapReportContentKeyV1(sodium, {
        wrappedKey: wrapped.wrappedKey,
        persistedMessageUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        userUuid: target.userUuid,
        deviceUuid: target.deviceUuid,
        agreementPrivateKey: recipient.privateKey.subarray(0, 32),
      }),
    ).toEqual(reportContentKey);

    const assembled = assembleFrankingReportV1(sodium, {
      complaint: {
        plaintextUtf8: utf8Bytes("pt"),
        frankingKeyBase64Url: null,
        frankTagBase64Url: null,
        serverFrankReceipt: null,
        messageUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        persistedMessageUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        conversationUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        senderUserUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        senderDeviceUuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        receiverUserUuid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      wrapTargets: [target],
    });
    expect(assembled.wraps).toHaveLength(1);
    expect(assembled.disclosureCiphertext.length).toBeGreaterThan(8);
  });

  it("blocks tagged messages without a receipt and allows untagged v1", () => {
    expect(
      frankingReportBlockedByMissingReceipt({
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: false,
      }),
    ).toBe(true);
    expect(
      frankingReportBlockedByMissingReceipt({
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: true,
      }),
    ).toBe(false);
    expect(
      frankingReportBlockedByMissingReceipt({
        frankTagBase64Url: null,
        hasServerFrankReceipt: false,
      }),
    ).toBe(false);
  });
});

describe("peekFscpWireFrankTagBase64Url", () => {
  it("reads frankTag from envelope JSON without decrypting", () => {
    const wire = `${FSCP_WIRE_PREFIX}${toBase64Url(utf8Bytes(JSON.stringify({ frankTagBase64Url: "tag" })))}`;
    expect(peekFscpWireFrankTagBase64Url(wire)).toBe("tag");
    expect(peekFscpWireFrankTagBase64Url(`${FSCP_WIRE_PREFIX}${toBase64Url(utf8Bytes("{}"))}`)).toBeNull();
    expect(peekFscpWireFrankTagBase64Url("not-fscp")).toBeNull();
  });
});
