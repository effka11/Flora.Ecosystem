/**
 * Gov reviewer surface: one call returns `{ blocks, verified }`.
 *
 * Consumer-facing imports (the screen next wave) are api + contracts only.
 * `@flora/fscp` appears below solely to build mocked HTTP bodies.
 */
import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore, SessionTokens } from "../auth/types.js";
import {
  parseFrankingDisclosure,
  parseFrankingServerKey,
  type FrankingReviewerResult,
} from "../contracts/franking.js";
import { configureApiClient, resetSessionRefreshStateForTests } from "./client.js";
import {
  apiReviewFrankingReport,
  apiReviewFrankingReportWithIdentity,
  FRANKING_NO_DEVICE_WRAP_MESSAGE,
  reviewFrankingDisclosureFromResponses,
  reviewFrankingDisclosureWithIdentityFromResponses,
} from "./franking.js";

import {
  assembleFrankingReportV1,
  computeFrankTagV1,
  configureSodiumLoader,
  frankCommitInputV1,
  frankReceiptPayloadV1,
  padPlaintextJsonV1,
  toBase64Url,
  utf8Bytes,
  type SodiumModule,
} from "@flora/fscp";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const REPORT_UUID = "11111111-1111-4111-8111-111111111111";
const PERSISTED_MESSAGE = "22222222-2222-4222-8222-222222222222";
const MESSAGE_UUID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_UUID = "44444444-4444-4444-8444-444444444444";
const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SENDER_DEVICE = "99999999-9999-4999-8999-999999999999";
const RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEWER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REVIEWER_DEVICE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OTHER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CREATED_AT = "2026-08-22T11:59:59.001Z";
const SERVER_RECEIVED_AT = "2026-08-22T12:00:00.123Z";

function makeJwt(expSec: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expSec }));
  return `${header}.${payload}.signature`;
}

function createSessionStore(accessToken: string): SessionStore {
  const state = {
    accessToken,
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
  return {
    async getAccessToken() {
      return state.accessToken;
    },
    async getRefreshToken() {
      return state.refreshToken;
    },
    async getExpiresAt() {
      return state.expiresAt;
    },
    async saveSession(tokens: SessionTokens) {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
      state.expiresAt = tokens.expiresAt;
    },
    async clearSession() {
      state.accessToken = null;
      state.refreshToken = null;
      state.expiresAt = null;
    },
    async hasPendingProfileSetup() {
      return false;
    },
    async setPendingProfileSetup() {
      /* noop */
    },
  };
}

function setupClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  configureApiClient({
    apiBaseUrl: "https://api.test",
    session: createSessionStore(makeJwt(exp)),
    clientIdentity: { platform: "web", appVersion: "1.0.0" },
    fetchImpl,
  });
}

type ReviewerKeys = { publicKey: Uint8Array; privateKey: Uint8Array };
type ServerKeys = { publicKey: Uint8Array; privateKey: Uint8Array };

function plaintextUtf8(body: string): Uint8Array {
  return utf8Bytes(
    padPlaintextJsonV1(
      JSON.stringify({
        type: "blocks",
        version: 1,
        blocks: [{ kind: "text", body }],
        clientCreatedAt: CREATED_AT,
      }),
    ),
  );
}

function ownItem(
  deviceUuid: string,
  agreementPublicKey: Uint8Array,
): { userUuid: string; deviceUuid: string; agreementPublicKeyBase64Url: string } {
  return {
    userUuid: REVIEWER,
    deviceUuid,
    agreementPublicKeyBase64Url: toBase64Url(agreementPublicKey),
  };
}

