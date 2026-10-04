import { asRecord, readBool, readNum } from "./parse.js";

export type PostEngagementSnapshot = {
  liked: boolean;
  reposted: boolean;
  likesCount: number;
  repostsCount: number;
};

export function parseLikeMutation(raw: unknown): { liked: boolean; likesCount: number } {
  const o = asRecord(raw) ?? {};
  return {
    liked: readBool(o, ["liked", "Liked"]),
    likesCount: readNum(o, ["likesCount", "LikesCount", "likeCount", "LikeCount"]) ?? 0,
  };
}

export function parseRepostMutation(raw: unknown): { reposted: boolean; repostsCount: number } {
  const o = asRecord(raw) ?? {};
  return {
    reposted: readBool(o, ["reposted", "Reposted", "repostedByMe", "RepostedByMe"]),
    repostsCount: readNum(o, ["repostsCount", "RepostsCount", "repostCount", "RepostCount"]) ?? 0,
  };
}

export function parseViewMutation(raw: unknown): { viewsCount: number } {
  const o = asRecord(raw) ?? {};
  return {
    viewsCount: readNum(o, ["viewsCount", "ViewsCount", "viewCount", "ViewCount"]) ?? 0,
  };
}
