import type { FeedPostDto } from "./feed.js";
import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type ProfilePostDto = {
  postUuid: string;
  content: string;
  createdAt: string;
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

export type ProfilePostAuthor = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUuid?: string | null;
};

export type PublicProfileDto = {
  userUuid: string;
  username: string;
  displayName: string;
  status: string;
  avatarUuid: string | null;
  followersCount: number;
  followingCount: number;
  isFollowingByMe: boolean;
  canMessageByMe: boolean;
};

export function parsePublicProfile(raw: unknown, ctx?: ParseContext): PublicProfileDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const userUuid = readStr(o, ["userUuid", "UserUuid"], fb);
  const username = readStr(o, ["username", "Username"], fb).replace(/^@+/, "");
  if (!userUuid || !username) return null;
  return {
    userUuid,
    username,
    displayName: readStr(o, ["displayName", "DisplayName"], fb) || username,
    status: readStr(o, ["status", "Status"], fb),
    avatarUuid: readStr(o, ["avatarUuid", "AvatarUuid"], fb) || null,
    followersCount: readNum(o, ["followersCount", "FollowersCount"], fb) ?? 0,
    followingCount: readNum(o, ["followingCount", "FollowingCount"], fb) ?? 0,
    isFollowingByMe: readBool(o, ["isFollowingByMe", "IsFollowingByMe"], fb),
    canMessageByMe: readBool(o, ["canMessageByMe", "CanMessageByMe"], fb),
  };
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

function parseProfilePostVideo(
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

export function parseProfilePost(raw: unknown, ctx?: ParseContext): ProfilePostDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const postUuid = readStr(o, ["postUuid", "PostUuid"], fb);
  if (!postUuid) return null;
  const video = parseProfilePostVideo(o.video ?? o.Video, ctx);
  return {
    postUuid,
    content: readStr(o, ["content", "Content", "text", "Text"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
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

export function parseProfilePostsList(raw: unknown, ctx?: ParseContext): ProfilePostDto[] {
  const list = Array.isArray(raw) ? raw : null;
  if (list) {
    const out: ProfilePostDto[] = [];
    for (const item of list) {
      const parsed = parseProfilePost(item, ctx);
      if (parsed) out.push(parsed);
    }
    return out;
  }
  const o = asRecord(raw);
  if (!o) return [];
  const itemsRaw = o.items ?? o.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: ProfilePostDto[] = [];
  for (const item of itemsRaw) {
    const parsed = parseProfilePost(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function profilePostToFeedPost(post: ProfilePostDto, author: ProfilePostAuthor): FeedPostDto {
  return {
    postUuid: post.postUuid,
    authorUserUuid: author.userUuid,
    authorUsername: author.username,
    authorDisplayName: author.displayName,
    authorAvatarUuid: author.avatarUuid ?? null,
    communityUuid: null,
    communityName: null,
    communitySlug: null,
    communityAvatarUuid: null,
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
