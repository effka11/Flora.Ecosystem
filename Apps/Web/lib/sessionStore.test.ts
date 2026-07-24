import assert from "node:assert/strict";
import test from "node:test";
import {
  authFetch,
  configureApiClient,
  ensureFreshAccessToken,
} from "@flora/client-core/api";
import {
  createWebAuthExclusive,
  createWebSessionStore,
  STORAGE_ACCESS,
  STORAGE_EXPIRES,
  STORAGE_REFRESH,
  STORAGE_SESSION,
  type StorageLike,
  type WebLockManagerLike,
} from "./sessionStore";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];

  getItem(key: string): string | null {
    this.operations.push(`get:${key}`);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.operations.push(`set:${key}`);
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.operations.push(`remove:${key}`);
    this.values.delete(key);
  }
}

test("Web session bridge preserves mixed-version login and logout", async () => {
  const storage = new MemoryStorage();
  storage.values.set(STORAGE_ACCESS, "legacy-access");
  storage.values.set(STORAGE_REFRESH, "http-only");
  storage.values.set(STORAGE_EXPIRES, "2030-01-01T00:00:00.000Z");
  const store = createWebSessionStore({
    getLocalStorage: () => storage,
    runExclusive: async (operation) => operation(),
  });

  const migrated = await store.readSession();
  assert.equal(migrated.session?.accessToken, "legacy-access");
  assert.equal(migrated.session?.refresh?.kind, "cookie");
  assert.ok(storage.values.has(STORAGE_SESSION));

  store.saveSessionSync({
    accessToken: "access-r2",
    refreshToken: "http-only",
    expiresAt: "2030-01-01T00:15:00.000Z",
  });
  assert.equal(storage.values.get(STORAGE_ACCESS), "access-r2");
  const legacyExpiresWrite = storage.operations.lastIndexOf(
    `set:${STORAGE_EXPIRES}`,
  );
  const canonicalWrite = storage.operations.lastIndexOf(`set:${STORAGE_SESSION}`);
  assert.ok(canonicalWrite > legacyExpiresWrite, "canonical active record commits last");

  let clearNotifications = 0;
  store.subscribeSessionCleared(() => {
    clearNotifications += 1;
  });
  storage.removeItem(STORAGE_ACCESS);
  storage.removeItem(STORAGE_REFRESH);
  storage.removeItem(STORAGE_EXPIRES);
  await store.reconcileLegacyBridge();

  assert.equal((await store.readSession()).session, null);
  assert.equal(clearNotifications, 1);

  // An older tab can still publish a complete triplet during the bridge release.
  storage.setItem(STORAGE_ACCESS, "legacy-login-access");
  storage.setItem(STORAGE_REFRESH, "legacy-login-refresh");
  storage.setItem(STORAGE_EXPIRES, "2030-01-02T00:00:00.000Z");
  await store.reconcileLegacyBridge();
  const bridgedLogin = await store.readSession();
  assert.equal(bridgedLogin.session?.accessToken, "legacy-login-access");
  assert.deepEqual(bridgedLogin.session?.refresh, {
    kind: "token",
    token: "legacy-login-refresh",
  });

  storage.operations.length = 0;
  store.clearSessionSync();
  const tombstoneIndex = storage.operations.indexOf(`set:${STORAGE_SESSION}`);
  const legacyRemovalIndex = storage.operations.indexOf(`remove:${STORAGE_ACCESS}`);
  assert.ok(tombstoneIndex >= 0);
  assert.ok(legacyRemovalIndex > tombstoneIndex, "logout tombstone commits first");
});

test("keep-alive and realtime share one client-core refresh", async () => {
  const storage = new MemoryStorage();
  const store = createWebSessionStore({
    getLocalStorage: () => storage,
    runExclusive: async (operation) => operation(),
  });
  store.saveSessionSync({
    accessToken: "access-r1",
    refreshToken: "http-only",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  let refreshCalls = 0;
  const resourceTokens: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/auth/refresh")) {
      refreshCalls += 1;
      await Promise.resolve();
      return Response.json({
        accessToken: "access-r2",
        refreshToken: "http-only",
        expiresAt: "2030-01-01T00:15:00.000Z",
      });
    }
    const token = new Headers(init?.headers).get("authorization") ?? "";
    resourceTokens.push(token);
    return new Response(null, { status: token === "Bearer access-r2" ? 200 : 401 });
  }) as typeof fetch;

  configureApiClient({
    apiBaseUrl: "https://api.flora.test",
    session: store,
    clientIdentity: { platform: "web", appVersion: "test" },
    fetchImpl,
    runRefreshExclusive: async (operation) => operation(),
  });

  const [, realtime] = await Promise.all([
    ensureFreshAccessToken(),
    authFetch("/api/auth/signals/stream", {
      headers: { Accept: "text/event-stream" },
    }),
  ]);

  assert.equal(realtime.status, 200);
  assert.equal(refreshCalls, 1);
  assert.equal(store.getAccessTokenSync(), "access-r2");
  assert.ok(resourceTokens.includes("Bearer access-r2"));
});

test("Web Lock never repeats a callback that already started and failed", async () => {
  const locks: WebLockManagerLike = {
    request: async (_name, _options, callback) => callback(),
  };
  const exclusive = createWebAuthExclusive({
    getLockManager: () => locks,
    waitMs: 1_000,
  });
  let calls = 0;

  await assert.rejects(
    exclusive(async () => {
      calls += 1;
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(calls, 1);
});
