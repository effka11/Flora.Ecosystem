import { describe, expect, it } from "vitest";
import { feedRowEqual } from "./feedRowEqual";

function row(post: object) {
  const handler = () => {};
  return {
    post,
    engagement: {
      liked: false,
      reposted: false,
      likesCount: 2,
      repostsCount: 3,
    },
    commentCount: 4,
    commentsOpen: false,
    likePending: false,
    repostPending: false,
    onToggleLike: handler,
    onToggleRepost: handler,
    onToggleComments: handler,
    onCommentAdded: handler,
    onDeletePost: handler,
    onEditPost: handler,
  };
}

describe("feedRowEqual", () => {
  it("keeps an unchanged neighboring row memoized", () => {
    const previous = row({ postUuid: "neighbor" });
    const next = { ...previous, engagement: { ...previous.engagement } };
    expect(feedRowEqual(previous, next)).toBe(true);
  });

  it("rerenders only when own primitive state changes", () => {
    const previous = row({ postUuid: "changed" });
    expect(feedRowEqual(previous, {
      ...previous,
      engagement: { ...previous.engagement, liked: true },
    })).toBe(false);
    expect(feedRowEqual(previous, { ...previous, commentsOpen: true })).toBe(false);
    expect(feedRowEqual(previous, { ...previous, onDeletePost: () => {} })).toBe(false);
    expect(feedRowEqual(previous, { ...previous, onEditPost: () => {} })).toBe(false);
  });
});
