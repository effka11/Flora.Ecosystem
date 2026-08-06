import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTokens,
} from "../auth/types.js";
import {
  configureApiClient,
  resetSessionRefreshStateForTests,
} from "../api/client.js";
import {
  connectSignalsStream,
  parseNotificationRemovedSignalForTest,
  parseReadSignalForTest,
} from "./stream.js";

function createSessionStore(): SessionStore {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  let revision = 1;
  const record = (): SessionRecord => ({
    accessToken: "tok",
    refresh: { kind: "cookie" },
    expiresAt,
  });
  return {
    async getAccessToken() {
      return "tok";
    },
    async getRefreshToken() {
      return null;
    },
    async getExpiresAt() {
      return expiresAt;
    },
    async saveSession(_tokens: SessionTokens) {
      revision += 1;
    },
    async clearSession() {
      revision += 1;
    },
    async hasPendingProfileSetup() {
      return false;
    },
    async setPendingProfileSetup() {
      /* noop */
    },
    async readSession(): Promise<SessionSnapshot> {
      return { revision, session: record() };
    },
    async compareAndSetSession(expectedRevision, next) {
      if (revision !== expectedRevision) return false;
      void next;
      revision += 1;
      return true;
    },
    async compareAndClearSession(expectedRevision) {
      if (revision !== expectedRevision) return false;
      revision += 1;
      return true;
    },
  };
}

describe("connectSignalsStream", () => {
  beforeEach(() => {
    resetSessionRefreshStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not reject when fetch fails (reconnect path)", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    configureApiClient({
      apiBaseUrl: "https://api.flora.test",
      session: createSessionStore(),
      clientIdentity: { platform: "web", appVersion: "test" },
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      runRefreshExclusive: async (operation) => operation(),
    });

    const handle = connectSignalsStream({
      onError: (error) => {
        errors.push(error);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(rejections).toEqual([]);

    handle.close();
    process.off("unhandledRejection", onUnhandled);
  });
});

describe("parseReadSignal", () => {
  it("parses camelCase read receipt payload", () => {
    expect(
      parseReadSignalForTest({
        conversationUuid: "conv-1",
        readerUserUuid: "reader-1",
      }),
    ).toEqual({ conversationUuid: "conv-1", readerUserUuid: "reader-1" });
  });

  it("parses PascalCase read receipt payload", () => {
    expect(
      parseReadSignalForTest({
        ConversationUuid: "conv-2",
        ReaderUserUuid: "reader-2",
      }),
    ).toEqual({ conversationUuid: "conv-2", readerUserUuid: "reader-2" });
  });

  it("rejects incomplete payload", () => {
    expect(parseReadSignalForTest({ conversationUuid: "conv-3" })).toBeNull();
    expect(parseReadSignalForTest(null)).toBeNull();
  });
});

describe("parseNotificationRemovedSignal", () => {
  it("parses camelCase notification_removed payload", () => {
    expect(
      parseNotificationRemovedSignalForTest({
        notificationUuid: "notif-1",
        groupKey: "group-a",
      }),
    ).toEqual({ notificationUuid: "notif-1", groupKey: "group-a" });
  });

  it("parses PascalCase notification_removed payload", () => {
    expect(
      parseNotificationRemovedSignalForTest({
        NotificationUuid: "notif-2",
        GroupKey: "group-b",
      }),
    ).toEqual({ notificationUuid: "notif-2", groupKey: "group-b" });
  });

  it("nulls missing groupKey and rejects missing uuid", () => {
    expect(
      parseNotificationRemovedSignalForTest({
        notificationUuid: "notif-3",
      }),
    ).toEqual({ notificationUuid: "notif-3", groupKey: null });
    expect(parseNotificationRemovedSignalForTest({ groupKey: "group-c" })).toBeNull();
    expect(parseNotificationRemovedSignalForTest(null)).toBeNull();
  });
});