function buildHttpBodies(params: {
  body: string;
  tagged: boolean;
  reviewer: ReviewerKeys;
  server: ServerKeys;
  extraWrapTarget?: { deviceUuid: string; agreementPublicKey: Uint8Array };
  ownItems?: Array<{ userUuid: string; deviceUuid: string; agreementPublicKeyBase64Url: string }>;
}): {
  disclosureJson: Record<string, unknown>;
  serverKeyJson: Record<string, unknown>;
} {
  const bytes = plaintextUtf8(params.body);
  const frankingKey = params.tagged ? sodium.randombytes_buf(32) : null;
  const frankTag = frankingKey
    ? computeFrankTagV1(
        frankingKey,
        frankCommitInputV1(
          {
            conversationUuid: CONVERSATION_UUID,
            messageUuid: MESSAGE_UUID,
            senderUserUuid: SENDER,
            senderDeviceUuid: SENDER_DEVICE,
            receiverUserUuid: RECEIVER,
            createdAt: CREATED_AT,
          },
          bytes,
        ),
      )
    : null;
  const frankTagBase64Url = frankTag ? toBase64Url(frankTag) : null;
  const serverFrankReceipt =
    frankTagBase64Url === null
      ? null
      : {
          signatureBase64Url: toBase64Url(
            sodium.crypto_sign_detached(
              utf8Bytes(
                frankReceiptPayloadV1({
                  frankTagBase64Url,
                  messageUuid: MESSAGE_UUID,
                  conversationUuid: CONVERSATION_UUID,
                  senderUserUuid: SENDER,
                  receiverUserUuid: RECEIVER,
                  serverReceivedAt: SERVER_RECEIVED_AT,
                }),
              ),
              params.server.privateKey,
            ),
          ),
          serverFrankingKeyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          serverReceivedAt: SERVER_RECEIVED_AT,
        };

  const assembled = assembleFrankingReportV1(sodium, {
    complaint: {
      plaintextUtf8: bytes,
      frankingKeyBase64Url: frankingKey ? toBase64Url(frankingKey) : null,
      frankTagBase64Url,
      serverFrankReceipt,
      messageUuid: MESSAGE_UUID,
      persistedMessageUuid: PERSISTED_MESSAGE,
      conversationUuid: CONVERSATION_UUID,
      senderUserUuid: SENDER,
      senderDeviceUuid: SENDER_DEVICE,
      receiverUserUuid: RECEIVER,
      createdAt: CREATED_AT,
    },
    wrapTargets: [
      ...(params.extraWrapTarget
        ? [
            {
              userUuid: REVIEWER,
              deviceUuid: params.extraWrapTarget.deviceUuid,
              agreementPublicKey: params.extraWrapTarget.agreementPublicKey,
            },
          ]
        : []),
      {
        userUuid: REVIEWER,
        deviceUuid: REVIEWER_DEVICE,
        agreementPublicKey: params.reviewer.publicKey,
      },
    ],
  });
  if (assembled.wraps.length === 0) throw new Error("expected a reviewer wrap");

  return {
    disclosureJson: {
      disclosureCiphertext: assembled.disclosureCiphertext,
      wraps: assembled.wraps.map((wrap) => ({
        deviceUuid: wrap.deviceUuid,
        wrappedKey: wrap.wrappedKey,
      })),
      serverFrankReceipt,
      frankTagBase64Url,
      verificationStatus: params.tagged ? "verifiable" : "unverifiable",
    },
    serverKeyJson: {
      serverFrankingKeyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publicKeyBase64Url: toBase64Url(params.server.publicKey),
      wrapTargets: {
        items: [],
        ownItems: params.ownItems ?? [ownItem(REVIEWER_DEVICE, params.reviewer.publicKey)],
      },
      reviewerRosterReady: true,
    },
  };
}

const viewer = {
  persistedMessageUuid: PERSISTED_MESSAGE,
  viewerUserUuid: REVIEWER,
  viewerDeviceUuid: REVIEWER_DEVICE,
  agreementPrivateKey: new Uint8Array(32),
};

