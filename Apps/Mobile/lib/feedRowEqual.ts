type FeedRowComparable = {
  post: object;
  engagement: {
    liked: boolean;
    reposted: boolean;
    likesCount: number;
    repostsCount: number;
  };
  commentCount: number;
  commentsOpen: boolean;
  likePending: boolean;
  repostPending: boolean;
  onToggleLike: unknown;
  onToggleRepost: unknown;
  onToggleComments: unknown;
  onCommentAdded: unknown;
  onDeletePost: unknown;
  onEditPost: unknown;
};

export function feedRowEqual(prev: FeedRowComparable, next: FeedRowComparable): boolean {
  return (
    prev.post === next.post &&
    prev.commentCount === next.commentCount &&
    prev.commentsOpen === next.commentsOpen &&
    prev.likePending === next.likePending &&
    prev.repostPending === next.repostPending &&
    prev.engagement.liked === next.engagement.liked &&
    prev.engagement.reposted === next.engagement.reposted &&
    prev.engagement.likesCount === next.engagement.likesCount &&
    prev.engagement.repostsCount === next.engagement.repostsCount &&
    prev.onToggleLike === next.onToggleLike &&
    prev.onToggleRepost === next.onToggleRepost &&
    prev.onToggleComments === next.onToggleComments &&
    prev.onCommentAdded === next.onCommentAdded &&
    prev.onDeletePost === next.onDeletePost &&
    prev.onEditPost === next.onEditPost
  );
}
