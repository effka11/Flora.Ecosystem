import { describe, expect, it } from "vitest";
import { handlesEqual, isOwnFeedPost } from "./isOwnFeedPost";

const post = {
  authorUserUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  authorUsername: "alice",
};

describe("handlesEqual", () => {
  it("ignores @ prefix, case and surrounding space", () => {
    expect(handlesEqual(" @Alice ", "alice")).toBe(true);
    expect(handlesEqual("bob", "alice")).toBe(false);
  });
});

describe("isOwnFeedPost", () => {
  it("matches the signed-in user by uuid even when the handle differs", () => {
    expect(
      isOwnFeedPost(post, {
        userUuid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        username: "alice-renamed",
      }),
    ).toBe(true);
  });

  it("falls back to handle when uuid is missing on either side", () => {
    expect(isOwnFeedPost({ ...post, authorUserUuid: "" }, { username: "Alice" })).toBe(true);
    expect(isOwnFeedPost(post, { userUuid: "", username: "@alice" })).toBe(true);
  });

  it("does not treat empty identities as the author", () => {
    expect(isOwnFeedPost({ authorUserUuid: "", authorUsername: "" }, { username: "" })).toBe(
      false,
    );
    expect(isOwnFeedPost(post, null)).toBe(false);
  });
});
