import { describe, expect, it } from "vitest";
import { resolveOwnProfileAvatarUuid } from "./ownProfileAvatar";

describe("resolveOwnProfileAvatarUuid", () => {
  it("prefers a non-empty /me avatar over the public profile", () => {
    expect(
      resolveOwnProfileAvatarUuid(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ),
    ).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("falls back to the public profile when /me omitted the uuid", () => {
    expect(
      resolveOwnProfileAvatarUuid(undefined, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    ).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(resolveOwnProfileAvatarUuid("  ", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")).toBe(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(resolveOwnProfileAvatarUuid(null, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")).toBe(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });

  it("returns null when neither source has an avatar", () => {
    expect(resolveOwnProfileAvatarUuid(undefined, undefined)).toBeNull();
    expect(resolveOwnProfileAvatarUuid("", "  ")).toBeNull();
    expect(resolveOwnProfileAvatarUuid(null, null)).toBeNull();
  });
});
