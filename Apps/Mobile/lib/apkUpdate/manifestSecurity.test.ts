import { describe, expect, it } from "vitest";
import {
  isSafeReleaseVersion,
  isTrustedFloraSocialApkUrl,
  normalizeTrustedSha256,
  trustedFloraSocialApkVersion,
} from "@/lib/apkUpdate/manifestSecurity";

describe("APK update manifest security", () => {
  it("accepts only the canonical Flora Social release asset", () => {
    expect(
      isTrustedFloraSocialApkUrl(
        "https://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
      ),
    ).toBe(true);
    expect(
      trustedFloraSocialApkVersion(
        "https://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
      ),
    ).toBe("0.7.0");

    for (const url of [
      "http://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
      "https://evil.example/flora.social-v0.7.0-android.apk",
      "https://github.com/other/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
      "https://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/other.apk",
      "https://github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk?redirect=evil",
      "https://effka11@github.com/effka11/Flora.Ecosystem/releases/download/social/v0.7.0/flora.social-v0.7.0-android.apk",
    ]) {
      expect(isTrustedFloraSocialApkUrl(url), url).toBe(false);
    }
  });

  it("requires a complete SHA-256 digest", () => {
    const digest = "A".repeat(64);
    expect(normalizeTrustedSha256(digest)).toBe("a".repeat(64));
    expect(normalizeTrustedSha256("")).toBeNull();
    expect(normalizeTrustedSha256("a".repeat(63))).toBeNull();
  });

  it("rejects path-changing release versions", () => {
    expect(isSafeReleaseVersion("0.7.0-alpha.1")).toBe(true);
    expect(isSafeReleaseVersion("../latest")).toBe(false);
    expect(isSafeReleaseVersion("0.7.0/other")).toBe(false);
    expect(isSafeReleaseVersion("")).toBe(false);
  });
});
