import type { FeedPage, FeedPostDto } from "@flora/client-core/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { removePostFromSocialCaches } from "./removePostFromSocialCaches";

function feedPost(postUuid: string): FeedPostDto {
  return {
    postUuid,
    authorUserUuid: "u1",
    authorUsername: "alice",
    authorDisplayName: "Alice",
    authorAvatarUuid: null,
    communityUuid: null,
    communityName: null,
    communitySlug: null,
    communityAvatarUuid: null,
    text: "hello",
    createdAt: "2026-09-02T00:00:00.000Z",
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    viewCount: 0,
    likedByMe: false,
    repostedByMe: false,
    imageUuids: [],
    videoUuid: null,
    videoStatus: null,
  };
}

function feedPage(items: FeedPostDto[]): FeedPage {
  return {
    items,
    nextCursor: "c1",
    hasMore: true,
    generatedAt: "t0",
    expiresAt: null,
  };
}

describe("removePostFromSocialCaches", () => {
  it("drops the post from infinite feed, search, profile and community caches", () => {
    const client = new QueryClient();
    const keep = feedPost("keep");
    const gone = feedPost("gone");
    client.setQueryData(["feed", "recommendations"], {
      pages: [feedPage([gone, keep]), feedPage([gone])],
      pageParams: [undefined, "c1"],
    });
    client.setQueryData(["feed", "search", "hello"], [gone, keep]);
    client.setQueryData(["profile-posts", "alice"], [{ postUuid: "gone" }, { postUuid: "keep" }]);
    client.setQueryData(["community-posts", "cid"], [{ postUuid: "gone" }, { postUuid: "keep" }]);

    removePostFromSocialCaches(client, "gone");

    expect(client.getQueryData(["feed", "recommendations"])).toEqual({
      pages: [feedPage([keep]), feedPage([])],
      pageParams: [undefined, "c1"],
    });
    expect(client.getQueryData(["feed", "search", "hello"])).toEqual([keep]);
    expect(client.getQueryData(["profile-posts", "alice"])).toEqual([{ postUuid: "keep" }]);
    expect(client.getQueryData(["community-posts", "cid"])).toEqual([{ postUuid: "keep" }]);
  });

  it("ignores blank ids and unrelated caches", () => {
    const client = new QueryClient();
    client.setQueryData(["feed-has-new", "t0"], true);
    client.setQueryData(["profile-posts", "alice"], [{ postUuid: "keep" }]);
    removePostFromSocialCaches(client, "  ");
    expect(client.getQueryData(["feed-has-new", "t0"])).toBe(true);
    expect(client.getQueryData(["profile-posts", "alice"])).toEqual([{ postUuid: "keep" }]);
  });
});