describe("reviewer franking surface", () => {
  let reviewerKeys: ReviewerKeys;
  let serverKeys: ServerKeys;

  beforeAll(async () => {
    await sodium.ready;
    configureSodiumLoader(async () => sodium);
    reviewerKeys = sodium.crypto_box_keypair();
    serverKeys = sodium.crypto_sign_keypair();
    viewer.agreementPrivateKey = reviewerKeys.privateKey;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionRefreshStateForTests();
  });

  it("from mocked disclosure + server-key JSON: verified, typed { blocks, verified }", async () => {
    const http = buildHttpBodies({
      body: "недопустимое сообщение",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
    });

    const result: FrankingReviewerResult = await reviewFrankingDisclosureFromResponses(
      parseFrankingDisclosure(http.disclosureJson),
      parseFrankingServerKey(http.serverKeyJson),
      viewer,
    );

    expect(result).toEqual({
      blocks: [{ kind: "text", body: "недопустимое сообщение" }],
      verified: { ok: true },
    });
  });

  it("untagged v1 disclosure is not verified (unverifiable) and still shows blocks", async () => {
    const http = buildHttpBodies({
      body: "старое сообщение без тега",
      tagged: false,
      reviewer: reviewerKeys,
      server: serverKeys,
    });

    const result: FrankingReviewerResult = await reviewFrankingDisclosureFromResponses(
      parseFrankingDisclosure(http.disclosureJson),
      parseFrankingServerKey(http.serverKeyJson),
      viewer,
    );

    expect(result.verified.ok).toBe(false);
    expect(result.verified).toEqual({
      ok: false,
      reason: "unverifiable",
      missing: ["frankingKeyBase64Url", "frankTagBase64Url", "serverFrankReceipt"],
    });
    expect(result.blocks).toEqual([{ kind: "text", body: "старое сообщение без тега" }]);
  });

  it("apiReviewFrankingReport hits both frozen GETs and returns the same typed result", async () => {
    const http = buildHttpBodies({
      body: "жалоба через один вызов",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith(`/reports/${REPORT_UUID}/disclosure`)) {
        return Response.json(http.disclosureJson);
      }
      if (String(url).endsWith("/api/messaging/franking/server-key")) {
        return Response.json(http.serverKeyJson);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    setupClient(fetchImpl);

    const result: FrankingReviewerResult = await apiReviewFrankingReport(REPORT_UUID, viewer);

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${REPORT_UUID}/disclosure`,
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/messaging/franking/server-key",
      expect.any(Object),
    );
    expect(result).toEqual({
      blocks: [{ kind: "text", body: "жалоба через один вызов" }],
      verified: { ok: true },
    });
  });

  it("identity match + persistedMessageUuid from meta unwraps via ownItems", async () => {
    const http = buildHttpBodies({
      body: "раскрытие по identity",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
    });

    const result = await reviewFrankingDisclosureWithIdentityFromResponses(
      parseFrankingDisclosure(http.disclosureJson),
      parseFrankingServerKey(http.serverKeyJson),
      {
        persistedMessageUuid: PERSISTED_MESSAGE,
        viewerUserUuid: REVIEWER,
        agreementPrivateKey: reviewerKeys.privateKey,
      },
    );

    expect(result).toEqual({
      blocks: [{ kind: "text", body: "раскрытие по identity" }],
      verified: { ok: true },
    });
  });

  it("picks the wrap whose ownItems pubkey matches when it is not first", async () => {
    const otherKeys = sodium.crypto_box_keypair();
    const http = buildHttpBodies({
      body: "второй wrap",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
      extraWrapTarget: { deviceUuid: OTHER_DEVICE, agreementPublicKey: otherKeys.publicKey },
      ownItems: [ownItem(REVIEWER_DEVICE, reviewerKeys.publicKey)],
    });

    const result = await reviewFrankingDisclosureWithIdentityFromResponses(
      parseFrankingDisclosure(http.disclosureJson),
      parseFrankingServerKey(http.serverKeyJson),
      {
        persistedMessageUuid: PERSISTED_MESSAGE,
        viewerUserUuid: REVIEWER,
        agreementPrivateKey: reviewerKeys.privateKey,
      },
    );

    expect(result.blocks).toEqual([{ kind: "text", body: "второй wrap" }]);
    expect(result.verified).toEqual({ ok: true });
  });

  it("rejects when wrap exists but ownItems pubkey does not match identity", async () => {
    const otherKeys = sodium.crypto_box_keypair();
    const http = buildHttpBodies({
      body: "чужой pubkey",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
      ownItems: [ownItem(REVIEWER_DEVICE, otherKeys.publicKey)],
    });

    await expect(
      reviewFrankingDisclosureWithIdentityFromResponses(
        parseFrankingDisclosure(http.disclosureJson),
        parseFrankingServerKey(http.serverKeyJson),
        {
          persistedMessageUuid: PERSISTED_MESSAGE,
          viewerUserUuid: REVIEWER,
          agreementPrivateKey: reviewerKeys.privateKey,
        },
      ),
    ).rejects.toThrow(FRANKING_NO_DEVICE_WRAP_MESSAGE);
  });

  it("rejects identity review without persistedMessageUuid", async () => {
    const http = buildHttpBodies({
      body: "нет uuid",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
    });

    await expect(
      reviewFrankingDisclosureWithIdentityFromResponses(
        parseFrankingDisclosure(http.disclosureJson),
        parseFrankingServerKey(http.serverKeyJson),
        {
          persistedMessageUuid: "  ",
          viewerUserUuid: REVIEWER,
          agreementPrivateKey: reviewerKeys.privateKey,
        },
      ),
    ).rejects.toThrow("Нет persistedMessageUuid заявки franking.");
  });

  it("apiReviewFrankingReportWithIdentity hits both GETs and requires persistedMessageUuid", async () => {
    const http = buildHttpBodies({
      body: "gov identity call",
      tagged: true,
      reviewer: reviewerKeys,
      server: serverKeys,
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith(`/reports/${REPORT_UUID}/disclosure`)) {
        return Response.json(http.disclosureJson);
      }
      if (String(url).endsWith("/api/messaging/franking/server-key")) {
        return Response.json(http.serverKeyJson);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    setupClient(fetchImpl);

    await expect(
      apiReviewFrankingReportWithIdentity({
        reportUuid: REPORT_UUID,
        persistedMessageUuid: "",
        viewerUserUuid: REVIEWER,
        agreementPrivateKey: reviewerKeys.privateKey,
      }),
    ).rejects.toThrow("Нет persistedMessageUuid заявки franking.");
    expect(fetchImpl).not.toHaveBeenCalled();

    const result = await apiReviewFrankingReportWithIdentity({
      reportUuid: REPORT_UUID,
      persistedMessageUuid: PERSISTED_MESSAGE,
      viewerUserUuid: REVIEWER,
      agreementPrivateKey: reviewerKeys.privateKey,
    });
    expect(result.blocks).toEqual([{ kind: "text", body: "gov identity call" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
