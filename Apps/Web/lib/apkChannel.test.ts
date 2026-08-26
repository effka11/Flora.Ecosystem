import assert from "node:assert/strict";
import test from "node:test";
import {
  floraChannelApkFileName,
  parseFloraApkChannelCatalog,
  trustedFloraSocialApkVersion,
} from "./apkChannel";

test("trusts canonical flora-v{version}.apk and legacy flora.social names", () => {
  assert.equal(
    trustedFloraSocialApkVersion("https://social.flora-s.net/apk/flora-v0.13.0-alpha.apk"),
    "0.13.0-alpha",
  );
  assert.equal(
    trustedFloraSocialApkVersion(
      "https://social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk",
    ),
    "0.10.0-alpha",
  );
  assert.equal(
    trustedFloraSocialApkVersion(
      "https://social.flora-s.net/apk/flora.social-v0.11.1-test-android-ac39a7bb.apk",
    ),
    "0.11.1-test",
  );
  assert.equal(floraChannelApkFileName("0.13.0-alpha"), "flora-v0.13.0-alpha.apk");
});

test("rejects unofficial APK URLs", () => {
  for (const url of [
    "https://social.flora-s.net/apk/flora.mobile-v0.13.0-alpha.apk",
    "https://evil.example/apk/flora-v0.13.0-alpha.apk",
    "https://social.flora-s.net/apk/flora-v0.13.0-alpha.apk?x=1",
  ]) {
    assert.equal(trustedFloraSocialApkVersion(url), null, url);
  }
});

test("parseFloraApkChannelCatalog keeps trusted new and legacy entries", () => {
  const catalog = parseFloraApkChannelCatalog({
    releases: [
      {
        version: "0.13.0-alpha",
        versionCode: 900008,
        apkUrl: "https://social.flora-s.net/apk/flora-v0.13.0-alpha.apk",
        sha256: "a".repeat(64),
        sizeBytes: 10,
      },
      {
        version: "0.12.0-alpha",
        versionCode: 900007,
        apkUrl: "https://social.flora-s.net/apk/flora.social-v0.12.0-alpha-android-deadbeef.apk",
        sha256: "b".repeat(64),
        sizeBytes: 11,
      },
      {
        version: "evil",
        versionCode: 1,
        apkUrl: "https://evil.example/apk/flora-v0.13.0-alpha.apk",
        sha256: "c".repeat(64),
        sizeBytes: 12,
      },
    ],
  });
  assert.ok(catalog);
  assert.deepEqual(
    catalog.releases.map((r) => r.version),
    ["0.13.0-alpha", "0.12.0-alpha"],
  );
});
