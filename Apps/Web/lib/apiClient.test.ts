import assert from "node:assert/strict";
import test from "node:test";
import { isAuthRefreshRequest } from "./apiClient";

test("refresh timeout matching parses pathname for every fetch input shape", () => {
  assert.equal(isAuthRefreshRequest("/api/auth/refresh?attempt=2"), true);
  assert.equal(
    isAuthRefreshRequest("https://api.flora.test/v1/api/auth/refresh?attempt=2"),
    true,
  );
  assert.equal(
    isAuthRefreshRequest(
      new URL("https://api.flora.test/api/auth/refresh?attempt=2"),
    ),
    true,
  );
  assert.equal(
    isAuthRefreshRequest(
      new Request("https://api.flora.test/api/auth/refresh?attempt=2"),
    ),
    true,
  );
  assert.equal(isAuthRefreshRequest("/api/auth/refresh-status?attempt=2"), false);
});
