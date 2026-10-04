import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RefreshCapability,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTokens,
} from "../auth/types.js";
import { ApiRequestError, isApiRequestError } from "./errors.js";
import {
  authFetch,
  configureApiClient,
  refreshSession,
  refreshSessionIfPossible,
  resetSessionRefreshStateForTests,
  supersedeSessionRefresh,
  syncStoredSessionTokens,
} from "./client.js";
import type { RunRefreshExclusive } from "./sessionCoordinator.js";

type SessionState = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
};

type TestSessionStore = SessionStore & {
  state: SessionState & {
    refreshKind: RefreshCapability["kind"] | null;
    revision: number;
  };
  replaceSession(next: SessionRecord | null): void;
};

function makeJwt(expSec: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expSec }));
  return `${header}.${payload}.signature`;
}

function createSessionStore(initial: SessionState): TestSessionStore {
  const state: TestSessionStore["state"] = {
    ...initial,
    refreshKind: initial.refreshToken ? "token" : null,
    revision: 0,
  };

  const currentRecord = (): SessionRecord | null => {
    const refresh =
      state.refreshKind === "cookie"
        ? ({ kind: "cookie" } as const)
        : state.refreshKind === "token" && state.refreshToken
          ? ({ kind: "token", token: state.refreshToken } as const)
          : null;
    if (
      state.accessToken === null &&
      refresh === null &&
      state.expiresAt === null
    ) {
      return null;
    }
    return {
      accessToken: state.accessToken,
      refresh,
      expiresAt: state.expiresAt,
    };
  };

  const replaceSession = (next: SessionRecord | null): void => {
    state.accessToken = next?.accessToken ?? null;
    state.refreshKind = next?.refresh?.kind ?? null;
    state.refreshToken =
      next?.refresh?.kind === "token" ? next.refresh.token : null;
    state.expiresAt = next?.expiresAt ?? null;
    state.revision += 1;
  };

  return {
    state,
    replaceSession,
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
      state.refreshKind = "token";
      state.expiresAt = tokens.expiresAt;
      state.revision += 1;
    },
    async clearSession() {
      state.accessToken = null;
      state.refreshToken = null;
      state.refreshKind = null;
      state.expiresAt = null;
      state.revision += 1;
    },
    async hasPendingProfileSetup() {
      return false;
    },
    async setPendingProfileSetup() {
      /* noop */
    },
    async readSession(): Promise<SessionSnapshot> {
      return {
        revision: state.revision,
        session: currentRecord(),
      };
    },
    async compareAndSetSession(expectedRevision, next) {
      if (state.revision !== expectedRevision) return false;
      replaceSession(next);
      return true;
    },
    async compareAndClearSession(expectedRevision) {
      if (state.revision !== expectedRevision) return false;
      replaceSession(null);
      return true;
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

    expect(await refreshSession()).toBe("invalid");
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
      session.replaceSession({
        accessToken: "new-access",
        refresh: { kind: "token", token: "new-refresh" },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
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

  it("does not re-send a lost R1 by default or clear a legacy session", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        // The legacy backend may have rotated R1 even though its response was lost.
        throw new TypeError("Response was lost");
      }
      return new Response(
        JSON.stringify({ error: "Refresh token already used" }),
        { status: 401 },
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
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("legacy next resume after a lost R1 is terminal invalid", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        throw new TypeError("Response was lost");
      }
      return new Response(
        JSON.stringify({ error: "Refresh token already used" }),
        { status: 401 },
      );
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    expect(await refreshSession()).toBe("transient");
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");

    expect(await refreshSession()).toBe("invalid");
    expect(session.state.accessToken).toBeNull();
    expect(session.state.refreshToken).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retry-safe next resume after a lost R1 stays ready", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const requestBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        throw new TypeError("Response was lost");
      }
      if (requestBodies.length === 2) {
        return new Response(
          JSON.stringify({
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          accessToken: "newer-access",
          refreshToken: "newer-refresh",
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
      retrySafeRefreshBackend: true,
    });

    expect(await refreshSession()).toBe("ready");
    expect(session.state.refreshToken).toBe("new-refresh");
    expect(await refreshSession()).toBe("ready");
    expect(session.state.accessToken).toBe("newer-access");
    expect(session.state.refreshToken).toBe("newer-refresh");
    expect(requestBodies).toEqual([
      JSON.stringify({ refreshToken: "old-refresh" }),
      JSON.stringify({ refreshToken: "old-refresh" }),
      JSON.stringify({ refreshToken: "new-refresh" }),
    ]);
  });

  it("retries the same R1 once after a lost response", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const requestBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        throw new TypeError("Response was lost");
      }
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
      retrySafeRefreshBackend: true,
    });

    expect(await refreshSession()).toBe("ready");
    expect(requestBodies).toEqual([
      JSON.stringify({ refreshToken: "old-refresh" }),
      JSON.stringify({ refreshToken: "old-refresh" }),
    ]);
    expect(session.state.refreshToken).toBe("new-refresh");
  });

  it("does not retry or clear on a transient refresh 5xx", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    expect(await refreshSession()).toBe("transient");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
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

  it("rechecks the revision after entering platform exclusivity", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let entered!: () => void;
    let release!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runRefreshExclusive: RunRefreshExclusive = async (operation) => {
      entered();
      await lockRelease;
      return operation();
    };
    const fetchImpl = vi.fn();

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
      runRefreshExclusive,
    });

    const attempt = refreshSession();
    await lockEntered;
    session.replaceSession({
      accessToken: "other-access",
      refresh: { kind: "cookie" },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    release();

    expect(await attempt).toBe("superseded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves cookie refresh as a typed capability", async () => {
    const session = createSessionStore({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    session.replaceSession({
      accessToken: "old-access",
      refresh: { kind: "cookie" },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBe("{}");
      expect(init?.credentials).toBe("include");
      return new Response(
        JSON.stringify({
          accessToken: "new-access",
          refreshToken: "http-only",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
    });

    expect(await refreshSession()).toBe("ready");
    expect((await session.readSession!()).session?.refresh).toEqual({
      kind: "cookie",
    });
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
    // protocol_error — no retry (server may already have rotated)
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not treat a token refresh 403 as terminal Invalid", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "android", appVersion: "1.0.0" },
      fetchImpl,
    });

    expect(await refreshSession()).toBe("protocol_error");
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
  });

  it("treats a cookie refresh 403 as terminal Invalid", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const session = createSessionStore({
      accessToken: makeJwt(exp),
      refreshToken: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    session.replaceSession({
      accessToken: makeJwt(exp),
      refresh: { kind: "cookie" },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({ error: "Cross-origin refresh is not allowed." }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "Не удалось определить пользователя." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await expect(authFetch("/api/auth/me")).rejects.toSatisfy(
      (err) => isApiRequestError(err) && err.status === 401,
    );
    expect(session.state.accessToken).toBeNull();
    expect((await session.readSession!()).session).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps R2 effective when its atomic storage commit is pending", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    session.compareAndSetSession = async () => {
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

    expect(await refreshSession()).toBe("storage_pending");
    expect(await refreshSessionIfPossible()).toBe(true);
    expect(session.state.accessToken).toBe("old-access");
    expect(session.state.refreshToken).toBe("old-refresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries an R2 storage commit without another network request", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const compareAndSet = session.compareAndSetSession!.bind(session);
    let commitCalls = 0;
    session.compareAndSetSession = async (expectedRevision, next) => {
      commitCalls += 1;
      if (commitCalls === 1) throw new Error("QuotaExceeded");
      return compareAndSet(expectedRevision, next);
    };
    const fetchImpl = vi.fn(async () => {
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

    expect(await refreshSession()).toBe("storage_pending");
    expect(await refreshSession()).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(commitCalls).toBe(2);
    expect(session.state.accessToken).toBe("new-access");
    expect(session.state.refreshToken).toBe("new-refresh");
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

  it.each(["logout", "login"] as const)(
    "does not let a late refresh overwrite a newer %s",
    async (mutation) => {
      const session = createSessionStore({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      let resolveRefresh!: (response: Response) => void;
      const fetchImpl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      configureApiClient({
        apiBaseUrl: "https://api.test",
        session,
        clientIdentity: { platform: "android", appVersion: "1.0.0" },
        fetchImpl,
      });

      const lateRefresh = refreshSession();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      supersedeSessionRefresh();
      session.replaceSession(
        mutation === "login"
          ? {
              accessToken: "login-access",
              refresh: { kind: "token", token: "login-refresh" },
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }
          : null,
      );
      resolveRefresh(
        new Response(
          JSON.stringify({
            accessToken: "late-access",
            refreshToken: "late-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      expect(await lateRefresh).toBe("superseded");
      expect(session.state.accessToken).toBe(
        mutation === "login" ? "login-access" : null,
      );
      expect(session.state.refreshToken).toBe(
        mutation === "login" ? "login-refresh" : null,
      );
    },
  );

  it("uses the persisted revision to reject an external late clear race", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let resolveRefresh!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
    });

    const lateRefresh = refreshSession();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    session.replaceSession(null);
    resolveRefresh(
      new Response(
        JSON.stringify({
          accessToken: "late-access",
          refreshToken: "late-refresh",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await lateRefresh).toBe("superseded");
    expect(session.state.accessToken).toBeNull();
    expect(session.state.refreshToken).toBeNull();
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

  it("authFetch retries with store access before calling refresh (JTI race)", async () => {
    const oldExp = Math.floor(Date.now() / 1000) + 3600;
    const newExp = oldExp + 60;
    const oldAccess = makeJwt(oldExp);
    const newAccess = makeJwt(newExp);
    const session = createSessionStore({
      accessToken: oldAccess,
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        throw new Error("refresh must not be called");
      }
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Bearer ${oldAccess}`) {
        // Peer rotated while this request was in flight.
        session.replaceSession({
          accessToken: newAccess,
          refresh: { kind: "token", token: "refresh" },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
        return new Response(JSON.stringify({ error: "Не удалось определить пользователя." }), {
          status: 401,
        });
      }
      if (auth === `Bearer ${newAccess}`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 500 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
    });

    const r = await authFetch("/api/auth/feed");
    expect(r.status).toBe(200);
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).endsWith("/api/auth/refresh"))).toBe(
      false,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("authFetch refreshes once when store still has the rejected access", async () => {
    const oldAccess = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const newAccess = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const session = createSessionStore({
      accessToken: oldAccess,
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: newAccess,
            refreshToken: "new-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Bearer ${newAccess}`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
    });

    const r = await authFetch("/api/auth/me");
    expect(r.status).toBe(200);
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/api/auth/refresh")),
    ).toHaveLength(1);
    expect(session.state.accessToken).toBe(newAccess);
  });

  it("authFetch retries on transient refresh when peer already wrote new access", async () => {
    const oldExp = Math.floor(Date.now() / 1000) + 3600;
    const newExp = oldExp + 120;
    const oldAccess = makeJwt(oldExp);
    const newAccess = makeJwt(newExp);
    const session = createSessionStore({
      accessToken: oldAccess,
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        session.replaceSession({
          accessToken: newAccess,
          refresh: { kind: "token", token: "refresh" },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
        return new Response(null, { status: 503 });
      }
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Bearer ${newAccess}`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    const r = await authFetch("/api/auth/me");
    expect(r.status).toBe(200);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(session.state.accessToken).toBe(newAccess);
  });

  it("authFetch does not re-hit peer token on transient after stale-first already failed it", async () => {
    const oldExp = Math.floor(Date.now() / 1000) + 3600;
    const newExp = oldExp + 120;
    const oldAccess = makeJwt(oldExp);
    const peerAccess = makeJwt(newExp);
    const session = createSessionStore({
      accessToken: oldAccess,
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    // Peer already rotated before our first response is handled.
    session.replaceSession({
      accessToken: peerAccess,
      refresh: { kind: "token", token: "refresh" },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    // But first doFetch still uses the token authFetch read at start — simulate by
    // resetting store to old for the initial read, then writing peer before recovery.
    session.replaceSession({
      accessToken: oldAccess,
      refresh: { kind: "token", token: "refresh" },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    let resourceHits = 0;
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(null, { status: 503 });
      }
      resourceHits += 1;
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Bearer ${oldAccess}`) {
        session.replaceSession({
          accessToken: peerAccess,
          refresh: { kind: "token", token: "refresh" },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
        return new Response(JSON.stringify({ error: "stale A" }), { status: 401 });
      }
      if (auth === `Bearer ${peerAccess}`) {
        return new Response(JSON.stringify({ error: "stale B" }), { status: 401 });
      }
      return new Response(null, { status: 500 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
      onUnauthorized,
    });

    await expect(authFetch("/api/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    // A (initial) + B (stale-first) — no third retry of B after transient.
    expect(resourceHits).toBe(2);
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/api/auth/refresh")),
    ).toHaveLength(1);
  });

  it("authFetch retries effective access after ready even if stale-pass already tried it", async () => {
    const oldExp = Math.floor(Date.now() / 1000) + 3600;
    const newExp = oldExp + 120;
    const oldAccess = makeJwt(oldExp);
    const newAccess = makeJwt(newExp);
    const session = createSessionStore({
      accessToken: oldAccess,
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    let resourceHits = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: newAccess,
            refreshToken: "new-refresh",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      resourceHits += 1;
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Bearer ${oldAccess}`) {
        session.replaceSession({
          accessToken: newAccess,
          refresh: { kind: "token", token: "old-refresh" },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
        return new Response(JSON.stringify({ error: "stale" }), { status: 401 });
      }
      // First try with newAccess (stale-pass) still 401; post-refresh try succeeds.
      if (auth === `Bearer ${newAccess}` && resourceHits <= 2) {
        return new Response(JSON.stringify({ error: "still" }), { status: 401 });
      }
      if (auth === `Bearer ${newAccess}`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 500 });
    });

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
    });

    const r = await authFetch("/api/auth/feed");
    expect(r.status).toBe(200);
    expect(resourceHits).toBe(3);
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/api/auth/refresh")),
    ).toHaveLength(1);
  });

  it("refreshSessionIfPossible is false on superseded when access did not change", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let entered!: () => void;
    let release!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runRefreshExclusive: RunRefreshExclusive = async (operation) => {
      entered();
      await lockRelease;
      return operation();
    };

    configureApiClient({
      apiBaseUrl: "https://api.test",
      session,
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl: vi.fn(),
      runRefreshExclusive,
    });

    const attempt = refreshSessionIfPossible("old-access");
    await lockEntered;
    session.replaceSession({
      accessToken: "old-access",
      refresh: { kind: "token", token: "old-refresh" },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    release();

    expect(await attempt).toBe(false);
  });

  it("held refresh exclusive does not let a peer start a second refresh POST", async () => {
    const session = createSessionStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let entered!: () => void;
    let release!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lockRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runRefreshExclusive: RunRefreshExclusive = async (operation) => {
      entered();
      await lockRelease;
      return operation();
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
      clientIdentity: { platform: "web", appVersion: "1.0.0" },
      fetchImpl,
      runRefreshExclusive,
    });

    const first = refreshSession();
    await lockEntered;
    const second = refreshSession();
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    release();
    expect(await first).toBe("ready");
    expect(await second).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
