import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxyFloraApiRequest } from "./floraApiProxy";

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
    });

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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUpstream === undefined) delete process.env.FLORA_API_UPSTREAM;
    else process.env.FLORA_API_UPSTREAM = originalUpstream;
  }
});
