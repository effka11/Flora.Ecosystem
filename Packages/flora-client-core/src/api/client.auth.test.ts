import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore, SessionTokens } from "../auth/types.js";
import { ApiRequestError, isApiRequestError } from "./errors.js";
import {
  authFetch,
  configureApiClient,
  refreshSessionIfPossible,
  resetSessionRefreshStateForTests,
  syncStoredSessionTokens,
} from "./client.js";

type SessionState = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
};

function makeJwt(expSec: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expSec }));
  return `${header}.${payload}.signature`;
}

function createSessionStore(initial: SessionState): SessionStore & { state: SessionState } {
  const state = { ...initial };
  return {
    state,
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

describe("session refresh client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSessionRefreshStateForTests();
  });

  it("clears session when refresh returns 401", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Invalid" }), { status: 401 }));

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(session.state.accessToken).toBeNull();
    expect(session.state.refreshToken).toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps session when refresh 401 but token already rotated by another caller", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => {
      // Simulate concurrent rotation: store already has new tokens before 401 response is handled.
      session.state.accessToken = "new-access";
      session.state.refreshToken = "new-refresh";
      session.state.expiresAt = new Date(Date.now() + 900_000).toISOString();
      return new Response(JSON.stringify({ error: "Invalid" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(true);
    expect(session.state.accessToken).toBe("new-access");
    expect(session.state.refreshToken).toBe("new-refresh");
  });

  it("keeps session on transient refresh failure", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent refresh calls", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(
        JSON.stringify({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const [a, b] = await Promise.all([refreshSessionIfPossible(), refreshSessionIfPossible()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("authFetch does not logout when refresh token remains after transient refresh failure", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const session = createSessionStore({
      accessToken: makeJwt(exp),
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(null, { status: 503 });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await expect(authFetch("/api/auth/me")).rejects.toSatisfy(
      (err) => isApiRequestError(err) && err.status === 401,
    );
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("authFetch logs out when refresh token is revoked", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const session = createSessionStore({
      accessToken: makeJwt(exp),
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await expect(authFetch("/api/auth/me")).rejects.toSatisfy(
      (err) => isApiRequestError(err) && err.status === 401,
    );
    expect(session.state.refreshToken).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps session when refresh returns 200 with invalid payload", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "oops" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    // persist_failed — no retry (server may already have rotated)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps session when refresh returns 429", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429 }));

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps session when saveSession throws after valid refresh payload", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    session.saveSession = async () => {
      throw new Error("QuotaExceeded");
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not wipe session when save fails then retry would have used rotated-away token", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let refreshCalls = 0;
    session.saveSession = async () => {
      throw new Error("QuotaExceeded");
    };
    const fetchImpl = vi.fn(async () => {
      refreshCalls += 1;
      // Server rotated; client cannot persist. A second call with R1 would 401.
      return new Response(
        JSON.stringify({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    const ok = await refreshSessionIfPossible();
    expect(ok).toBe(false);
    expect(refreshCalls).toBe(1);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
  });

  it("authFetch does not logout when API 401 persists but refresh token remains", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const session = createSessionStore({
      accessToken: makeJwt(exp),
      refreshToken: "still-valid-refresh",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: makeJwt(exp),
            refreshToken: "still-valid-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await expect(authFetch("/api/auth/me")).rejects.toSatisfy(
      (err) => isApiRequestError(err) && err.status === 401,
    );
    expect(session.state.refreshToken).toBe("still-valid-refresh");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("syncStoredSessionTokens notifies when proactive refresh revokes session", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await syncStoredSessionTokens();
    expect(session.state.refreshToken).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
