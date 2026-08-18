import { describe, expect, it, vi } from "vitest";
import {
  createMobileSessionStore,
  LEGACY_REFRESH_KEY,
  type SecureStoreLike,
} from "./session";
import {
  createSessionController,
  parseStrictMePayload,
  type SessionControllerDependencies,
} from "./sessionController";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

class MemorySecureStore implements SecureStoreLike {
  readonly values = new Map<string, string>();
  failReads = false;

  async getItemAsync(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("device is locked");
    return this.values.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function meResponse() {
  return Response.json({
    userUuid: "user-1",
    username: "flora",
    displayName: "Flora",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controllerFor(
  overrides: Partial<SessionControllerDependencies> & {
    secureStore?: MemorySecureStore;
  } = {},
) {
  const secureStore = overrides.secureStore ?? new MemorySecureStore();
  const sessionStore =
    overrides.sessionStore ?? createMobileSessionStore(secureStore);
  const refresh = overrides.refreshSession ?? vi.fn(async () => "ready" as const);
  const supersede = overrides.supersedeRefresh ?? vi.fn();
  const fetchImpl =
    overrides.fetchImpl ??
    (vi.fn(async () => meResponse()) as unknown as typeof fetch);
  const controller = createSessionController({
    sessionStore,
    refreshSession: refresh,
    supersedeRefresh: supersede,
    fetchImpl,
    apiBaseUrl: "https://api.flora.test",
    clientHeader: "android/test",
    clock: { now: () => Date.parse("2029-01-01T00:00:00.000Z") },
    ...overrides,
  });
  return {
    controller,
    secureStore,
    sessionStore,
    refresh,
    supersede,
    fetchImpl,
  };
}

describe("mobile session controller", () => {
  it("keeps /me accountBlocked so the lockout wall can mount", () => {
    const me = parseStrictMePayload({
      userUuid: "user-1",
      username: "flora",
      displayName: "Flora",
      accountBlocked: true,
      accountBlockedUntil: null,
    });
    expect(me.accountBlocked).toBe(true);
    expect(me.accountBlockedUntil).toBeNull();
  });

  it("surfaces accountBlocked from /me onto the authenticated session", async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createMobileSessionStore(secureStore);
    await sessionStore.saveSession({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        userUuid: "user-1",
        username: "flora",
        displayName: "Flora",
        accountBlocked: true,
        accountBlockedUntil: null,
      }),
    ) as unknown as typeof fetch;
    const { controller } = controllerFor({
      secureStore,
      sessionStore,
      fetchImpl,
    });

    await controller.bootstrap();

    expect(controller.getState()).toMatchObject({
      status: "authenticated",
      me: {
        userUuid: "user-1",
        accountBlocked: true,
        accountBlockedUntil: null,
      },
    });
  });

  it("restores refresh-only cold-start state through the shared coordinator", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.values.set(LEGACY_REFRESH_KEY, "refresh-1");
    const sessionStore = createMobileSessionStore(secureStore);
    const refresh = vi.fn(async () => {
      const snapshot = await sessionStore.readSession();
      const committed = await sessionStore.compareAndSetSession(
        snapshot.revision,
        {
          accessToken: "access-2",
          refresh: { kind: "token", token: "refresh-2" },
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      );
      return committed ? ("ready" as const) : ("superseded" as const);
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer access-2",
      );
      return meResponse();
    }) as unknown as typeof fetch;
    const { controller } = controllerFor({
      secureStore,
      sessionStore,
      refreshSession: refresh,
      fetchImpl,
    });

    await controller.bootstrap();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: "authenticated",
      me: { userUuid: "user-1" },
    });
  });

  it("keeps a transient refresh failure degraded without clearing credentials", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.values.set(LEGACY_REFRESH_KEY, "refresh-1");
    const { controller, sessionStore } = controllerFor({
      secureStore,
      refreshSession: vi.fn(async () => "transient" as const),
    });

    await controller.bootstrap();

    expect(controller.getState()).toMatchObject({
      status: "degraded",
      reason: "refresh",
    });
    expect(await sessionStore.getRefreshToken()).toBe("refresh-1");
  });

  it("accepts terminal invalid once and does not replay forever after process death", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.values.set(LEGACY_REFRESH_KEY, "refresh-outside-grace");
    const sessionStore = createMobileSessionStore(secureStore);
    const refresh = vi.fn(async () => {
      const snapshot = await sessionStore.readSession();
      await sessionStore.compareAndClearSession(snapshot.revision);
      return "invalid" as const;
    });
    const { controller } = controllerFor({
      secureStore,
      sessionStore,
      refreshSession: refresh,
    });

    await controller.bootstrap();
    await controller.reconcile();

    expect(controller.getState().status).toBe("anonymous");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("treats invalid JSON and HTTP failures as degraded, never anonymous", async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createMobileSessionStore(secureStore);
    await sessionStore.saveSession({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const malformed = controllerFor({
      secureStore,
      sessionStore,
      fetchImpl: vi.fn(async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    await malformed.controller.bootstrap();
    expect(malformed.controller.getState()).toMatchObject({
      status: "degraded",
      reason: "protocol",
    });

    const throttled = controllerFor({
      secureStore,
      sessionStore,
      fetchImpl: vi.fn(async () =>
        Response.json({ error: "slow down" }, { status: 429 })) as unknown as typeof fetch,
    });
    await throttled.controller.bootstrap();
    expect(throttled.controller.getState()).toMatchObject({
      status: "degraded",
      reason: "http",
    });
  });

  it("maps SecureStore read exceptions to storageUnavailable", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.failReads = true;
    const { controller } = controllerFor({ secureStore });

    await controller.bootstrap();

    expect(controller.getState().status).toBe("storageUnavailable");
  });

  it("drops a late /me result after logout advances the epoch", async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createMobileSessionStore(secureStore);
    await sessionStore.saveSession({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const response = deferred<Response>();
    const fetchImpl = vi.fn(() => response.promise) as unknown as typeof fetch;
    const { controller, supersede } = controllerFor({
      secureStore,
      sessionStore,
      fetchImpl,
    });

    const bootstrap = controller.bootstrap();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.onLogout();
    response.resolve(meResponse());
    await bootstrap;

    expect(supersede).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("anonymous");
  });

  it("coalesces concurrent lifecycle triggers across refresh and /me", async () => {
    const secureStore = new MemorySecureStore();
    const sessionStore = createMobileSessionStore(secureStore);
    await sessionStore.saveSession({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const fetchImpl = vi.fn(async () => meResponse()) as unknown as typeof fetch;
    const { controller } = controllerFor({
      secureStore,
      sessionStore,
      fetchImpl,
    });

    const initial = controller.bootstrap();
    const netInfo = controller.reconcile();
    const appState = controller.reconcile();
    await Promise.all([initial, netInfo, appState]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("authenticated");
  });
});
