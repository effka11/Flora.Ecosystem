import { describe, expect, it } from "vitest";
import {
  isSafeReleaseVersion,
  isTrustedFloraSocialApkUrl,
  normalizeTrustedSha256,
  trustedFloraSocialApkVersion,
} from "@/lib/apkUpdate/manifestSecurity";

describe("APK update manifest security", () => {
  it("accepts the official Flora Social APK channel asset", () => {
    expect(
      isTrustedFloraSocialApkUrl(
        "https://social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk",
      ),
    ).toBe(true);
    expect(
      trustedFloraSocialApkVersion(
        "https://social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk",
      ),
    ).toBe("0.10.0-alpha");

    for (const url of [
      "http://social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk",
      "https://evil.example/apk/flora.social-v0.10.0-alpha-android.apk",
      "https://social.flora-s.net/other/flora.social-v0.10.0-alpha-android.apk",
      "https://social.flora-s.net/apk/other.apk",
      "https://social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk?redirect=evil",
      "https://user@social.flora-s.net/apk/flora.social-v0.10.0-alpha-android.apk",
    ]) {
      expect(isTrustedFloraSocialApkUrl(url), url).toBe(false);
    }
  });

  it("rejects GitHub release URLs (channel-only trust)", () => {
    expect(
      isTrustedFloraSocialApkUrl(
        "https://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
      ),
    ).toBe(false);
  });

  it("requires a complete SHA-256 digest", () => {
    const digest = "A".repeat(64);
    expect(normalizeTrustedSha256(digest)).toBe("a".repeat(64));
    expect(normalizeTrustedSha256("")).toBeNull();
    expect(normalizeTrustedSha256("a".repeat(63))).toBeNull();
  });

  it("accepts CDN cache-bust hash suffix on APK filename", () => {
    expect(
      trustedFloraSocialApkVersion(
        "https://social.flora-s.net/apk/flora.social-v0.11.1-test-android-ac39a7bb.apk",
      ),
    ).toBe("0.11.1-test");
    expect(
      isTrustedFloraSocialApkUrl(
        "https://social.flora-s.net/apk/flora.social-v0.11.1-test-android-ac39a7bb.apk",
      ),
    ).toBe(true);
  });
});
