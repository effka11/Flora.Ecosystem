import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxyFloraApiRequest } from "./floraApiProxy";
import {
  createWebAuthExclusive,
  type WebLockManagerLike,
} from "./sessionStore";

class SerialWebLockManager implements WebLockManagerLike {
  private tail: Promise<void> = Promise.resolve();

  request<T>(
    _name: string,
    _options: { signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T> {
    const result = this.tail.then(callback);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("auth proxy keeps refresh credentials out of browser-readable storage", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUpstream = process.env.FLORA_API_UPSTREAM;
  process.env.FLORA_API_UPSTREAM = "https://flora-api.internal";

  try {
    await t.test("moves login refresh token into an HttpOnly cookie", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          accessToken: "access-token",
          refreshToken: "session-id.secret",
          expiresAt: "2030-01-01T00:00:00Z",
        })) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "alice", password: "correct horse battery staple" }),
          headers: {
            "content-type": "application/json",
            origin: "https://social.flora.example",
          },
        }),
      );

      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(payload.refreshToken, "http-only");
      assert.doesNotMatch(JSON.stringify(payload), /session-id\.secret/);
      assert.match(response.headers.get("set-cookie") ?? "", /flora_refresh=session-id\.secret/);
      assert.match(response.headers.get("set-cookie") ?? "", /flora_media_access=access-token/);
      assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
      assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Strict/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });

    await t.test("uses the HttpOnly cookie for refresh and rotates it", async () => {
      let forwardedBody: unknown;
      globalThis.fetch = (async (_input, init) => {
        forwardedBody = await new Response(init?.body).json();
        return Response.json({
          accessToken: "next-access-token",
          refreshToken: "session-id.next-secret",
          expiresAt: "2030-01-01T00:15:00Z",
        });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: "http-only" }),
          headers: {
            "content-type": "application/json",
            cookie: "flora_refresh=session-id.old-secret",
            origin: "https://social.flora.example",
          },
        }),
      );

      assert.deepEqual(forwardedBody, { refreshToken: "session-id.old-secret" });
      assert.match(response.headers.get("set-cookie") ?? "", /session-id\.next-secret/);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(payload.refreshToken, "http-only");
    });

    await t.test("expires the cookie when refresh authorization fails", async () => {
      globalThis.fetch = (async () =>
        Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: "http-only" }),
          headers: {
            "content-type": "application/json",
            cookie: "flora_refresh=session-id.expired-secret",
            origin: "https://social.flora.example",
          },
        }),
      );

      assert.equal(response.status, 401);
      assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      assert.match(response.headers.get("set-cookie") ?? "", /flora_media_access=/);
    });

    await t.test("does not spend a refresh cookie for a cross-origin request", async () => {
      let calledUpstream = false;
      globalThis.fetch = (async () => {
        calledUpstream = true;
        return Response.json({});
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: "http-only" }),
          headers: {
            "content-type": "application/json",
            cookie: "flora_refresh=session-id.secret",
            origin: "https://compromised-sibling.flora.example",
          },
        }),
      );

      assert.equal(response.status, 403);
      assert.equal(calledUpstream, false);
      assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(payload.error, "Cross-origin refresh is not allowed.");
    });

    await t.test(
      "allows cookie refresh when browser Origin is https but NextURL is http",
      async () => {
        let forwardedBody: unknown;
        globalThis.fetch = (async (_input, init) => {
          forwardedBody = await new Response(init?.body).json();
          return Response.json({
            accessToken: "next-access-token",
            refreshToken: "session-id.next-secret",
            expiresAt: "2030-01-01T00:15:00Z",
          });
        }) as typeof fetch;

        // Behind nginx Next often sees http://host while the browser Origin is https://host.
        const response = await proxyFloraApiRequest(
          new NextRequest("http://social.flora.example/api/auth/refresh", {
            method: "POST",
            body: "{}",
            headers: {
              "content-type": "application/json",
              cookie: "flora_refresh=session-id.old-secret",
              "x-forwarded-proto": "https",
              origin: "https://social.flora.example",
            },
          }),
        );

        assert.equal(response.status, 200);
        assert.deepEqual(forwardedBody, { refreshToken: "session-id.old-secret" });
      },
    );

    await t.test(
      "allows cookie refresh when Next listens on loopback and nginx sets Host",
      async () => {
        let forwardedBody: unknown;
        globalThis.fetch = (async (_input, init) => {
          forwardedBody = await new Response(init?.body).json();
          return Response.json({
            accessToken: "next-access-token",
            refreshToken: "session-id.next-secret",
            expiresAt: "2030-01-01T00:15:00Z",
          });
        }) as typeof fetch;

        const response = await proxyFloraApiRequest(
          new NextRequest("http://127.0.0.1:3000/api/auth/refresh", {
            method: "POST",
            body: "{}",
            headers: {
              "content-type": "application/json",
              cookie: "flora_refresh=session-id.old-secret",
              host: "social.flora.example",
              "x-forwarded-proto": "https",
              origin: "https://social.flora.example",
              "sec-fetch-site": "same-origin",
            },
          }),
        );

        assert.equal(response.status, 200);
        assert.deepEqual(forwardedBody, { refreshToken: "session-id.old-secret" });
      },
    );

    await t.test(
      "rejects forged X-Forwarded-Host that does not match nginx Host",
      async () => {
        let calledUpstream = false;
        globalThis.fetch = (async () => {
          calledUpstream = true;
          return Response.json({});
        }) as typeof fetch;

        const response = await proxyFloraApiRequest(
          new NextRequest("http://127.0.0.1:3000/api/auth/refresh", {
            method: "POST",
            body: "{}",
            headers: {
              "content-type": "application/json",
              cookie: "flora_refresh=session-id.secret",
              host: "social.flora.example",
              "x-forwarded-proto": "https",
              "x-forwarded-host": "evil.flora.example",
              origin: "https://evil.flora.example",
            },
          }),
        );

        assert.equal(response.status, 403);
        assert.equal(calledUpstream, false);
        assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      },
    );

    await t.test(
      "rejects cross-site sec-fetch-site with foreign Origin",
      async () => {
        let calledUpstream = false;
        globalThis.fetch = (async () => {
          calledUpstream = true;
          return Response.json({});
        }) as typeof fetch;

        const response = await proxyFloraApiRequest(
          new NextRequest("https://social.flora.example/api/auth/refresh", {
            method: "POST",
            body: "{}",
            headers: {
              "content-type": "application/json",
              cookie: "flora_refresh=session-id.secret",
              origin: "https://evil.flora.example",
              "sec-fetch-site": "cross-site",
            },
          }),
        );

        assert.equal(response.status, 403);
        assert.equal(calledUpstream, false);
        assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      },
    );

    await t.test("preserves token pairs for native clients using SecureStore", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          accessToken: "native-access",
          refreshToken: "native-refresh",
          expiresAt: "2030-01-01T00:00:00Z",
        })) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://origin.flora.example/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "alice", password: "secret" }),
          headers: {
            "content-type": "application/json",
            "x-flora-client": "android/0.7.0",
          },
        }),
      );

      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(payload.refreshToken, "native-refresh");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });

    await t.test("lifts flora_media_access cookie into Authorization when absent", async () => {
      let upstreamAuthorization: string | null = null;
      let upstreamCookie: string | null = null;
      globalThis.fetch = (async (_input, init) => {
        const headers = new Headers(init?.headers);
        upstreamAuthorization = headers.get("authorization");
        upstreamCookie = headers.get("cookie");
        return new Response(new Uint8Array([0x8f, 0x46, 0x52, 0x49]), {
          status: 200,
          headers: { "content-type": "image/fri" },
        });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest(
          "https://social.flora.example/api/auth/posts/images/019fe0b6-01b8-7943-a62a-2414910e0027?fmt=fri",
          {
            method: "GET",
            headers: {
              accept: "image/fri",
              cookie: "flora_refresh=session-id.secret; flora_media_access=media-jwt-token",
            },
          },
        ),
      );

      assert.equal(response.status, 200);
      assert.equal(upstreamAuthorization, "Bearer media-jwt-token");
      assert.equal(upstreamCookie, null);
    });

    await t.test("lifts __Host-flora_media_access cookie into Authorization when absent", async () => {
      let upstreamAuthorization: string | null = null;
      globalThis.fetch = (async (_input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/posts/videos/vid/poster?fmt=fri", {
          method: "GET",
          headers: {
            cookie: "__Host-flora_media_access=host-media-jwt",
          },
        }),
      );

      assert.equal(response.status, 204);
      assert.equal(upstreamAuthorization, "Bearer host-media-jwt");
    });

    await t.test("prefers __Host-flora_media_access over bare flora_media_access", async () => {
      let upstreamAuthorization: string | null = null;
      globalThis.fetch = (async (_input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/me", {
          method: "GET",
          headers: {
            cookie:
              "flora_media_access=bare-media-jwt; __Host-flora_media_access=host-media-jwt",
          },
        }),
      );

      assert.equal(response.status, 204);
      assert.equal(upstreamAuthorization, "Bearer host-media-jwt");
    });

    await t.test("does not override an explicit Authorization header with media cookie", async () => {
      let upstreamAuthorization: string | null = null;
      globalThis.fetch = (async (_input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get("authorization");
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("https://social.flora.example/api/auth/me", {
          method: "GET",
          headers: {
            authorization: "Bearer explicit-access",
            cookie: "flora_media_access=media-jwt-token",
          },
        }),
      );

      assert.equal(response.status, 204);
      assert.equal(upstreamAuthorization, "Bearer explicit-access");
    });

    await t.test("Web Lock orders a stale proxy refresh response before a new login cookie", async () => {
      const refreshResponse = deferred();
      const refreshStarted = deferred();
      let loginReachedUpstream = false;
      let browserRefreshCookie = "session-id.r1";

      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.endsWith("/api/auth/refresh")) {
          refreshStarted.resolve();
          await refreshResponse.promise;
          return Response.json({
            accessToken: "access-r2",
            refreshToken: "session-id.r2",
            expiresAt: "2030-01-01T00:15:00Z",
          });
        }
        loginReachedUpstream = true;
        return Response.json({
          accessToken: "access-r3",
          refreshToken: "session-id.r3",
          expiresAt: "2030-01-01T00:30:00Z",
        });
      }) as typeof fetch;

      const lockManager = new SerialWebLockManager();
      const exclusive = createWebAuthExclusive({
        getLockManager: () => lockManager,
        waitMs: 1_000,
      });
      const applyCookie = async (request: NextRequest) => {
        const response = await proxyFloraApiRequest(request);
        const setCookie = response.headers.get("set-cookie") ?? "";
        const match = setCookie.match(/(?:__Host-)?flora_refresh=([^;,\s]+)/);
        if (match?.[1]) browserRefreshCookie = match[1];
      };

      const staleRefresh = exclusive(() =>
        applyCookie(
          new NextRequest("https://social.flora.example/api/auth/refresh", {
            method: "POST",
            body: "{}",
            headers: {
              "content-type": "application/json",
              cookie: `flora_refresh=${browserRefreshCookie}`,
              origin: "https://social.flora.example",
            },
          }),
        ),
      );
      await refreshStarted.promise;

      const newLogin = exclusive(() =>
        applyCookie(
          new NextRequest("https://social.flora.example/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ email: "alice@example.test", password: "secret" }),
            headers: {
              "content-type": "application/json",
              origin: "https://social.flora.example",
            },
          }),
        ),
      );
      await Promise.resolve();
      assert.equal(loginReachedUpstream, false);

      refreshResponse.resolve();
      await Promise.all([staleRefresh, newLogin]);
      assert.equal(browserRefreshCookie, "session-id.r3");
      assert.equal(loginReachedUpstream, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUpstream === undefined) delete process.env.FLORA_API_UPSTREAM;
    else process.env.FLORA_API_UPSTREAM = originalUpstream;
  }
});
