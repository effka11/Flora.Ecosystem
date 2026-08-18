import assert from "node:assert/strict";
import test from "node:test";
import { formatFrankingHandle, readUserUuidFromAccessToken } from "./moderationFormat";

function jwtWithSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), "utf8").toString("base64url");
  return `header.${payload}.sig`;
}

test("readUserUuidFromAccessToken reads sub from an unpadded URL-safe JWT", () => {
  const userUuid = "77777777-7777-7777-7777-777777777777";
  assert.equal(readUserUuidFromAccessToken(jwtWithSub(userUuid)), userUuid);
});

test("readUserUuidFromAccessToken falls back to the nameidentifier claim", () => {
  const userUuid = "77777777-7777-7777-7777-777777777777";
  const payload = Buffer.from(
    JSON.stringify({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userUuid,
    }),
    "utf8",
  ).toString("base64url");
  assert.equal(readUserUuidFromAccessToken(`header.${payload}.sig`), userUuid);
});

test("formatFrankingHandle prefixes a public username with @", () => {
  assert.equal(formatFrankingHandle("alice"), "@alice");
  assert.equal(formatFrankingHandle("@bob"), "@bob");
  assert.equal(formatFrankingHandle("  @carol  "), "@carol");
  assert.equal(formatFrankingHandle(null), "неизвестно");
  assert.equal(formatFrankingHandle("   "), "неизвестно");
});
