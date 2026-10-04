import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore, SessionTokens } from "../auth/types.js";
import { ApiRequestError } from "./errors.js";
import { configureApiClient, resetSessionRefreshStateForTests } from "./client.js";
import {
  apiClaimFrankingReport,
  apiCreateFrankingReport,
  apiGetFrankingDisclosure,
  apiGetFrankingQueue,
  apiGetFrankingWrapTargets,
  apiResolveFrankingReport,
  toFrankingFailure,
} from "./franking.js";

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

const MINIMAL_REPORT = {
  reportUuid: "11111111-1111-1111-1111-111111111111",
  persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
  conversationUuid: "33333333-3333-3333-3333-333333333333",
  category: "abuse",
  status: "open",
  claimedBy: null,
  claimedAt: null,
  createdAt: "2026-08-17T12:00:00.000Z",
  viewerAccountCount: 1,
  hasDisclosure: true,
  verificationStatus: "verifiable",
};

function setupClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  configureApiClient({
    apiBaseUrl: "https://api.test",
    session: createSessionStore(makeJwt(exp)),
    clientIdentity: { platform: "web", appVersion: "1.0.0" },
    fetchImpl,
  });
}

describe("franking API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionRefreshStateForTests();
  });

  it("requests queue at /api/messaging/franking/queue with encoded cursor", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ items: [], nextCursor: null, hasMore: false }),
    );
    setupClient(fetchImpl);

    await apiGetFrankingQueue();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/messaging/franking/queue",
      expect.any(Object),
    );

    fetchImpl.mockClear();
    await apiGetFrankingQueue("cursor/with/slash");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/messaging/franking/queue?cursor=cursor%2Fwith%2Fslash",
      expect.any(Object),
    );
  });

  it("reads wrap targets from GET /api/messaging/franking/server-key", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        serverFrankingKeyId: null,
        publicKeyBase64Url: null,
        wrapTargets: {
          items: [
            {
              userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              deviceUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              agreementPublicKeyBase64Url: "pk",
            },
          ],
          ownItems: [],
        },
        reviewerRosterReady: true,
      }),
    );
    setupClient(fetchImpl);
    const page = await apiGetFrankingWrapTargets();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/messaging/franking/server-key",
      expect.any(Object),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.deviceUuid).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(page.ownItems).toEqual([]);
    expect(page.reviewerRosterReady).toBe(true);
  });

  it("keeps server-key available when the reviewer roster is not ready", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        serverFrankingKeyId: null,
        publicKeyBase64Url: null,
        wrapTargets: { items: [], ownItems: [] },
        reviewerRosterReady: false,
      }),
    );
    setupClient(fetchImpl);
    const page = await apiGetFrankingWrapTargets();
    expect(page.reviewerRosterReady).toBe(false);
    expect(page.items).toEqual([]);
  });

  it("reads disclosure at GET reports/{uuid}/disclosure", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () =>
      Response.json({
        disclosureCiphertext: "sealed",
        wraps: [{ deviceUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", wrappedKey: "wk" }],
        serverFrankReceipt: null,
        frankTagBase64Url: null,
        verificationStatus: "unverifiable",
      }),
    );
    setupClient(fetchImpl);

    const dto = await apiGetFrankingDisclosure(reportUuid);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${reportUuid}/disclosure`,
      expect.any(Object),
    );
    expect(dto.disclosureCiphertext).toBe("sealed");
    expect(dto.wraps).toHaveLength(1);
    expect(dto.verificationStatus).toBe("unverifiable");
  });

  it("posts claim to reports/{uuid}/claim", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json(MINIMAL_REPORT));
    setupClient(fetchImpl);

    await apiClaimFrankingReport(reportUuid);

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${reportUuid}/claim`,
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("posts resolve with decision rejected and omits code when not given", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json({ ...MINIMAL_REPORT, status: "rejected" }));
    setupClient(fetchImpl);

    await apiResolveFrankingReport(reportUuid, "rejected");

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${reportUuid}/resolve`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "rejected" }),
      }),
    );
  });

  it("resolved without accountBlock omits the accountBlock key entirely", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json({ ...MINIMAL_REPORT, status: "resolved" }));
    setupClient(fetchImpl);

    await apiResolveFrankingReport(reportUuid, "resolved");

    const call = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ decision: "resolved" });
    expect(body).not.toHaveProperty("accountBlock");
  });

  it("resolved with forever accountBlock sends an empty accountBlock object", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json({ ...MINIMAL_REPORT, status: "resolved" }));
    setupClient(fetchImpl);

    await apiResolveFrankingReport(reportUuid, "resolved", undefined, {});

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${reportUuid}/resolve`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "resolved", accountBlock: {} }),
      }),
    );
  });

  it("resolved with timed accountBlock sends days", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json({ ...MINIMAL_REPORT, status: "resolved" }));
    setupClient(fetchImpl);

    await apiResolveFrankingReport(reportUuid, "resolved", undefined, { days: 7 });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.test/api/messaging/franking/reports/${reportUuid}/resolve`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "resolved", accountBlock: { days: 7 } }),
      }),
    );
  });

  it("rejected decision never sends accountBlock even when provided", async () => {
    const reportUuid = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn(async () => Response.json({ ...MINIMAL_REPORT, status: "rejected" }));
    setupClient(fetchImpl);

    await apiResolveFrankingReport(reportUuid, "rejected", undefined, { days: 7 });

    const call = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ decision: "rejected" });
    expect(body).not.toHaveProperty("accountBlock");
  });

  it("posts create report to /api/messaging/franking/reports", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(MINIMAL_REPORT, { status: 201 }),
    );
    setupClient(fetchImpl);

    await apiCreateFrankingReport({
      persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
      category: "spam",
      disclosureCiphertext: "YQ",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/messaging/franking/reports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
          category: "spam",
          disclosureCiphertext: "YQ",
          wraps: [],
        }),
      }),
    );
  });
});

describe("toFrankingFailure", () => {
  it("returns null for non-ApiRequestError", () => {
    expect(toFrankingFailure(new Error("boom"))).toBeNull();
    expect(toFrankingFailure("nope")).toBeNull();
  });

  it("maps 403 to notReviewer with server message preserved", () => {
    const err = new ApiRequestError(403, "Нужна роль franking-ревьюера.");
    expect(toFrankingFailure(err)).toEqual({
      reason: "notReviewer",
      status: 403,
      message: "Нужна роль franking-ревьюера.",
    });
  });

  it("maps 409 to alreadyClaimed with server message preserved", () => {
    const err = new ApiRequestError(409, "Заявка уже занята.");
    expect(toFrankingFailure(err)).toEqual({
      reason: "alreadyClaimed",
      status: 409,
      message: "Заявка уже занята.",
    });
  });

  it("maps 503 to rosterUnavailable with server message preserved", () => {
    const err = new ApiRequestError(503, "Список franking-ревьюеров не загружен.");
    expect(toFrankingFailure(err)).toEqual({
      reason: "rosterUnavailable",
      status: 503,
      message: "Список franking-ревьюеров не загружен.",
    });
  });
});
