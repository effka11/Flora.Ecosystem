import type { FeedPage, FeedPostDto } from "@flora/client-core/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { patchPostInSocialCaches } from "./patchPostInSocialCaches";

function feedPost(postUuid: string, text = "hello"): FeedPostDto {
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
    text,
    createdAt: "2026-09-02T00:00:00.000Z",
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    viewCount: 0,
    likedByMe: false,
    repostedByMe: false,
    imageUuids: ["img-old"],
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

const patch = {
  text: "edited",
  imageUuids: ["img-new"],
  videoUuid: null,
  videoStatus: null,
};

describe("patchPostInSocialCaches", () => {
  it("updates the post in infinite feed, search, profile and community caches", () => {
    const client = new QueryClient();
    const keep = feedPost("keep");
    const target = feedPost("target");
    client.setQueryData(["feed", "recommendations"], {
      pages: [feedPage([target, keep])],
      pageParams: [undefined],
    });
    client.setQueryData(["feed", "search", "hello"], [target, keep]);
    client.setQueryData(["profile-posts", "alice"], [
      { postUuid: "target", content: "hello" },
      { postUuid: "keep", content: "stay" },
    ]);
    client.setQueryData(["community-posts", "cid"], [
      { postUuid: "target", content: "hello", imageUuids: ["img-old"] },
    ]);

    patchPostInSocialCaches(client, "target", patch);

    const feed = client.getQueryData(["feed", "recommendations"]) as {
      pages: FeedPage[];
    };
    expect(feed.pages[0]?.items[0]?.text).toBe("edited");
    expect(feed.pages[0]?.items[0]?.imageUuids).toEqual(["img-new"]);
    expect(feed.pages[0]?.items[1]?.text).toBe("hello");
    expect(client.getQueryData(["feed", "search", "hello"])).toEqual([
      { ...target, text: "edited", imageUuids: ["img-new"] },
      keep,
    ]);
    expect(client.getQueryData(["profile-posts", "alice"])).toEqual([
      { postUuid: "target", content: "edited" },
      { postUuid: "keep", content: "stay" },
    ]);
    expect(client.getQueryData(["community-posts", "cid"])).toEqual([
      { postUuid: "target", content: "edited", imageUuids: ["img-new"] },
    ]);
  });

  it("ignores blank ids", () => {
    const client = new QueryClient();
    client.setQueryData(["profile-posts", "alice"], [{ postUuid: "keep", content: "stay" }]);
    patchPostInSocialCaches(client, "  ", patch);
    expect(client.getQueryData(["profile-posts", "alice"])).toEqual([
      { postUuid: "keep", content: "stay" },
    ]);
  });
});
