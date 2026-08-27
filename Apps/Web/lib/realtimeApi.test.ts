import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicApiRoot } from "./auth";
import { resolveRealtimeStreamApiRoot } from "./realtimeApi";

test("SSE root matches the public API root when no override is set", () => {
  delete process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL;
  assert.equal(resolveRealtimeStreamApiRoot(), resolvePublicApiRoot());
});

test("SSE root honors an explicit override and strips a trailing slash", () => {
  process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL = "https://social.flora-s.net/";
  try {
    assert.equal(resolveRealtimeStreamApiRoot(), "https://social.flora-s.net");
  } finally {
    delete process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL;
  }
});

test("SSE root does not invent a grey origin.* host", () => {
  delete process.env.NEXT_PUBLIC_REALTIME_API_BASE_URL;
  assert.equal(resolveRealtimeStreamApiRoot().includes("origin."), false);
});
