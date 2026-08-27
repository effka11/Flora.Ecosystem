import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLORA_GOV_CDN_ORIGIN,
  FLORA_SOCIAL_CDN_ORIGIN,
  resolveGovOrigin,
  stripFloraOriginSlash,
} from "./floraPublicOrigins";

describe("floraPublicOrigins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips trailing slashes", () => {
    expect(stripFloraOriginSlash("https://gov.flora-s.net/")).toBe(FLORA_GOV_CDN_ORIGIN);
  });

  it("defaults Gov to the Cloudflare civic host", () => {
    expect(resolveGovOrigin()).toBe(FLORA_GOV_CDN_ORIGIN);
    expect(FLORA_SOCIAL_CDN_ORIGIN).toBe("https://social.flora-s.net");
  });

  it("honors EXPO_PUBLIC_GOV_URL", () => {
    vi.stubEnv("EXPO_PUBLIC_GOV_URL", "https://gov.example.test/");
    expect(resolveGovOrigin()).toBe("https://gov.example.test");
  });
});
