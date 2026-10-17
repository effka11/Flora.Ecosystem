import assert from "node:assert/strict";
import test from "node:test";
import { configureApiClient, syncStoredSessionTokens } from "@flora/client-core/api";
import type { SessionSnapshot } from "@flora/client-core/auth";
import {
  createWebSessionStore,
  webSessionStore,
  type StorageLike,
} from "./sessionStore";
import {
  resetResumeWebSessionVisitForTests,
  resumeWebSession,
  type ResumeWebSessionDeps,
  type ResumeWebSessionResult,
} from "./resumeWebSession";

type SessionBody = SessionSnapshot["session"];

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function cookieSession(access: string | null, expiresAt: string | null = "2030-01-01T00:00:00.000Z"): SessionBody {
  return {
    accessToken: access,
    refresh: { kind: "cookie" },
    expiresAt,
  };
}

function harness(options: {
  session: SessionBody;
  pending?: boolean;
  sync?: (apply: (next: SessionBody) => void, call: number) => void | Promise<void>;
  probe?: () => Promise<Response>;
}) {
  let current: SessionSnapshot = { revision: 1, session: options.session };
  const calls = { sync: 0, probe: 0, save: 0 };
  const apply = (next: SessionBody) => {
    current = { revision: current.revision + 1, session: next };
  };
  const deps: ResumeWebSessionDeps = {
    readSession: async () => current,
    syncStoredSessionTokens: async () => {
      calls.sync += 1;
      await options.sync?.(apply, calls.sync);
    },
    probeRefresh: async () => {
      calls.probe += 1;
      return options.probe ? options.probe() : new Response(null, { status: 401 });
    },
    saveSession: (raw) => {
      calls.save += 1;
      const body = raw as { accessToken?: string; refreshToken?: string; expiresAt?: string };
      if (!body.accessToken || !body.refreshToken || !body.expiresAt) {
        throw new Error("incomplete session");
      }
      apply({
        accessToken: body.accessToken,
        refresh:
          body.refreshToken === "http-only"
            ? { kind: "cookie" }
            : { kind: "token", token: body.refreshToken },
        expiresAt: body.expiresAt,
      });
    },
    hasPendingProfileSetup: () => options.pending ?? false,
  };
  return {
    deps,
    calls,
    current: () => current,
  };
}

function createStore() {
  const storage = new MemoryStorage();
  const store = createWebSessionStore({
    getLocalStorage: () => storage,
    runExclusive: async (operation) => operation(),
  });
  return { storage, store };
}

function configureCoordinator(store: ReturnType<typeof createWebSessionStore>, fetchImpl: typeof fetch): void {
  configureApiClient({
    apiBaseUrl: "https://api.flora.test",
    session: store,
    clientIdentity: { platform: "web", appVersion: "test" },
    fetchImpl,
    onUnauthorized: () => undefined,
    runRefreshExclusive: async (operation) => operation(),
    retrySafeRefreshBackend: true,
  });
}

