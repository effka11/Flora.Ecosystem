import { describe, expect, it } from "vitest";
import { isOfficialChannelRelease } from "@/lib/apkUpdate/channelOfficiality";

const catalog = [
  { version: "0.10.0-alpha", versionCode: 100 },
  { version: "0.9.0", versionCode: 90 },
] as const;

describe("isOfficialChannelRelease", () => {
  it("matches version and versionCode against catalog", () => {
    expect(isOfficialChannelRelease("0.9.0", 90, catalog)).toBe(true);
    expect(isOfficialChannelRelease("0.10.0-alpha", 100, catalog)).toBe(true);
  });

  it("rejects version/code mismatch", () => {
    expect(isOfficialChannelRelease("0.9.0", 100, catalog)).toBe(false);
    expect(isOfficialChannelRelease("0.10.0-alpha", 90, catalog)).toBe(false);
    expect(isOfficialChannelRelease("0.8.0", 80, catalog)).toBe(false);
  });

  it("rejects empty catalog or invalid installed identity", () => {
    expect(isOfficialChannelRelease("0.9.0", 90, [])).toBe(false);
    expect(isOfficialChannelRelease("", 90, catalog)).toBe(false);
    expect(isOfficialChannelRelease("0.9.0", 0, catalog)).toBe(false);
    expect(isOfficialChannelRelease("0.9.0", -1, catalog)).toBe(false);
  });
});
