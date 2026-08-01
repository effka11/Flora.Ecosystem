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
  PRESENCE_BACKGROUND_STOP_DEBOUNCE_MS,
  PRESENCE_FOREGROUND_CONFIRM_MS,
  startPresenceHeartbeat,
} from "./store.js";

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

describe("startPresenceHeartbeat", () => {
  beforeEach(() => {
    resetSessionRefreshStateForTests();
    configureApiClient({
      apiBaseUrl: "https://api.flora.test",
      session: createSessionStore(),
      clientIdentity: { platform: "web", appVersion: "test" },
      fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
      runRefreshExclusive: async (operation) => operation(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cold-starts through foreground confirm when already visible", async () => {
    vi.useFakeTimers();
    const posts: number[] = [];
    configureApiClient({
      apiBaseUrl: "https://api.flora.test",
      session: createSessionStore(),
      clientIdentity: { platform: "web", appVersion: "test" },
      fetchImpl: (async () => {
        posts.push(1);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      runRefreshExclusive: async (operation) => operation(),
    });

    const hb = startPresenceHeartbeat({
      isVisible: () => true,
    });
    expect(posts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(PRESENCE_FOREGROUND_CONFIRM_MS - 1);
    expect(posts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(posts.length).toBeGreaterThanOrEqual(1);

    hb.stop();
  });

  it("does not heartbeat on a sub-confirm active blip", async () => {
    vi.useFakeTimers();
    const posts: number[] = [];
    let visible = false;
    configureApiClient({
      apiBaseUrl: "https://api.flora.test",
      session: createSessionStore(),
      clientIdentity: { platform: "web", appVersion: "test" },
      fetchImpl: (async () => {
        posts.push(1);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      runRefreshExclusive: async (operation) => operation(),
    });

    const hb = startPresenceHeartbeat({
      isVisible: () => visible,
    });
    expect(posts).toHaveLength(0);

    visible = true;
    hb.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(PRESENCE_FOREGROUND_CONFIRM_MS - 1);
    expect(posts).toHaveLength(0);

    visible = false;
    hb.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(1);
    expect(posts).toHaveLength(0);

    hb.stop();
  });

  it("keeps heartbeat across a short background flicker", async () => {
    vi.useFakeTimers();
    const posts: number[] = [];
    let visible = true;
    configureApiClient({
      apiBaseUrl: "https://api.flora.test",
      session: createSessionStore(),
      clientIdentity: { platform: "web", appVersion: "test" },
      fetchImpl: (async () => {
        posts.push(1);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      runRefreshExclusive: async (operation) => operation(),
    });

    const hb = startPresenceHeartbeat({
      isVisible: () => visible,
    });
    await vi.advanceTimersByTimeAsync(PRESENCE_FOREGROUND_CONFIRM_MS);
    const afterStart = posts.length;
    expect(afterStart).toBeGreaterThanOrEqual(1);

    visible = false;
    hb.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(PRESENCE_BACKGROUND_STOP_DEBOUNCE_MS - 1);

    visible = true;
    hb.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(1);
    // Interval was never stopped — no second confirm delay required.
    expect(posts.length).toBeGreaterThanOrEqual(afterStart);

    hb.stop();
  });
});
