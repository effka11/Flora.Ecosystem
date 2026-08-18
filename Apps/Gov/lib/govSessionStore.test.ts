import assert from "node:assert/strict";
import test from "node:test";
import {
  createGovAuthExclusive,
  createGovSessionStore,
  GOV_AUTH_LOCK_NAME,
  GOV_REFRESH_COOKIE_MARKER,
  GOV_SESSION_STORAGE_KEY,
  type GovLockManagerLike,
  type StorageLike,
} from "./govSessionStore";

/** Flora Social's key. Gov shares localStorage with nothing and must never touch it. */
const SOCIAL_SESSION_KEY = "flora_session_v1";

const ACCESS_TOKEN = "access.token.value";
const EXPIRES_AT = "2026-08-17T21:00:00.000Z";

type TrackedStorage = {
  storage: StorageLike;
  entries: Map<string, string>;
  touchedKeys: string[];
};

function trackedStorage(seed: Record<string, string> = {}): TrackedStorage {
  const entries = new Map<string, string>(Object.entries(seed));
  const touchedKeys: string[] = [];
  return {
    entries,
    touchedKeys,
    storage: {
      getItem(key) {
        touchedKeys.push(key);
        return entries.get(key) ?? null;
      },
      setItem(key, value) {
        touchedKeys.push(key);
        entries.set(key, value);
      },
      removeItem(key) {
        touchedKeys.push(key);
        entries.delete(key);
      },
    },
  };
}

function storeOver(local: TrackedStorage, session?: TrackedStorage) {
  return createGovSessionStore({
    getLocalStorage: () => local.storage,
    ...(session ? { getSessionStorage: () => session.storage } : {}),
  });
}

test("saves and reads the session under exactly flora_gov_session_v1", async () => {
  const local = trackedStorage();
  const store = storeOver(local);

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });

  assert.deepEqual([...local.entries.keys()], [GOV_SESSION_STORAGE_KEY]);
  assert.equal(await store.getAccessToken(), ACCESS_TOKEN);
  assert.equal(await store.getExpiresAt(), EXPIRES_AT);
  assert.deepEqual(await store.readSession(), {
    revision: 1,
    session: { accessToken: ACCESS_TOKEN, refresh: { kind: "cookie" }, expiresAt: EXPIRES_AT },
  });
});

test("the http-only marker becomes the cookie capability and stores no refresh credential", async () => {
  const local = trackedStorage();
  const store = storeOver(local);

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });

  const snapshot = await store.readSession();
  assert.deepEqual(snapshot.session?.refresh, { kind: "cookie" });
  assert.equal(await store.getRefreshToken(), GOV_REFRESH_COOKIE_MARKER);

  const persisted = local.entries.get(GOV_SESSION_STORAGE_KEY) ?? "";
  assert.equal(JSON.parse(persisted).session.refresh.kind, "cookie");
  assert.ok(!persisted.includes(GOV_REFRESH_COOKIE_MARKER));
});

test("refuses a browser-readable refresh token and writes nothing", async () => {
  const local = trackedStorage();
  const store = storeOver(local);

  await assert.rejects(
    () =>
      store.saveSession({
        accessToken: ACCESS_TOKEN,
        refreshToken: "raw.refresh.token",
        expiresAt: EXPIRES_AT,
      }),
    /refuses a browser-readable refresh token/,
  );

  assert.equal(local.entries.size, 0);
  assert.equal(await store.getAccessToken(), null);

  await assert.rejects(
    () =>
      store.compareAndSetSession(0, {
        accessToken: ACCESS_TOKEN,
        refresh: { kind: "token", token: "raw.refresh.token" },
        expiresAt: EXPIRES_AT,
      }),
    /refuses a browser-readable refresh token/,
  );
  assert.equal(local.entries.size, 0);
});

