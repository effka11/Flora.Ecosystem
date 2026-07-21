import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type FeedPostDto = {
  postUuid: string;
  authorUserUuid: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid: string | null;
  communityUuid: string | null;
  communityName: string | null;
  communitySlug: string | null;
  communityAvatarUuid: string | null;
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
    communityUuid:
      readStr(o, ["communityUuid", "CommunityUuid", "communityId", "CommunityId"], fb) || null,
    communityName: readStr(o, ["communityName", "CommunityName"], fb) || null,
    communitySlug: readStr(o, ["communitySlug", "CommunitySlug"], fb) || null,
    communityAvatarUuid: readStr(o, ["communityAvatarUuid", "CommunityAvatarUuid"], fb) || null,
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

// ---------------------------------------------------------------------------
// §User Controls (FIRA-F v1.1): настройки ленты + негативный фидбек
// ---------------------------------------------------------------------------

export type FeedFreshness = "fresh" | "balanced" | "popular";
export type FeedExploration = "off" | "low" | "standard" | "high";
export type FeedSeenPostsMode = "show" | "demote" | "hide";
export type FeedAuthorDiversity = "strict" | "standard" | "off";

export type FeedSettingsDto = {
  freshness: FeedFreshness;
  exploration: FeedExploration;
  showReposts: boolean;
  communityPosts: boolean;
  seenPosts: FeedSeenPostsMode;
  authorDiversity: FeedAuthorDiversity;
  updatedAt: string | null;
};

export const DEFAULT_FEED_SETTINGS: FeedSettingsDto = {
  freshness: "balanced",
  exploration: "standard",
  showReposts: true,
  communityPosts: true,
  seenPosts: "demote",
  authorDiversity: "standard",
  updatedAt: null,
};

function readEnum<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function parseFeedSettings(raw: unknown, ctx?: ParseContext): FeedSettingsDto {
  const o = asRecord(raw);
  if (!o) return { ...DEFAULT_FEED_SETTINGS };
  const fb = ctx?.onPascalFallback;
  const d = DEFAULT_FEED_SETTINGS;
  return {
    freshness: readEnum(
      readStr(o, ["freshness", "Freshness"], fb),
      ["fresh", "balanced", "popular"],
      d.freshness,
    ),
    exploration: readEnum(
      readStr(o, ["exploration", "Exploration"], fb),
      ["off", "low", "standard", "high"],
      d.exploration,
    ),
    showReposts:
      typeof (o.showReposts ?? o.ShowReposts) === "boolean"
        ? readBool(o, ["showReposts", "ShowReposts"], fb)
        : d.showReposts,
    communityPosts:
      typeof (o.communityPosts ?? o.CommunityPosts) === "boolean"
        ? readBool(o, ["communityPosts", "CommunityPosts"], fb)
        : d.communityPosts,
    seenPosts: readEnum(
      readStr(o, ["seenPosts", "SeenPosts"], fb),
      ["show", "demote", "hide"],
      d.seenPosts,
    ),
    authorDiversity: readEnum(
      readStr(o, ["authorDiversity", "AuthorDiversity"], fb),
      ["strict", "standard", "off"],
      d.authorDiversity,
    ),
    updatedAt: readStr(o, ["updatedAt", "UpdatedAt"], fb) || null,
  };
}

export type HiddenFeedAuthorDto = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUuid: string | null;
  hiddenAt: string | null;
};

export function parseHiddenFeedAuthors(raw: unknown, ctx?: ParseContext): HiddenFeedAuthorDto[] {
  const o = asRecord(raw);
  if (!o) return [];
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: HiddenFeedAuthorDto[] = [];
  for (const item of itemsRaw) {
    const r = asRecord(item);
    if (!r) continue;
    const userUuid = readStr(r, ["userUuid", "UserUuid"], fb);
    if (!userUuid) continue;
    out.push({
      userUuid,
      username: readStr(r, ["username", "Username"], fb),
      displayName: readStr(r, ["displayName", "DisplayName"], fb),
      avatarUuid: readStr(r, ["avatarUuid", "AvatarUuid"], fb) || null,
      hiddenAt: readStr(r, ["hiddenAt", "HiddenAt"], fb) || null,
    });
  }
  return out;
}

export type DismissedCommunityDto = {
  communityId: string;
  name: string;
  slug: string;
  avatarUuid: string | null;
};

export function parseDismissedCommunities(
  raw: unknown,
  ctx?: ParseContext,
): DismissedCommunityDto[] {
  const o = asRecord(raw);
  if (!o) return [];
  const fb = ctx?.onPascalFallback;
  const itemsRaw = o.items ?? o.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: DismissedCommunityDto[] = [];
  for (const item of itemsRaw) {
    const r = asRecord(item);
    if (!r) continue;
    const communityId = readStr(r, ["communityId", "CommunityId"], fb);
    if (!communityId) continue;
    out.push({
      communityId,
      name: readStr(r, ["name", "Name"], fb),
      slug: readStr(r, ["slug", "Slug"], fb),
      avatarUuid: readStr(r, ["avatarUuid", "AvatarUuid"], fb) || null,
    });
  }
  return out;
}
