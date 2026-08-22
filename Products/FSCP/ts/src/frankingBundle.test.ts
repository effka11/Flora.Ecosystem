import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { utf8Bytes } from "./base64url.js";
import {
  assembleFrankingReportV2,
  computeFrankTagV1,
  decodeFrankingComplaintBundleV2,
  encodeFrankingComplaintBundleV2,
  encodeFrankingComplaintDisclosureV1,
  frankCommitInputV1,
  frankReceiptPayloadV1,
  frankingWrapAadV2,
  FSCP_FRANKING_BUNDLE_MAX_MESSAGES,
  unwrapReportContentKeyV2,
  type FrankingComplaintDisclosureInputV1,
} from "./franking.js";
import {
  decodeFrankingComplaintDisclosureV1,
  reviewFrankingComplaintBundleV2,
} from "./frankingDisclosure.js";
import type { SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const BUNDLE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEWER_USER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEWER_DEVICE_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_BUNDLE_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_DEVICE_UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SERVER_RECEIVED_AT = "2026-08-22T18:00:00.123Z";

beforeAll(async () => {
  await sodium.ready;
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function complaintMetadata(index: number) {
  const base = index * 10;
  return {
    messageUuid: uuid(base + 1),
    persistedMessageUuid: uuid(base + 2),
    conversationUuid: uuid(1_000),
    senderUserUuid: uuid(1_001),
    senderDeviceUuid: uuid(1_002),
    receiverUserUuid: uuid(1_003),
    createdAt: `2026-08-22T18:00:${index.toString().padStart(2, "0")}.000Z`,
  };
}

function untaggedComplaint(index: number): FrankingComplaintDisclosureInputV1 {
  return {
    plaintextUtf8: utf8Bytes(
      JSON.stringify({
        type: "blocks",
        version: 1,
        blocks: [{ kind: "text", body: `сообщение ${index}` }],
      }),
    ),
    frankingKeyBase64Url: null,
    frankTagBase64Url: null,
    serverFrankReceipt: null,
    ...complaintMetadata(index),
  };
}

function taggedComplaint(
  index: number,
  serverFrankingPrivateKey: Uint8Array,
): FrankingComplaintDisclosureInputV1 {
  const complaint = untaggedComplaint(index);
  const frankingKey = new Uint8Array(32).fill(index);
  const commit = {
    conversationUuid: complaint.conversationUuid,
    messageUuid: complaint.messageUuid,
    senderUserUuid: complaint.senderUserUuid,
    senderDeviceUuid: complaint.senderDeviceUuid,
    receiverUserUuid: complaint.receiverUserUuid,
    createdAt: complaint.createdAt,
  };
  const frankTag = computeFrankTagV1(
    frankingKey,
    frankCommitInputV1(commit, complaint.plaintextUtf8),
  );
  const frankTagBase64Url = toBase64Url(frankTag);
  const receiptPayload = frankReceiptPayloadV1({
    frankTagBase64Url,
    messageUuid: complaint.messageUuid,
    conversationUuid: complaint.conversationUuid,
    senderUserUuid: complaint.senderUserUuid,
    receiverUserUuid: complaint.receiverUserUuid,
    serverReceivedAt: SERVER_RECEIVED_AT,
  });
  return {
    ...complaint,
    frankingKeyBase64Url: toBase64Url(frankingKey),
    frankTagBase64Url,
    serverFrankReceipt: {
      signatureBase64Url: toBase64Url(
        sodium.crypto_sign_detached(utf8Bytes(receiptPayload), serverFrankingPrivateKey),
      ),
      serverFrankingKeyId: "franking-key-1",
      serverReceivedAt: SERVER_RECEIVED_AT,
    },
  };
}

describe("FrankingComplaintBundleV2 — контейнер независимых кортежей", () => {
  it.each([1, 3, FSCP_FRANKING_BUNDLE_MAX_MESSAGES])(
    "roundtrip encode/decode сохраняет %i сообщений",
    (messageCount) => {
      const messages = Array.from({ length: messageCount }, (_, index) =>
        untaggedComplaint(index + 1),
      );

      const decoded = decodeFrankingComplaintBundleV2(
        encodeFrankingComplaintBundleV2(sodium, {
          bundleUuid: BUNDLE_UUID,
          messages,
        }),
      );

      expect(decoded.v).toBe(2);
      expect(decoded.bundleUuid).toBe(BUNDLE_UUID);
      expect(decoded.messages).toHaveLength(messageCount);
      expect(decoded.messages).toEqual(
        messages.map((message) =>
          decodeFrankingComplaintDisclosureV1(
            encodeFrankingComplaintDisclosureV1(sodium, message),
          ),
        ),
      );
    },
  );

  it("отклоняет 21 сообщение и на encode, и на decode", () => {
    const messages = Array.from(
      { length: FSCP_FRANKING_BUNDLE_MAX_MESSAGES + 1 },
      (_, index) => untaggedComplaint(index + 1),
    );
    expect(() =>
      encodeFrankingComplaintBundleV2(sodium, {
        bundleUuid: BUNDLE_UUID,
        messages,
      }),
    ).toThrow(/от 1 до 20 сообщений; получено 21/);

    const encodedAtCap = encodeFrankingComplaintBundleV2(sodium, {
      bundleUuid: BUNDLE_UUID,
      messages: messages.slice(0, FSCP_FRANKING_BUNDLE_MAX_MESSAGES),
    });
    const oversized = JSON.parse(new TextDecoder().decode(encodedAtCap)) as {
      messages: unknown[];
    };
    oversized.messages.push(oversized.messages[0]);
    expect(() =>
      decodeFrankingComplaintBundleV2(utf8Bytes(JSON.stringify(oversized))),
    ).toThrow(/от 1 до 20 сообщений; получено 21/);
  });
});

describe("franking wrap v2 — scope bundleUuid + устройство", () => {
  it("открывается только своим bundleUuid, deviceUuid и private key", () => {
    const reviewerDevice = sodium.crypto_box_keypair();
    const foreignDevice = sodium.crypto_box_keypair();
    const target = {
      userUuid: REVIEWER_USER_UUID,
      deviceUuid: REVIEWER_DEVICE_UUID,
      agreementPublicKey: reviewerDevice.publicKey,
    };
    const assembled = assembleFrankingReportV2(sodium, {
      messages: [untaggedComplaint(1)],
      wrapTargets: [target],
    });
    const wrap = assembled.wraps[0];
    if (!wrap) throw new Error("wrap ревьюера не собран");

    expect(
      frankingWrapAadV2({
        bundleUuid: BUNDLE_UUID.toUpperCase(),
        userUuid: REVIEWER_USER_UUID.toUpperCase(),
        deviceUuid: REVIEWER_DEVICE_UUID.toUpperCase(),
      }),
    ).toBe(
      `flora.fscp.franking-wrap.v2 | ${BUNDLE_UUID} | ${REVIEWER_USER_UUID} | ${REVIEWER_DEVICE_UUID}`,
    );

    const reportContentKey = unwrapReportContentKeyV2(sodium, {
      wrappedKey: wrap.wrappedKey,
      bundleUuid: assembled.bundleUuid,
      userUuid: target.userUuid,
      deviceUuid: target.deviceUuid,
      agreementPrivateKey: reviewerDevice.privateKey.subarray(0, 32),
    });
    const review = reviewFrankingComplaintBundleV2(sodium, {
      sealed: assembled.disclosureCiphertext,
      reportContentKey,
      serverFrankingPublicKey: sodium.crypto_sign_keypair().publicKey,
    });
    expect(assembled.bundleUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(review.bundle.bundleUuid).toBe(assembled.bundleUuid);

    expect(() =>
      unwrapReportContentKeyV2(sodium, {
        wrappedKey: wrap.wrappedKey,
        bundleUuid: FOREIGN_BUNDLE_UUID,
        userUuid: target.userUuid,
        deviceUuid: target.deviceUuid,
        agreementPrivateKey: reviewerDevice.privateKey.subarray(0, 32),
      }),
    ).toThrow();
    expect(() =>
      unwrapReportContentKeyV2(sodium, {
        wrappedKey: wrap.wrappedKey,
        bundleUuid: assembled.bundleUuid,
        userUuid: target.userUuid,
        deviceUuid: FOREIGN_DEVICE_UUID,
        agreementPrivateKey: reviewerDevice.privateKey.subarray(0, 32),
      }),
    ).toThrow();
    expect(() =>
      unwrapReportContentKeyV2(sodium, {
        wrappedKey: wrap.wrappedKey,
        bundleUuid: assembled.bundleUuid,
        userUuid: target.userUuid,
        deviceUuid: target.deviceUuid,
        agreementPrivateKey: foreignDevice.privateKey.subarray(0, 32),
      }),
    ).toThrow();
  });
});

describe("reviewFrankingComplaintBundleV2 — поэлементные вердикты", () => {
  it("не маскирует untagged второе сообщение успехом первого и третьего", () => {
    const serverFranking = sodium.crypto_sign_keypair();
    const reviewerDevice = sodium.crypto_box_keypair();
    const messages = [
      taggedComplaint(1, serverFranking.privateKey),
      untaggedComplaint(2),
      taggedComplaint(3, serverFranking.privateKey),
    ];
    const target = {
      userUuid: REVIEWER_USER_UUID,
      deviceUuid: REVIEWER_DEVICE_UUID,
      agreementPublicKey: reviewerDevice.publicKey,
    };
    const assembled = assembleFrankingReportV2(sodium, {
      bundleUuid: BUNDLE_UUID,
      messages,
      wrapTargets: [target],
    });
    const wrap = assembled.wraps[0];
    if (!wrap) throw new Error("wrap ревьюера не собран");
    const reportContentKey = unwrapReportContentKeyV2(sodium, {
      wrappedKey: wrap.wrappedKey,
      bundleUuid: BUNDLE_UUID,
      userUuid: target.userUuid,
      deviceUuid: target.deviceUuid,
      agreementPrivateKey: reviewerDevice.privateKey.subarray(0, 32),
    });

    const result = reviewFrankingComplaintBundleV2(sodium, {
      sealed: assembled.disclosureCiphertext,
      reportContentKey,
      serverFrankingPublicKey: serverFranking.publicKey,
    });

    expect(result.messages.map((message) => message.verification)).toMatchObject([
      { ok: true },
      {
        ok: false,
        reason: "unverifiable",
        missing: ["frankingKeyBase64Url", "frankTagBase64Url", "serverFrankReceipt"],
      },
      { ok: true },
    ]);
    expect(result.messages.map((message) => message.plaintext?.blocks)).toEqual([
      [{ kind: "text", body: "сообщение 1" }],
      [{ kind: "text", body: "сообщение 2" }],
      [{ kind: "text", body: "сообщение 3" }],
    ]);
    expect("verification" in result).toBe(false);
  });
});