test("resumeWebSession chooses feed, profile, login, or hold", async (t) => {
  await t.test("live stored refresh resolves to feed without a cookie probe", async () => {
    const live = harness({ session: cookieSession("access-live") });
    assert.equal(await resumeWebSession(live.deps), "feed");
    assert.equal(live.calls.sync, 1);
    assert.equal(live.calls.probe, 0);
    assert.equal(live.calls.save, 0);
  });

  await t.test("a stored token refresh syncs and does not probe", async () => {
    const token = harness({
      session: {
        accessToken: "access-live",
        refresh: { kind: "token", token: "refresh-secret" },
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    assert.equal(await resumeWebSession(token.deps), "feed");
    assert.equal(token.calls.sync, 1);
    assert.equal(token.calls.probe, 0);
  });

  await t.test("expired access and a successful refresh resolves to feed", async () => {
    const expired = harness({
      session: cookieSession("access-old", "2000-01-01T00:00:00.000Z"),
      sync: (apply) => {
        apply(cookieSession("access-new", "2030-01-01T00:15:00.000Z"));
      },
    });
    assert.equal(await resumeWebSession(expired.deps), "feed");
    assert.equal(expired.calls.sync, 1);
    assert.equal(expired.calls.probe, 0);
    assert.equal(expired.current().session?.accessToken, "access-new");
  });

  await t.test("no stored session and a cookie 200 saves and resolves to feed", async () => {
    const restored = harness({
      session: null,
      probe: async () =>
        Response.json({
          accessToken: "access-cookie",
          refreshToken: "http-only",
          expiresAt: "2030-01-01T00:15:00.000Z",
        }),
    });
    assert.equal(await resumeWebSession(restored.deps), "feed");
    assert.equal(restored.calls.sync, 0);
    assert.equal(restored.calls.probe, 1);
    assert.equal(restored.calls.save, 1);
    assert.equal(restored.current().session?.accessToken, "access-cookie");
    assert.equal(restored.current().session?.refresh?.kind, "cookie");
  });

  await t.test("401 without a stored session stays on login and does not save", async () => {
    const missing = harness({ session: null });
    assert.equal(await resumeWebSession(missing.deps), "login");
    assert.equal(missing.calls.sync, 0);
    assert.equal(missing.calls.probe, 1);
    assert.equal(missing.calls.save, 0);
    assert.equal(missing.current().session, null);
  });

  await t.test("a failed cookie probe does not clear or save", async () => {
    const offline = harness({
      session: null,
      probe: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(await resumeWebSession(offline.deps), "login");
    assert.equal(offline.calls.probe, 1);
    assert.equal(offline.calls.save, 0);
    assert.equal(offline.current().session, null);
  });

  await t.test("pending profile setup stays out of the feed", async () => {
    const pending = harness({ session: cookieSession("access-live"), pending: true });
    assert.equal(await resumeWebSession(pending.deps), "profile");
    assert.equal(pending.calls.sync, 1);
    assert.equal(pending.calls.probe, 0);
  });

  await t.test("transient refresh with access still in the record stays on feed", async () => {
    const transient = harness({
      session: cookieSession("access-stale", "2000-01-01T00:00:00.000Z"),
    });
    assert.equal(await resumeWebSession(transient.deps), "feed");
    assert.equal(transient.calls.sync, 1);
    assert.equal(transient.calls.probe, 0);
    assert.equal(transient.calls.save, 0);
    assert.equal(transient.current().session?.accessToken, "access-stale");
  });

  await t.test("transient refresh with empty access retries sync once then holds", async () => {
    const held = harness({ session: cookieSession(null, null) });
    assert.equal(await resumeWebSession(held.deps), "hold");
    assert.equal(held.calls.sync, 2);
    assert.equal(held.calls.probe, 0);
    assert.equal(held.calls.save, 0);
    assert.equal(held.current().session?.accessToken, null);
    assert.equal(held.current().session?.refresh?.kind, "cookie");
  });

  await t.test("the hold retry that restores access resolves to feed without a probe", async () => {
    const recovered = harness({
      session: cookieSession(null, null),
      sync: (apply, call) => {
        if (call === 2) apply(cookieSession("access-after-retry"));
      },
    });
    assert.equal(await resumeWebSession(recovered.deps), "feed");
    assert.equal(recovered.calls.sync, 2);
    assert.equal(recovered.calls.probe, 0);
    assert.equal(recovered.calls.save, 0);
    assert.equal(recovered.current().session?.accessToken, "access-after-retry");
  });

  await t.test("a confirmed invalid refresh resolves to login without a probe", async () => {
    const invalid = harness({
      session: cookieSession("access-old", "2000-01-01T00:00:00.000Z"),
      sync: (apply) => {
        apply(null);
      },
    });
    assert.equal(await resumeWebSession(invalid.deps), "login");
    assert.equal(invalid.calls.sync, 1);
    assert.equal(invalid.calls.probe, 0);
    assert.equal(invalid.calls.save, 0);
    assert.equal(invalid.current().session, null);
  });
});

test("resumeWebSession follows the auth refresh coordinator", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  async function run(
    prepare: (store: ReturnType<typeof createWebSessionStore>) => void | Promise<void>,
    fetchImpl: typeof fetch,
    syncs: { count: number },
  ): Promise<{ destination: ResumeWebSessionResult; store: ReturnType<typeof createWebSessionStore>; probes: number }> {
    // Past the coordinator's 60s proactive grace so each case can refresh on its own.
    now += 120_000;
    const { store } = createStore();
    await prepare(store);
    let probes = 0;
    configureCoordinator(store, fetchImpl);
    const destination = await resumeWebSession({
      readSession: () => store.readSession(),
      syncStoredSessionTokens: async () => {
        syncs.count += 1;
        await syncStoredSessionTokens();
      },
      probeRefresh: async () => {
        probes += 1;
        return new Response(null, { status: 401 });
      },
      saveSession: () => {
        throw new Error("cookie probe must not save over a stored refresh");
      },
      hasPendingProfileSetup: () => false,
    });
    return { destination, store, probes };
  }

  await t.test("a live record does not refresh or probe", async () => {
    let fetches = 0;
    const syncs = { count: 0 };
    const { destination, probes } = await run(
      (store) => {
        store.saveSessionSync({
          accessToken: "access-live",
          refreshToken: "http-only",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      },
      async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
      syncs,
    );
    assert.equal(destination, "feed");
    assert.equal(syncs.count, 1);
    assert.equal(fetches, 0);
    assert.equal(probes, 0);
  });

  await t.test("expired access is refreshed once into feed", async () => {
    let fetches = 0;
    const syncs = { count: 0 };
    const { destination, store, probes } = await run(
      (store) => {
        store.saveSessionSync({
          accessToken: "access-old",
          refreshToken: "http-only",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
      },
      async () => {
        fetches += 1;
        return Response.json({
          accessToken: "access-new",
          refreshToken: "http-only",
          expiresAt: "2030-01-01T00:15:00.000Z",
        });
      },
      syncs,
    );
    assert.equal(destination, "feed");
    assert.equal(syncs.count, 1);
    assert.equal(fetches, 1);
    assert.equal(probes, 0);
    assert.equal(store.getAccessTokenSync(), "access-new");
  });

  await t.test("a transient refresh keeps the existing access and does not probe", async () => {
    let fetches = 0;
    const syncs = { count: 0 };
    const { destination, store, probes } = await run(
      (store) => {
        store.saveSessionSync({
          accessToken: "access-stale",
          refreshToken: "http-only",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
      },
      async () => {
        fetches += 1;
        return new Response(null, { status: 503 });
      },
      syncs,
    );
    assert.equal(destination, "feed");
    assert.equal(syncs.count, 1);
    assert.equal(fetches, 1);
    assert.equal(probes, 0);
    assert.equal(store.getAccessTokenSync(), "access-stale");
    assert.equal(store.getRefreshTokenSync(), "http-only");
  });

  await t.test("empty access retries sync once and holds the refresh", async () => {
    let fetches = 0;
    const syncs = { count: 0 };
    const { destination, store, probes } = await run(
      async (store) => {
        store.saveSessionSync({
          accessToken: "access-temp",
          refreshToken: "http-only",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
        const snap = await store.readSession();
        assert.ok(snap.session?.refresh);
        assert.equal(
          await store.compareAndSetSession(snap.revision, {
            accessToken: null,
            refresh: { kind: "cookie" },
            expiresAt: null,
          }),
          true,
        );
      },
      async () => {
        fetches += 1;
        return new Response(null, { status: 503 });
      },
      syncs,
    );
    assert.equal(destination, "hold");
    assert.equal(syncs.count, 2);
    // The second sync is inside the coordinator's 60s grace, so it must not spend the refresh again.
    assert.equal(fetches, 1);
    assert.equal(probes, 0);
    assert.equal(store.getAccessTokenSync(), null);
    assert.equal(store.getRefreshTokenSync(), "http-only");
  });

  await t.test("a confirmed invalid refresh clears the record and does not probe", async () => {
    let fetches = 0;
    const syncs = { count: 0 };
    const { destination, store, probes } = await run(
      (store) => {
        store.saveSessionSync({
          accessToken: "access-old",
          refreshToken: "http-only",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
      },
      async () => {
        fetches += 1;
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      },
      syncs,
    );
    assert.equal(destination, "login");
    assert.equal(syncs.count, 1);
    assert.equal(fetches, 1);
    assert.equal(probes, 0);
    assert.equal((await store.readSession()).session, null);
  });
});

test("one visit shares a single cookie probe until the session is cleared", async () => {
  resetResumeWebSessionVisitForTests();
  const originalFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  let probes = 0;
  globalThis.fetch = (async () => {
    probes += 1;
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const [first, second] = await Promise.all([resumeWebSession(), resumeWebSession()]);
    assert.equal(first, "login");
    assert.equal(second, "login");
    assert.equal(probes, 1);

    const storage = new MemoryStorage();
    globalThis.window = {
      localStorage: storage,
      sessionStorage: storage,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    } as unknown as Window & typeof globalThis;
    webSessionStore.clearSessionSync();

    assert.equal(await resumeWebSession(), "login");
    assert.equal(probes, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = previousWindow;
    }
    resetResumeWebSessionVisitForTests();
  }
});
