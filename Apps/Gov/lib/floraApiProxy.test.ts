import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxyFloraApiRequest } from "./floraApiProxy";

test("auth proxy keeps refresh credentials out of browser-readable storage", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUpstream = process.env.FLORA_API_UPSTREAM;
  process.env.FLORA_API_UPSTREAM = "https://flora-api.internal";

  try {
    await t.test("replaces login refreshToken with the http-only marker", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          accessToken: "access-token",
          refreshToken: "session-id.secret",
          expiresAt: "2030-01-01T00:00:00Z",
        })) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("http://localhost:3001/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "alice", password: "correct horse battery staple" }),
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3001",
          },
        }),
      );

      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(payload.refreshToken, "http-only");
      assert.doesNotMatch(JSON.stringify(payload), /session-id\.secret/);
    });

    await t.test("sets flora_refresh as HttpOnly without Secure outside production", async () => {
      assert.notEqual(process.env.NODE_ENV, "production");

      globalThis.fetch = (async () =>
        Response.json({
          accessToken: "access-token",
          refreshToken: "session-id.secret",
          expiresAt: "2030-01-01T00:00:00Z",
        })) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("http://localhost:3001/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "alice", password: "correct horse battery staple" }),
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3001",
          },
        }),
      );

      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /flora_refresh=session-id\.secret/);
      assert.doesNotMatch(setCookie, /__Host-flora_refresh=/);
      assert.match(setCookie, /HttpOnly/);
      assert.doesNotMatch(setCookie, /(?:^|;\s*)Secure(?:;|$)/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });

    await t.test("does not forward the Cookie request header upstream", async () => {
      let upstreamCookie: string | null = "unset";
      globalThis.fetch = (async (_input, init) => {
        upstreamCookie = new Headers(init?.headers).get("cookie");
        return Response.json({
          accessToken: "access-token",
          refreshToken: "session-id.secret",
          expiresAt: "2030-01-01T00:00:00Z",
        });
      }) as typeof fetch;

      const response = await proxyFloraApiRequest(
        new NextRequest("http://localhost:3001/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ login: "alice", password: "secret" }),
          headers: {
            "content-type": "application/json",
            cookie: "flora_refresh=should-not-forward",
            origin: "http://localhost:3001",
          },
        }),
      );

      assert.equal(response.status, 200);
      assert.equal(upstreamCookie, null);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUpstream === undefined) delete process.env.FLORA_API_UPSTREAM;
    else process.env.FLORA_API_UPSTREAM = originalUpstream;
  }
});
