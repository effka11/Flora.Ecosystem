import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type FeedPostDto = {
  postUuid: string;
  authorUserUuid: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid: string | null;
  communityUuid: string | null;
  communityName: string | null;
  text: string;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  repostCount: number;
  viewCount: number;
  likedByMe: boolean;
  repostedByMe: boolean;
  imageUuids: string[];
  videoUuid: string | null;
  videoStatus: string | null;
};

export type FeedPage = {
  items: FeedPostDto[];
  nextCursor: string | null;
  hasMore: boolean;
  generatedAt: string | null;
  expiresAt: string | null;
};

function parsePost(raw: unknown, ctx?: ParseContext): FeedPostDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const postUuid = readStr(o, ["postUuid", "PostUuid"], fb);
  if (!postUuid) return null;
  const imageUuidsRaw = o.imageUuids ?? o.ImageUuids;
  const imageUuids = Array.isArray(imageUuidsRaw)
    ? imageUuidsRaw.filter((x): x is string => typeof x === "string")
    : [];
  return {
    postUuid,
    authorUserUuid: readStr(o, ["authorUserUuid", "AuthorUserUuid"], fb),
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"], fb),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"], fb),
    authorAvatarUuid: readStr(o, ["authorAvatarUuid", "AuthorAvatarUuid"], fb) || null,
    communityUuid: readStr(o, ["communityUuid", "CommunityUuid"], fb) || null,
    communityName: readStr(o, ["communityName", "CommunityName"], fb) || null,
    text: readStr(o, ["content", "Content", "text", "Text"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    likeCount:
      readNum(o, ["likesCount", "LikesCount", "likeCount", "LikeCount"], fb) ?? 0,
    commentCount:
      readNum(o, ["commentsCount", "CommentsCount", "commentCount", "CommentCount"], fb) ?? 0,
    repostCount:
      readNum(o, ["repostsCount", "RepostsCount", "repostCount", "RepostCount"], fb) ?? 0,
    viewCount: readNum(o, ["viewsCount", "ViewsCount", "viewCount", "ViewCount"], fb) ?? 0,
    likedByMe: readBool(o, ["liked", "Liked", "likedByMe", "LikedByMe"], fb),
    repostedByMe: readBool(o, ["reposted", "Reposted", "repostedByMe", "RepostedByMe"], fb),
    imageUuids,
    videoUuid: readStr(o, ["videoUuid", "VideoUuid"], fb) || null,
    videoStatus: readStr(o, ["videoStatus", "VideoStatus"], fb) || null,
  };
}

export function parseFeedPage(raw: unknown, ctx?: ParseContext): FeedPage {
  const empty: FeedPage = {
    items: [],
    nextCursor: null,
    hasMore: false,
    generatedAt: null,
    expiresAt: null,
  };
  const o = asRecord(raw);
  if (!o) return empty;
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw.map((x) => parsePost(x, ctx)).filter((x): x is FeedPostDto => x !== null)
    : [];
  const nextCursor = readStr(o, ["nextCursor", "NextCursor"], fb) || null;
  const hasMore = readBool(o, ["hasMore", "HasMore"], fb);
  const generatedAt = readStr(o, ["generatedAt", "GeneratedAt"], fb) || null;
  const expiresAt = readStr(o, ["expiresAt", "ExpiresAt"], fb) || null;
  return { items, nextCursor, hasMore, generatedAt, expiresAt };
}

export function parseHasNewFeed(raw: unknown, ctx?: ParseContext): boolean {
  const o = asRecord(raw);
  if (!o) return false;
  const fb = ctx?.onPascalFallback;
  return readBool(o, ["hasNew", "HasNew"], fb);
}
