import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLORA_GOV_CDN_ORIGIN,
  FLORA_ORIGIN_DIRECT,
  FLORA_SOCIAL_CDN_ORIGIN,
  resolveGovOrigin,
  resolveOriginDirect,
  stripFloraOriginSlash,
} from "./floraPublicOrigins";

describe("floraPublicOrigins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips trailing slashes", () => {
    expect(stripFloraOriginSlash("https://gov.flora-s.net/")).toBe(FLORA_GOV_CDN_ORIGIN);
  });

  it("defaults Gov and origin to Cloudflare / grey hosts", () => {
    expect(resolveGovOrigin()).toBe(FLORA_GOV_CDN_ORIGIN);
    expect(resolveOriginDirect()).toBe(FLORA_ORIGIN_DIRECT);
    expect(FLORA_SOCIAL_CDN_ORIGIN).toBe("https://social.flora-s.net");
  });

  it("honors EXPO_PUBLIC_GOV_URL and EXPO_PUBLIC_ORIGIN_URL", () => {
    vi.stubEnv("EXPO_PUBLIC_GOV_URL", "https://gov.example.test/");
    vi.stubEnv("EXPO_PUBLIC_ORIGIN_URL", "https://origin.example.test/");
    expect(resolveGovOrigin()).toBe("https://gov.example.test");
    expect(resolveOriginDirect()).toBe("https://origin.example.test");
  });
});
