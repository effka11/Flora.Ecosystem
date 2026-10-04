import type { FeedPostDto } from "./feed.js";
import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type CommunityRole = "Owner" | "Member";

export type CommunityListItemDto = {
  communityId: string;
  name: string;
  slug: string;
  memberCount: number;
  avatarUuid: string | null;
  isPrivate?: boolean;
  role?: CommunityRole | null;
};

export type ProfileCommunityDto = {
  name: string;
  slug: string;
};

export type CommunitySearchDto = CommunityListItemDto;

/** Профиль сообщества по slug — те же поля, что в списках. */
export type CommunityProfileDto = CommunityListItemDto;

export type CommunityPostDto = {
  postUuid: string;
  content: string;
  createdAt: string;
  authorUserUuid: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid: string | null;
  commentsCount: number;
  likesCount: number;
  repostsCount: number;
  viewsCount: number;
  liked: boolean;
  reposted: boolean;
  imageUuids: string[];
  videoUuid: string | null;
  videoStatus: string | null;
};

function parseCommunityRole(raw: unknown): CommunityRole | null {
  if (raw === "Owner" || raw === "owner") return "Owner";
  if (raw === "Member" || raw === "member") return "Member";
  return null;
}

export function parseCommunityListItem(raw: unknown, ctx?: ParseContext): CommunityListItemDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const communityId = readStr(o, ["communityId", "CommunityId", "community_id"], fb);
  const slug = readStr(o, ["slug", "Slug"], fb);
  if (!communityId || !slug) return null;
  const name = readStr(o, ["name", "Name"], fb) || slug;
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"], fb) || null;
  const roleRaw = readStr(o, ["role", "Role"], fb);
  const isPrivate = readBool(o, ["isPrivate", "IsPrivate"], fb);
  return {
    communityId,
    name,
    slug,
    memberCount: readNum(o, ["memberCount", "MemberCount"], fb) ?? 0,
    avatarUuid,
    ...(typeof isPrivate === "boolean" ? { isPrivate } : {}),
    ...(roleRaw ? { role: parseCommunityRole(roleRaw) } : {}),
  };
}

export function parseCommunityList(raw: unknown, ctx?: ParseContext): CommunityListItemDto[] {
  const itemsRaw = Array.isArray(raw)
    ? raw
    : asRecord(raw)?.items ?? asRecord(raw)?.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: CommunityListItemDto[] = [];
  for (const item of itemsRaw) {
    const parsed = parseCommunityListItem(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseProfileCommunity(raw: unknown, ctx?: ParseContext): ProfileCommunityDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const slug = readStr(o, ["slug", "Slug"], fb);
  if (!slug) return null;
  return {
    slug,
    name: readStr(o, ["name", "Name"], fb) || slug,
  };
}

export function parseProfileCommunitiesList(raw: unknown, ctx?: ParseContext): ProfileCommunityDto[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileCommunityDto[] = [];
  for (const item of raw) {
    const parsed = parseProfileCommunity(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseCommunityProfile(raw: unknown, ctx?: ParseContext): CommunityProfileDto | null {
  return parseCommunityListItem(raw, ctx);
}

function parseImageUuidsField(o: Record<string, unknown>): string[] {
  const raw = o.imageUuids ?? o.ImageUuids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id) out.push(id);
    }
  }
  return out;
}

function parseCommunityPostVideo(
  raw: unknown,
  ctx?: ParseContext,
): { videoUuid: string; videoStatus: string | null } | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const videoUuid = readStr(o, ["videoUuid", "VideoUuid"], fb);
  if (!videoUuid) return null;
  const status = readStr(o, ["status", "Status"], fb) || "ready";
  return { videoUuid, videoStatus: status };
}

export function parseCommunityPost(raw: unknown, ctx?: ParseContext): CommunityPostDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const postUuid = readStr(o, ["postUuid", "PostUuid"], fb);
  if (!postUuid) return null;
  const video = parseCommunityPostVideo(o.video ?? o.Video, ctx);
  return {
    postUuid,
    content: readStr(o, ["content", "Content", "text", "Text"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    authorUserUuid: readStr(o, ["authorUserUuid", "AuthorUserUuid"], fb),
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"], fb),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"], fb),
    authorAvatarUuid: readStr(o, ["authorAvatarUuid", "AuthorAvatarUuid"], fb) || null,
    commentsCount: readNum(o, ["commentsCount", "CommentsCount", "commentCount", "CommentCount"], fb) ?? 0,
    likesCount: readNum(o, ["likesCount", "LikesCount", "likeCount", "LikeCount"], fb) ?? 0,
    repostsCount: readNum(o, ["repostsCount", "RepostsCount", "repostCount", "RepostCount"], fb) ?? 0,
    viewsCount: readNum(o, ["viewsCount", "ViewsCount", "viewCount", "ViewCount"], fb) ?? 0,
    liked: readBool(o, ["liked", "Liked", "likedByMe", "LikedByMe"], fb),
    reposted: readBool(o, ["reposted", "Reposted", "repostedByMe", "RepostedByMe"], fb),
    imageUuids: parseImageUuidsField(o),
    videoUuid: video?.videoUuid ?? (readStr(o, ["videoUuid", "VideoUuid"], fb) || null),
    videoStatus: video?.videoStatus ?? (readStr(o, ["videoStatus", "VideoStatus"], fb) || null),
  };
}

export function parseCommunityPostsList(raw: unknown, ctx?: ParseContext): CommunityPostDto[] {
  if (!Array.isArray(raw)) return [];
  const out: CommunityPostDto[] = [];
  for (const item of raw) {
    const parsed = parseCommunityPost(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function communityPostToFeedPost(
  post: CommunityPostDto,
  community: Pick<CommunityProfileDto, "communityId" | "name" | "slug" | "avatarUuid">,
): FeedPostDto {
  return {
    postUuid: post.postUuid,
    authorUserUuid: post.authorUserUuid,
    authorUsername: post.authorUsername,
    authorDisplayName: post.authorDisplayName,
    authorAvatarUuid: post.authorAvatarUuid,
    communityUuid: community.communityId,
    communityName: community.name,
    communitySlug: community.slug,
    communityAvatarUuid: community.avatarUuid,
    text: post.content,
    createdAt: post.createdAt,
    likeCount: post.likesCount,
    commentCount: post.commentsCount,
    repostCount: post.repostsCount,
    viewCount: post.viewsCount,
    likedByMe: post.liked,
    repostedByMe: post.reposted,
    imageUuids: post.imageUuids,
    videoUuid: post.videoUuid,
    videoStatus: post.videoStatus,
  };
}

export function parseCommunityAvatarUploadResponse(raw: unknown, ctx?: ParseContext): string | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  return readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"], fb) || null;
}