test("clearSession empties the session and keeps the tombstone under the Gov key", async () => {
  const local = trackedStorage();
  const sessionStorage = trackedStorage();
  const store = storeOver(local, sessionStorage);

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });
  await store.setPendingProfileSetup(true);
  await store.clearSession();

  assert.equal(await store.getAccessToken(), null);
  assert.equal(await store.getRefreshToken(), null);
  assert.equal(await store.getExpiresAt(), null);
  assert.equal(await store.hasPendingProfileSetup(), false);
  assert.deepEqual(await store.readSession(), { revision: 2, session: null });
  assert.deepEqual([...local.entries.keys()], [GOV_SESSION_STORAGE_KEY]);
});

test("never reads or writes the Flora Social session key", async () => {
  const local = trackedStorage({ [SOCIAL_SESSION_KEY]: "social-session-payload" });
  const store = storeOver(local, trackedStorage());

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });
  await store.getAccessToken();
  await store.readSession();
  await store.clearSession();

  assert.ok(local.touchedKeys.length > 0);
  assert.deepEqual([...new Set(local.touchedKeys)], [GOV_SESSION_STORAGE_KEY]);
  assert.equal(local.entries.get(SOCIAL_SESSION_KEY), "social-session-payload");
});

test("an unreadable record reads as signed out and is replaced on the next write", async () => {
  const local = trackedStorage({ [GOV_SESSION_STORAGE_KEY]: '{"version":1,"kind":"active"' });
  const store = storeOver(local);

  assert.equal(await store.getAccessToken(), null);
  assert.deepEqual(await store.readSession(), { revision: 0, session: null });

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(await store.getAccessToken(), ACCESS_TOKEN);
});

test("compare-and-set commits only against the expected revision", async () => {
  const local = trackedStorage();
  const store = storeOver(local);

  await store.saveSession({
    accessToken: ACCESS_TOKEN,
    refreshToken: GOV_REFRESH_COOKIE_MARKER,
    expiresAt: EXPIRES_AT,
  });
  const rotated = {
    accessToken: "rotated.access.token",
    refresh: { kind: "cookie" } as const,
    expiresAt: "2026-08-17T21:15:00.000Z",
  };

  assert.equal(await store.compareAndSetSession(0, rotated), false);
  assert.equal(await store.getAccessToken(), ACCESS_TOKEN);

  assert.equal(await store.compareAndSetSession(1, rotated), true);
  assert.equal(await store.getAccessToken(), "rotated.access.token");

  assert.equal(await store.compareAndClearSession(1), false);
  assert.equal(await store.compareAndClearSession(2), true);
  assert.equal(await store.getAccessToken(), null);
});

test("server rendering has no storage and reports no session", async () => {
  const store = createGovSessionStore({ getLocalStorage: () => null });

  assert.equal(await store.getAccessToken(), null);
  assert.deepEqual(await store.readSession(), { revision: 0, session: null });
  assert.equal(await store.compareAndSetSession(0, {
    accessToken: ACCESS_TOKEN,
    refresh: { kind: "cookie" },
    expiresAt: EXPIRES_AT,
  }), false);
  await store.clearSession();
});

test("refresh runs inside the Gov Web Lock when the browser provides one", async () => {
  const requested: string[] = [];
  const locks: GovLockManagerLike = {
    async request(name, _options, callback) {
      requested.push(name);
      return callback();
    },
  };
  const exclusive = createGovAuthExclusive({ getLockManager: () => locks });

  assert.equal(await exclusive(async () => "refreshed"), "refreshed");
  assert.deepEqual(requested, [GOV_AUTH_LOCK_NAME]);
});

test("refresh never runs unlocked once a lock manager exists but denies the lock", async () => {
  let operationRuns = 0;
  const locks: GovLockManagerLike = {
    async request() {
      throw new Error("lock unavailable");
    },
  };
  const exclusive = createGovAuthExclusive({ getLockManager: () => locks, waitMs: 5 });

  await assert.rejects(
    () =>
      exclusive(async () => {
        operationRuns += 1;
        return "refreshed";
      }),
    /lock unavailable/,
  );
  assert.equal(operationRuns, 0);
});

test("refresh still runs where Web Locks are unavailable", async () => {
  const exclusive = createGovAuthExclusive({ getLockManager: () => null });
  assert.equal(await exclusive(async () => "refreshed"), "refreshed");
});
