import {
  isReservedCommunitySlug,
  RESERVED_COMMUNITY_SLUG_MESSAGE,
} from "@/lib/communityReservedSlugs";
import { floraNewUuid } from "@/lib/floraUuid";
import {
  ApiRequestError,
  clearSession,
  getAccessToken,
  isDevLocalOfflineSession,
  refreshSessionIfPossible,
  resolvePublicApiRoot,
} from "@/lib/auth";
import { clampPostContent } from "@/lib/postContentLimits";
import {
  devDemoFeedPosts,
  devDemoFeedSubscriptions,
  devDemoGetConversations,
  devDemoGetProfilePosts,
  devDemoGetPublicProfile,
  devDemoGetThread,
  devDemoMarkRead,
} from "@/lib/devLocalDemoData";

type ApiError = { error?: string; detail?: string; Detail?: string };

function apiRoot(): string {
  return resolvePublicApiRoot();
}

function apiUrl(path: string): string {
  const root = apiRoot();
  return root ? `${root}${path}` : path;
}

async function parseErr(r: Response): Promise<string> {
  const data = (await r.json().catch(() => ({}))) as ApiError;
  const base = typeof data.error === "string" ? data.error : `Ошибка ${r.status}`;
  const detailRaw = data.detail ?? data.Detail;
  const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : "";
  if (detail.length === 0) return base;
  if (base.includes(detail)) return base;
  return `${base} (${detail})`;
}

async function authGetJson(url: string): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const headers = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { headers: headers(token) });
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: headers(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authPatch(url: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

async function authPutJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "PUT",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authPostJson(url: string, body: Record<string, unknown>, err: string): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authPostForm(url: string, body: FormData): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
    body,
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authGetBlob(url: string): Promise<Blob> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const headers = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { headers: headers(token) });
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: headers(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.blob();
}

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function readNum(o: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function readBool(o: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true" || t === "1") return true;
      if (t === "false" || t === "0") return false;
    }
  }
  return false;
}

export type PostEngagementSnapshot = {
  liked: boolean;
  reposted: boolean;
  likesCount: number;
  repostsCount: number;
};

/** Подписка, репостнувшая пост (FIRA-F repost signal). */
export type FollowedReposterDto = {
  username: string;
  displayName: string;
  avatarUuid?: string | null;
  userUuid?: string | null;
};

export type PostVideoStatus = "processing" | "ready" | "failed";

export type PostVideoDto = {
  videoUuid: string;
  status: PostVideoStatus;
  width: number;
  height: number;
  durationMs: number;
};

export type FeedPostDto = {
  postUuid: string;
  content: string;
  createdAt: string;
  authorUserUuid?: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid?: string | null;
  communityName: string | null;
  communitySlug: string | null;
  communityAvatarUuid?: string | null;
  communityId?: string | null;
  commentsCount: number;
  likesCount: number;
  repostsCount: number;
  viewsCount: number;
  liked: boolean;
  reposted: boolean;
  /** Подписки, репостнувшие этот пост (для индикатора в ленте). */
  followedReposts?: FollowedReposterDto[];
  imageUuids: string[];
  video?: PostVideoDto | null;
};

export type CommunityPostDto = {
  postUuid: string;
  content: string;
  createdAt: string;
  authorUsername: string;
  authorDisplayName: string;
  commentsCount: number;
  likesCount: number;
  repostsCount: number;
  viewsCount: number;
  liked: boolean;
  reposted: boolean;
  imageUuids: string[];
  video?: PostVideoDto | null;
};

export type PostCommentDto = {
  commentUuid: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid?: string | null;
  authorUserUuid?: string | null;
  content: string;
  createdAt: string;
  /** Число прямых ответов на комментарий. */
  repliesCount: number;
  /** Вложенные ответы (дерево с сервера). */
  replies: PostCommentDto[];
};

export type FeedPageDto = {
  items: FeedPostDto[];
  nextCursor: string | null;
  hasMore: boolean;
  /** ISO 8601 UTC — момент вычисления/кэширования набора (FIRA.md §13.3). */
  generatedAt: string | null;
  /** ISO 8601 UTC — generatedAt + TTL; клиент может авторефрешнуть при now > expiresAt. */
  expiresAt: string | null;
};

function parseFollowedReposter(raw: unknown): FollowedReposterDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const username = readStr(o, ["username", "Username"]);
  if (!username) return null;
  return {
    username,
    displayName: readStr(o, ["displayName", "DisplayName"]) || username,
    avatarUuid: readStr(o, ["avatarUuid", "AvatarUuid"]) || null,
    userUuid: readStr(o, ["userUuid", "UserUuid"]) || null,
  };
}

function parseImageUuidsField(o: Record<string, unknown>): string[] {
  const raw = o.imageUuids ?? o.ImageUuids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const id = typeof item === "string" ? item.trim() : "";
    if (id) out.push(id);
  }
  return out;
}

function parsePostVideoField(o: Record<string, unknown>): PostVideoDto | null {
  const raw = o.video ?? o.Video;
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const videoUuid = readStr(v, ["videoUuid", "VideoUuid"]);
  if (!videoUuid) return null;
  const statusRaw = readStr(v, ["status", "Status"]).toLowerCase();
  const status: PostVideoStatus =
    statusRaw === "ready" ? "ready" : statusRaw === "failed" ? "failed" : "processing";
  return {
    videoUuid,
    status,
    width: readNum(v, ["width", "Width"]),
    height: readNum(v, ["height", "Height"]),
    durationMs: readNum(v, ["durationMs", "DurationMs"]),
  };
}

function parseFollowedReposts(raw: unknown): FollowedReposterDto[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FollowedReposterDto[] = [];
  for (const item of raw) {
    const parsed = parseFollowedReposter(item);
    if (parsed) out.push(parsed);
  }
  return out.length > 0 ? out : undefined;
}

function parseFeedItem(raw: unknown): FeedPostDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const postUuid = readStr(o, ["postUuid", "PostUuid"]);
  if (!postUuid) return null;
  const cn = readStr(o, ["communityName", "CommunityName"]);
  const cs = readStr(o, ["communitySlug", "CommunitySlug"]);
  const authorAvatarUuid = readStr(o, ["authorAvatarUuid", "AuthorAvatarUuid"]) || null;
  const communityAvatarUuid = readStr(o, ["communityAvatarUuid", "CommunityAvatarUuid"]) || null;
  const authorUserUuid = readStr(o, ["authorUserUuid", "AuthorUserUuid"]) || undefined;
  const communityId = readStr(o, ["communityId", "CommunityId"]) || null;
  const followedRepostsRaw = o.followedReposts ?? o.FollowedReposts;
  return {
    postUuid,
    content: readStr(o, ["content", "Content"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    ...(authorUserUuid ? { authorUserUuid } : {}),
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"]),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"]),
    authorAvatarUuid,
    communityName: cn.length > 0 ? cn : null,
    communitySlug: cs.length > 0 ? cs : null,
    communityAvatarUuid,
    ...(communityId ? { communityId } : {}),
    commentsCount: readNum(o, ["commentsCount", "CommentsCount"]),
    likesCount: readNum(o, ["likesCount", "LikesCount"]),
    repostsCount: readNum(o, ["repostsCount", "RepostsCount"]),
    viewsCount: readNum(o, ["viewsCount", "ViewsCount"]),
    liked: readBool(o, ["liked", "Liked"]),
    reposted: readBool(o, ["reposted", "Reposted"]),
    followedReposts: parseFollowedReposts(followedRepostsRaw),
    imageUuids: parseImageUuidsField(o),
    video: parsePostVideoField(o),
  };
}

function parseCommunityPost(raw: unknown): CommunityPostDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const postUuid = readStr(o, ["postUuid", "PostUuid"]);
  if (!postUuid) return null;
  return {
    postUuid,
    content: readStr(o, ["content", "Content"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"]),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"]),
    commentsCount: readNum(o, ["commentsCount", "CommentsCount"]),
    likesCount: readNum(o, ["likesCount", "LikesCount"]),
    repostsCount: readNum(o, ["repostsCount", "RepostsCount"]),
    viewsCount: readNum(o, ["viewsCount", "ViewsCount"]),
    liked: readBool(o, ["liked", "Liked"]),
    reposted: readBool(o, ["reposted", "Reposted"]),
    imageUuids: parseImageUuidsField(o),
    video: parsePostVideoField(o),
  };
}

export async function apiGetCommunityPosts(
  communityId: string,
  skip = 0,
  take = 20,
): Promise<CommunityPostDto[]> {
  if (isDevLocalOfflineSession()) {
    return [];
  }
  const id = communityId.trim();
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}/posts?${q}`));
  if (!Array.isArray(raw)) return [];
  const out: CommunityPostDto[] = [];
  for (const item of raw) {
    const post = parseCommunityPost(item);
    if (post) out.push(post);
  }
  return out.filter((post) => !devDeletedPostUuids.has(post.postUuid));
}

export type FeedKind = "recommendations" | "subscriptions";

export type ApiGetFeedOptions = {
  refresh?: boolean;
};

export async function apiGetFeed(
  take = 30,
  cursor?: string | null,
  kind: FeedKind = "recommendations",
  options?: ApiGetFeedOptions,
): Promise<FeedPageDto> {
  if (isDevLocalOfflineSession()) {
    const n = Math.min(Math.max(take, 1), 45);
    const items = (
      kind === "subscriptions"
        ? devDemoFeedSubscriptions(n)
        : devDemoFeedPosts(n, { refresh: options?.refresh === true && !cursor })
    ).filter((post) => !devDeletedPostUuids.has(post.postUuid));
    const now = new Date().toISOString();
    return {
      items,
      nextCursor: null,
      hasMore: false,
      generatedAt: kind === "recommendations" ? now : null,
      expiresAt: kind === "recommendations" ? now : null,
    };
  }
  const q = new URLSearchParams({ take: String(take) });
  if (cursor) q.set("cursor", cursor);
  if (kind === "subscriptions") q.set("kind", "subscriptions");
  if (options?.refresh === true && kind === "recommendations" && !cursor) q.set("refresh", "true");
  const raw = (await authGetJson(apiUrl(`/api/auth/feed?${q}`))) as Record<string, unknown>;
  const itemsRaw = raw.items ?? raw.Items;
  const items: FeedPostDto[] = [];
  if (Array.isArray(itemsRaw)) {
    for (const x of itemsRaw) {
      const p = parseFeedItem(x);
      if (p) items.push(p);
    }
  }
  const nc = readStr(raw, ["nextCursor", "NextCursor"]);
  const hasMore = raw.hasMore === true || raw.HasMore === true;
  const generatedAt = readStr(raw, ["generatedAt", "GeneratedAt"]);
  const expiresAt = readStr(raw, ["expiresAt", "ExpiresAt"]);
  return {
    items,
    nextCursor: nc.length > 0 ? nc : null,
    hasMore,
    generatedAt: generatedAt.length > 0 ? generatedAt : null,
    expiresAt: expiresAt.length > 0 ? expiresAt : null,
  };
}

/**
 * Лёгкая проверка наличия новых постов в рекомендательной ленте.
 * Не инициирует пересчёт — только AnyAsync по новым постам.
 * @param since ISO 8601 UTC — generatedAt из последнего FeedPageDto
 */
export async function apiCheckFeedHasNew(since: string): Promise<boolean> {
  if (isDevLocalOfflineSession()) return false;
  try {
    const q = new URLSearchParams({ since });
    const raw = (await authGetJson(apiUrl(`/api/auth/feed/has-new?${q}`))) as Record<string, unknown>;
    return raw.hasNew === true || raw.HasNew === true;
  } catch {
    return false;
  }
}

const devDeletedPostUuids = new Set<string>();
const devPostEngagement = new Map<string, PostEngagementSnapshot>();
const devPostViewCounts = new Map<string, number>();
const devViewedPostUuids = new Set<string>();

/** Офлайн-демо: зафиксировать текущие счётчики перед первым toggle. */
export function primeDevPostEngagement(postUuid: string, snapshot: PostEngagementSnapshot): void {
  if (!isDevLocalOfflineSession()) return;
  const id = postUuid.trim();
  if (!id || devPostEngagement.has(id)) return;
  devPostEngagement.set(id, snapshot);
}

/** Офлайн-демо: зафиксировать счётчик просмотров перед первой записью. */
export function primeDevPostViewCount(postUuid: string, viewsCount: number): void {
  if (!isDevLocalOfflineSession()) return;
  const id = postUuid.trim();
  if (!id || devPostViewCounts.has(id)) return;
  devPostViewCounts.set(id, Math.max(0, viewsCount));
}

function devEngagementFor(postUuid: string, fallback: PostEngagementSnapshot): PostEngagementSnapshot {
  return devPostEngagement.get(postUuid) ?? fallback;
}

function parseLikeMutation(raw: unknown): { liked: boolean; likesCount: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    liked: readBool(o, ["liked", "Liked"]),
    likesCount: readNum(o, ["likesCount", "LikesCount"]),
  };
}

function parseRepostMutation(raw: unknown): { reposted: boolean; repostsCount: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    reposted: readBool(o, ["reposted", "Reposted"]),
    repostsCount: readNum(o, ["repostsCount", "RepostsCount"]),
  };
}

function parseViewMutation(raw: unknown): { viewsCount: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    viewsCount: readNum(o, ["viewsCount", "ViewsCount"]),
  };
}

async function authDeleteJson(url: string): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

export async function apiLikePost(postUuid: string): Promise<{ liked: boolean; likesCount: number }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    const cur = devEngagementFor(id, { liked: false, reposted: false, likesCount: 0, repostsCount: 0 });
    const next: PostEngagementSnapshot = {
      ...cur,
      liked: true,
      likesCount: cur.liked ? cur.likesCount : cur.likesCount + 1,
    };
    devPostEngagement.set(id, next);
    return { liked: true, likesCount: next.likesCount };
  }
  const raw = await authPostJson(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/like`), {}, "Не удалось поставить лайк");
  return parseLikeMutation(raw);
}

export async function apiUnlikePost(postUuid: string): Promise<{ liked: boolean; likesCount: number }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    const cur = devEngagementFor(id, { liked: false, reposted: false, likesCount: 0, repostsCount: 0 });
    const next = { ...cur, liked: false, likesCount: cur.liked ? Math.max(0, cur.likesCount - 1) : cur.likesCount };
    devPostEngagement.set(id, next);
    return { liked: false, likesCount: next.likesCount };
  }
  const raw = await authDeleteJson(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/like`));
  return parseLikeMutation(raw);
}

export async function apiRepostPost(postUuid: string): Promise<{ reposted: boolean; repostsCount: number }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    const cur = devEngagementFor(id, { liked: false, reposted: false, likesCount: 0, repostsCount: 0 });
    const next = {
      ...cur,
      reposted: true,
      repostsCount: cur.reposted ? cur.repostsCount : cur.repostsCount + 1,
    };
    devPostEngagement.set(id, next);
    return { reposted: true, repostsCount: next.repostsCount };
  }
  const raw = await authPostJson(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/repost`), {}, "Не удалось сделать репост");
  return parseRepostMutation(raw);
}

export async function apiRecordPostView(
  postUuid: string,
  fallbackViewsCount = 0,
): Promise<{ viewsCount: number }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    const base = devPostViewCounts.get(id) ?? Math.max(0, fallbackViewsCount);
    if (!devViewedPostUuids.has(id)) {
      devViewedPostUuids.add(id);
      const next = base + 1;
      devPostViewCounts.set(id, next);
      return { viewsCount: next };
    }
    return { viewsCount: devPostViewCounts.get(id) ?? base };
  }
  const raw = await authPostJson(
    apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/view`),
    {},
    "Не удалось записать просмотр",
  );
  return parseViewMutation(raw);
}

export async function apiUnrepostPost(postUuid: string): Promise<{ reposted: boolean; repostsCount: number }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    const cur = devEngagementFor(id, { liked: false, reposted: false, likesCount: 0, repostsCount: 0 });
    const next = {
      ...cur,
      reposted: false,
      repostsCount: cur.reposted ? Math.max(0, cur.repostsCount - 1) : cur.repostsCount,
    };
    devPostEngagement.set(id, next);
    return { reposted: false, repostsCount: next.repostsCount };
  }
  const raw = await authDeleteJson(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/repost`));
  return parseRepostMutation(raw);
}

export async function apiDeletePost(postUuid: string): Promise<void> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  if (isDevLocalOfflineSession()) {
    devDeletedPostUuids.add(id);
    return;
  }
  await authDelete(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}`));
}

function parsePostComment(raw: unknown): PostCommentDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const commentUuid = readStr(o, ["commentUuid", "CommentUuid"]);
  if (!commentUuid) return null;
  const repliesRaw = o.replies ?? o.Replies;
  const replies: PostCommentDto[] = [];
  if (Array.isArray(repliesRaw)) {
    for (const x of repliesRaw) {
      const r = parsePostComment(x);
      if (r) replies.push(r);
    }
  }
  return {
    commentUuid,
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"]),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"]),
    authorAvatarUuid: readStr(o, ["authorAvatarUuid", "AuthorAvatarUuid"]) || null,
    authorUserUuid: readStr(o, ["authorUserUuid", "AuthorUserUuid"]) || null,
    content: readStr(o, ["content", "Content"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    repliesCount: readNum(o, ["repliesCount", "RepliesCount"]),
    replies,
  };
}

function stripCommentReplies(comments: PostCommentDto[]): PostCommentDto[] {
  return comments.map((c) => ({
    ...c,
    replies: [],
  }));
}

function findCommentInTree(
  comments: PostCommentDto[],
  commentUuid: string,
): PostCommentDto | null {
  for (const c of comments) {
    if (c.commentUuid === commentUuid) return c;
    if (c.replies?.length) {
      const nested = findCommentInTree(c.replies, commentUuid);
      if (nested) return nested;
    }
  }
  return null;
}

export async function apiGetPostComments(
  postUuid: string,
  options?: { skip?: number; take?: number; includeReplies?: boolean },
): Promise<PostCommentDto[]> {
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 50;
  const includeReplies = options?.includeReplies ?? true;

  if (isDevLocalOfflineSession()) {
    const { devDemoPostComments } = await import("@/lib/devLocalDemoData");
    const list = devDemoPostComments(postUuid);
    return includeReplies ? list : stripCommentReplies(list);
  }
  const q = new URLSearchParams({
    skip: String(skip),
    take: String(take),
    includeReplies: includeReplies ? "true" : "false",
  });
  const raw = (await authGetJson(
    apiUrl(`/api/auth/posts/${encodeURIComponent(postUuid)}/comments?${q}`)
  )) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: PostCommentDto[] = [];
  for (const x of raw) {
    const c = parsePostComment(x);
    if (c) out.push(c);
  }
  return out;
}

/** Прямые ответы на комментарий (без вложенных веток — те подгружаются отдельно). */
export async function apiGetCommentReplies(
  postUuid: string,
  commentUuid: string,
): Promise<PostCommentDto[]> {
  if (isDevLocalOfflineSession()) {
    const { devDemoPostComments } = await import("@/lib/devLocalDemoData");
    const parent = findCommentInTree(devDemoPostComments(postUuid), commentUuid);
    const replies = parent?.replies ?? [];
    return stripCommentReplies(replies);
  }
  const raw = (await authGetJson(
    apiUrl(
      `/api/auth/posts/${encodeURIComponent(postUuid)}/comments/${encodeURIComponent(commentUuid)}/replies`
    )
  )) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: PostCommentDto[] = [];
  for (const x of raw) {
    const c = parsePostComment(x);
    if (c) out.push(c);
  }
  return out;
}

export async function apiCreatePostComment(
  postUuid: string,
  content: string,
  parentCommentUuid?: string | null,
): Promise<PostCommentDto> {
  const trimmed = content.trim();
  const parentId = parentCommentUuid?.trim() || null;
  if (isDevLocalOfflineSession()) {
    const { DEV_LOCAL_ME } = await import("@/lib/devLocalDemoData");
    return {
      commentUuid: `0000c-${Date.now().toString(16)}`,
      authorUsername: DEV_LOCAL_ME.username,
      authorDisplayName: DEV_LOCAL_ME.displayName,
      content: trimmed,
      createdAt: new Date().toISOString(),
      repliesCount: 0,
      replies: [],
    };
  }
  const body: Record<string, unknown> = { content: trimmed };
  if (parentId) body.parentCommentUuid = parentId;
  const raw = (await authPostJson(
    apiUrl(`/api/auth/posts/${encodeURIComponent(postUuid)}/comments`),
    body,
    "Не удалось отправить комментарий"
  )) as Record<string, unknown>;
  const parsed = parsePostComment(raw);
  if (!parsed) {
    throw new ApiRequestError(500, "Некорректный ответ сервера.");
  }
  return parsed;
}

export async function apiCreatePost(
  content: string,
  options?: { communityId?: string },
): Promise<{ postUuid: string }> {
  const trimmed = clampPostContent(content.trim());
  if (isDevLocalOfflineSession()) {
    return { postUuid: `0000post-${Date.now().toString(16)}` };
  }
  const body: Record<string, unknown> = { content: trimmed };
  const communityId = options?.communityId?.trim();
  if (communityId) body.communityId = communityId;
  const raw = (await authPostJson(apiUrl("/api/auth/posts"), body, "Не удалось опубликовать пост")) as Record<
    string,
    unknown
  >;
  return { postUuid: readStr(raw, ["postUuid", "PostUuid"]) };
}

/** Публичный URL изображения поста (GET без авторизации). */
export function postImageUrl(imageUuid: string): string {
  const id = imageUuid.trim();
  return apiUrl(`/api/auth/posts/images/${encodeURIComponent(id)}`);
}

/** Публичный URL видеофайла поста (AV1 MP4, сервер поддерживает Range). */
export function postVideoUrl(videoUuid: string): string {
  const id = videoUuid.trim();
  return apiUrl(`/api/auth/posts/videos/${encodeURIComponent(id)}`);
}

/** Публичный URL AVIF-постера видео поста. */
export function postVideoPosterUrl(videoUuid: string): string {
  const id = videoUuid.trim();
  return apiUrl(`/api/auth/posts/videos/${encodeURIComponent(id)}/poster`);
}

/** Загрузить видео к посту (MP4/MOV/WebM/MKV, до 200 МБ, ≤ 10 мин). Транскодируется на сервере. */
export async function apiUploadPostVideo(postUuid: string, file: File): Promise<PostVideoDto | null> {
  const id = postUuid.trim();
  if (!id) return null;
  if (isDevLocalOfflineSession()) {
    return { videoUuid: `0000vid-offline-${Date.now().toString(16)}`, status: "processing", width: 0, height: 0, durationMs: 0 };
  }
  const form = new FormData();
  form.append("file", file);
  const raw = (await authPostForm(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/video`), form)) as Record<
    string,
    unknown
  >;
  const videoUuid = readStr(raw, ["videoUuid", "VideoUuid"]);
  if (!videoUuid) return null;
  return { videoUuid, status: "processing", width: 0, height: 0, durationMs: 0 };
}

/** Статус видео поста (поллинг, пока идёт транскодирование). */
export async function apiGetPostVideoStatus(postUuid: string): Promise<PostVideoDto | null> {
  const id = postUuid.trim();
  if (!id || isDevLocalOfflineSession()) return null;
  const raw = await authGetJson(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/video/status`));
  if (!raw || typeof raw !== "object") return null;
  return parsePostVideoField({ video: raw });
}

/** Загрузить фото к посту (JPEG/PNG/WebP, до 10 шт., 5 МБ каждое). */
export async function apiUploadPostImages(postUuid: string, files: File[]): Promise<string[]> {
  const id = postUuid.trim();
  if (!id || files.length === 0) return [];
  if (isDevLocalOfflineSession()) {
    return files.map((_, i) => `0000img-offline-${Date.now().toString(16)}-${i}`);
  }
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const raw = (await authPostForm(apiUrl(`/api/auth/posts/${encodeURIComponent(id)}/images`), form)) as Record<
    string,
    unknown
  >;
  const uuidsRaw = raw.imageUuids ?? raw.ImageUuids;
  if (!Array.isArray(uuidsRaw)) return [];
  const out: string[] = [];
  for (const item of uuidsRaw) {
    const uuid = typeof item === "string" ? item.trim() : "";
    if (uuid) out.push(uuid);
  }
  return out;
}

export type PostDraftDto = {
  draftUuid: string;
  label: string;
  content: string;
  communityId?: string | null;
  createdAt: string;
  updatedAt: string;
};

const devPostDraftsByScope = new Map<string, PostDraftDto[]>();
const MAX_POST_DRAFTS = 15;

function devPostDraftScopeKey(communityId?: string): string {
  return communityId?.trim() || "primary";
}

function devPostDraftsForScope(communityId?: string): PostDraftDto[] {
  const key = devPostDraftScopeKey(communityId);
  let list = devPostDraftsByScope.get(key);
  if (!list) {
    list = [];
    devPostDraftsByScope.set(key, list);
  }
  return list;
}

function parsePostDraft(raw: unknown): PostDraftDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const draftUuid = readStr(o, ["draftUuid", "DraftUuid"]);
  if (!draftUuid) return null;
  const communityIdRaw = readStr(o, ["communityId", "CommunityId"]);
  return {
    draftUuid,
    label: readStr(o, ["label", "Label"]),
    content: readStr(o, ["content", "Content"]),
    communityId: communityIdRaw || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    updatedAt: readStr(o, ["updatedAt", "UpdatedAt"]),
  };
}

function postDraftsListUrl(communityId?: string): string {
  const q = communityId?.trim() ? `?communityId=${encodeURIComponent(communityId.trim())}` : "";
  return apiUrl(`/api/auth/post-drafts${q}`);
}

async function authPatchJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authDelete(url: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

export async function apiListPostDrafts(input?: { communityId?: string }): Promise<PostDraftDto[]> {
  const communityId = input?.communityId?.trim() || undefined;
  if (isDevLocalOfflineSession()) {
    return [...devPostDraftsForScope(communityId)];
  }
  const raw = await authGetJson(postDraftsListUrl(communityId));
  if (!Array.isArray(raw)) return [];
  const out: PostDraftDto[] = [];
  for (const item of raw) {
    const parsed = parsePostDraft(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiCreatePostDraft(input: {
  label?: string;
  content?: string;
  communityId?: string;
}): Promise<PostDraftDto> {
  const communityId = input.communityId?.trim() || undefined;
  const content = input.content === undefined ? "" : clampPostContent(input.content);
  if (isDevLocalOfflineSession()) {
    const scoped = devPostDraftsForScope(communityId);
    if (scoped.length >= MAX_POST_DRAFTS) {
      throw new ApiRequestError(400, `Не более ${MAX_POST_DRAFTS} черновиков.`);
    }
    const now = new Date().toISOString();
    const draft: PostDraftDto = {
      draftUuid: floraNewUuid(),
      label: input.label?.trim() || `Черновик ${scoped.length + 1}`,
      content,
      communityId: communityId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    scoped.unshift(draft);
    return draft;
  }
  const body: Record<string, unknown> = {
    label: input.label,
    content,
  };
  if (communityId) body.communityId = communityId;
  const raw = (await authPostJson(apiUrl("/api/auth/post-drafts"), body, "Не удалось сохранить черновик")) as Record<
    string,
    unknown
  >;
  const parsed = parsePostDraft(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiUpdatePostDraft(
  draftUuid: string,
  input: { label?: string; content?: string },
): Promise<PostDraftDto> {
  if (isDevLocalOfflineSession()) {
    let found: { list: PostDraftDto[]; idx: number } | null = null;
    for (const list of devPostDraftsByScope.values()) {
      const idx = list.findIndex((d) => d.draftUuid === draftUuid);
      if (idx >= 0) {
        found = { list, idx };
        break;
      }
    }
    if (!found) throw new ApiRequestError(404, "Черновик не найден.");
    const current = found.list[found.idx]!;
    const next: PostDraftDto = {
      ...current,
      label: input.label !== undefined ? input.label : current.label,
      content:
        input.content !== undefined ? clampPostContent(input.content) : current.content,
      updatedAt: new Date().toISOString(),
    };
    found.list[found.idx] = next;
    return next;
  }
  const body: Record<string, unknown> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.content !== undefined) body.content = clampPostContent(input.content);
  const raw = (await authPatchJson(
    apiUrl(`/api/auth/post-drafts/${encodeURIComponent(draftUuid)}`),
    body,
  )) as Record<string, unknown>;
  const parsed = parsePostDraft(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiDeletePostDraft(draftUuid: string): Promise<void> {
  if (isDevLocalOfflineSession()) {
    for (const list of devPostDraftsByScope.values()) {
      const idx = list.findIndex((d) => d.draftUuid === draftUuid);
      if (idx >= 0) {
        list.splice(idx, 1);
        return;
      }
    }
    return;
  }
  await authDelete(apiUrl(`/api/auth/post-drafts/${encodeURIComponent(draftUuid)}`));
}

export type OwnedCommunityDto = {
  communityId: string;
  name: string;
  slug: string;
  memberCount: number;
  isPrivate?: boolean;
  avatarUuid?: string | null;
};

const devOwnedCommunities: OwnedCommunityDto[] = [];
const devCommunityPrivacy = new Map<string, boolean>();

function parseOwnedCommunity(raw: unknown): OwnedCommunityDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const communityId = readStr(o, ["communityId", "CommunityId", "community_id"]);
  if (!communityId) return null;
  const isPrivateRaw = o.isPrivate ?? o.IsPrivate;
  return {
    communityId,
    name: readStr(o, ["name", "Name"]),
    slug: readStr(o, ["slug", "Slug"]),
    memberCount: readNum(o, ["memberCount", "MemberCount"]) || 1,
    avatarUuid: readStr(o, ["avatarUuid", "AvatarUuid"]) || null,
    isPrivate: typeof isPrivateRaw === "boolean" ? isPrivateRaw : undefined,
  };
}

export async function apiListOwnedCommunities(): Promise<OwnedCommunityDto[]> {
  if (isDevLocalOfflineSession()) {
    return [...devOwnedCommunities];
  }
  const raw = await authGetJson(apiUrl("/api/auth/communities/owned"));
  if (!Array.isArray(raw)) return [];
  const out: OwnedCommunityDto[] = [];
  for (const item of raw) {
    const parsed = parseOwnedCommunity(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Публичные сообщества из БД (без приватных). */
export async function apiListPublicCommunities(): Promise<OwnedCommunityDto[]> {
  if (isDevLocalOfflineSession()) return [];
  const raw = await authGetJson(apiUrl("/api/auth/communities"));
  if (!Array.isArray(raw)) return [];
  const out: OwnedCommunityDto[] = [];
  for (const item of raw) {
    const parsed = parseOwnedCommunity(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Персональные рекомендации публичных сообществ. */
export async function apiGetRecommendedCommunities(take = 30): Promise<OwnedCommunityDto[]> {
  if (isDevLocalOfflineSession()) return [];
  const raw = await authGetJson(apiUrl(`/api/auth/communities/recommended?take=${take}`));
  // Handle both old bare-array format and new {items, generatedAt, expiresAt} format
  const itemsRaw = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).items ?? (raw as Record<string, unknown>).Items)
      : null;
  if (!Array.isArray(itemsRaw)) return [];
  const out: OwnedCommunityDto[] = [];
  for (const item of itemsRaw) {
    const parsed = parseOwnedCommunity(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type CommunitySearchDto = OwnedCommunityDto & {
  role?: string | null;
};

function parseCommunitySearch(raw: unknown): CommunitySearchDto | null {
  const base = parseOwnedCommunity(raw);
  if (!base) return null;
  const o = raw as Record<string, unknown>;
  const roleRaw = readStr(o, ["role", "Role"]);
  return { ...base, role: roleRaw || null };
}

function communitySearchTab(role: string | null | undefined): "owned" | "subscriptions" | "recommendations" {
  if (role === "Owner") return "owned";
  if (role === "Member") return "subscriptions";
  return "recommendations";
}

export async function apiSearchCommunities(q: string, skip = 0, take = 20): Promise<CommunitySearchDto[]> {
  const query = q.trim();
  if (!query) return [];
  if (isDevLocalOfflineSession()) {
    const { COMMUNITIES } = await import("@/app/(dashboard)/communities/communitiesSeed");
    const lower = query.toLowerCase();
    const seedRows: CommunitySearchDto[] = COMMUNITIES.filter(
      (c) => c.name.toLowerCase().includes(lower) || (c.slug?.toLowerCase().includes(lower) ?? false),
    ).map((c) => ({
      communityId: c.id,
      name: c.name,
      slug: c.slug ?? c.id,
      memberCount: c.members,
      role: c.tab === "owned" ? "Owner" : c.tab === "subscriptions" ? "Member" : null,
    }));
    const ownedRows: CommunitySearchDto[] = devOwnedCommunities
      .filter(
        (c) => c.name.toLowerCase().includes(lower) || c.slug.toLowerCase().includes(lower),
      )
      .map((c) => ({ ...c, role: "Owner" }));
    const merged = new Map<string, CommunitySearchDto>();
    for (const row of [...ownedRows, ...seedRows]) {
      merged.set(row.communityId, row);
    }
    return [...merged.values()].slice(skip, skip + take);
  }
  const params = new URLSearchParams({ q: query, skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/communities/search?${params}`));
  if (!Array.isArray(raw)) return [];
  const out: CommunitySearchDto[] = [];
  for (const item of raw) {
    const parsed = parseCommunitySearch(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export { communitySearchTab };

export async function apiJoinCommunity(communityId: string): Promise<CommunityProfileDto> {
  const id = communityId.trim();
  if (!id) throw new ApiRequestError(400, "Укажите сообщество.");
  if (isDevLocalOfflineSession()) {
    throw new ApiRequestError(501, "Подписка на сообщество недоступна в офлайн-режиме.");
  }
  const raw = (await authPostJson(
    apiUrl(`/api/auth/communities/${encodeURIComponent(id)}/join`),
    {},
    "Не удалось подписаться на сообщество",
  )) as Record<string, unknown>;
  const parsed = parseCommunityProfile(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiLeaveCommunity(communityId: string): Promise<void> {
  const id = communityId.trim();
  if (!id) throw new ApiRequestError(400, "Укажите сообщество.");
  if (isDevLocalOfflineSession()) {
    throw new ApiRequestError(501, "Отписка от сообщества недоступна в офлайн-режиме.");
  }
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}/join`), init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}/join`), init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

export type ProfileCommunityDto = {
  name: string;
  slug: string;
};

function parseProfileCommunity(raw: unknown): ProfileCommunityDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const slug = readStr(o, ["slug", "Slug"]);
  if (!slug) return null;
  return {
    slug,
    name: readStr(o, ["name", "Name"]),
  };
}

/** Подписки пользователя на сообщества (не владелец). */
export async function apiListProfileCommunities(username: string): Promise<ProfileCommunityDto[]> {
  const normalized = username.trim();
  if (!normalized) return [];
  if (isDevLocalOfflineSession()) return [];
  const raw = await authGetJson(
    apiUrl(`/api/auth/profile/${encodeURIComponent(normalized)}/communities`),
  );
  if (!Array.isArray(raw)) return [];
  const out: ProfileCommunityDto[] = [];
  for (const item of raw) {
    const parsed = parseProfileCommunity(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type CommunityProfileDto = {
  communityId: string;
  name: string;
  slug: string;
  memberCount: number;
  role?: string | null;
  avatarUuid?: string | null;
  isPrivate?: boolean | null;
};

function parseCommunityProfile(raw: unknown): CommunityProfileDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const communityId = readStr(o, ["communityId", "CommunityId", "community_id"]);
  const slug = readStr(o, ["slug", "Slug"]);
  if (!communityId || !slug) return null;
  const roleRaw = readStr(o, ["role", "Role"]);
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"]);
  const isPrivateRaw = o.isPrivate ?? o.IsPrivate;
  return {
    communityId,
    slug,
    name: readStr(o, ["name", "Name"]),
    memberCount: readNum(o, ["memberCount", "MemberCount"]) || 0,
    role: roleRaw || null,
    avatarUuid: avatarUuid || null,
    isPrivate: typeof isPrivateRaw === "boolean" ? isPrivateRaw : null,
  };
}

export async function apiGetCommunityBySlug(slug: string): Promise<CommunityProfileDto> {
  const normalized = slug.trim();
  if (!normalized) throw new ApiRequestError(400, "Укажите ссылку сообщества.");
  if (isDevLocalOfflineSession()) {
    const owned = devOwnedCommunities.find((c) => c.slug === normalized);
    if (!owned) throw new ApiRequestError(404, "Сообщество не найдено.");
    return {
      ...owned,
      role: "Owner",
      isPrivate: devCommunityPrivacy.get(owned.communityId) ?? owned.isPrivate ?? true,
      avatarUuid: null,
    };
  }
  const raw = await authGetJson(apiUrl(`/api/auth/communities/slug/${encodeURIComponent(normalized)}`));
  const parsed = parseCommunityProfile(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiUpdateCommunity(
  communityId: string,
  input: { name?: string; slug?: string; isPrivate?: boolean },
): Promise<CommunityProfileDto> {
  const id = communityId.trim();
  if (!id) throw new ApiRequestError(400, "Укажите сообщество.");
  if (isDevLocalOfflineSession()) {
    const idx = devOwnedCommunities.findIndex((c) => c.communityId === id);
    if (idx < 0) throw new ApiRequestError(404, "Сообщество не найдено.");
    const current = devOwnedCommunities[idx]!;
    if (input.slug?.trim()) {
      const slug = input.slug.trim();
      if (isReservedCommunitySlug(slug)) throw new ApiRequestError(400, RESERVED_COMMUNITY_SLUG_MESSAGE);
      current.slug = slug;
    }
    if (input.name?.trim()) current.name = input.name.trim();
    if (input.isPrivate !== undefined) {
      devCommunityPrivacy.set(id, input.isPrivate);
      current.isPrivate = input.isPrivate;
    }
    devOwnedCommunities[idx] = current;
    return {
      ...current,
      role: "Owner",
      isPrivate: devCommunityPrivacy.get(id) ?? current.isPrivate ?? true,
      avatarUuid: null,
    };
  }
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.slug !== undefined) body.slug = input.slug;
  if (input.isPrivate !== undefined) body.isPrivate = input.isPrivate;
  const raw = (await authPatchJson(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}`), body)) as Record<
    string,
    unknown
  >;
  const parsed = parseCommunityProfile(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return { ...parsed, role: "Owner" };
}

export async function apiDeleteCommunity(communityId: string): Promise<void> {
  const id = communityId.trim();
  if (!id) throw new ApiRequestError(400, "Укажите сообщество.");
  if (isDevLocalOfflineSession()) {
    const idx = devOwnedCommunities.findIndex((c) => c.communityId === id);
    if (idx < 0) throw new ApiRequestError(404, "Сообщество не найдено.");
    devOwnedCommunities.splice(idx, 1);
    return;
  }
  await authDelete(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}`));
}

export async function apiUploadCommunityAvatar(communityId: string, file: File): Promise<string> {
  const id = communityId.trim();
  if (!id) throw new ApiRequestError(400, "Укажите сообщество.");
  if (isDevLocalOfflineSession()) {
    throw new ApiRequestError(501, "Загрузка аватара сообщества недоступна в офлайн-режиме.");
  }
  const form = new FormData();
  form.append("file", file);
  const raw = (await authPostForm(apiUrl(`/api/auth/communities/${encodeURIComponent(id)}/avatar`), form)) as Record<
    string,
    unknown
  >;
  const avatarUuid = readStr(raw, ["avatarUuid", "AvatarUuid"]);
  if (!avatarUuid) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return avatarUuid;
}

export async function apiCreateCommunity(input: {
  name: string;
  slug?: string;
  isPrivate?: boolean;
}): Promise<OwnedCommunityDto> {
  const isPrivate = input.isPrivate ?? true;
  if (isDevLocalOfflineSession()) {
    const slug =
      input.slug?.trim() ||
      input.name
        .trim()
        .toLowerCase()
        .replace(/[^a-zA-Z0-9_-]+/g, "");
    if (isReservedCommunitySlug(slug)) {
      throw new ApiRequestError(400, RESERVED_COMMUNITY_SLUG_MESSAGE);
    }
    const created: OwnedCommunityDto = {
      communityId: floraNewUuid(),
      name: input.name.trim(),
      slug: slug || `community-${devOwnedCommunities.length + 1}`,
      memberCount: 1,
      isPrivate,
    };
    devCommunityPrivacy.set(created.communityId, isPrivate);
    devOwnedCommunities.unshift(created);
    return created;
  }
  const body: Record<string, unknown> = { name: input.name.trim(), isPrivate };
  if (input.slug?.trim()) body.slug = input.slug.trim();
  const raw = (await authPostJson(
    apiUrl("/api/auth/communities"),
    body,
    "Не удалось создать сообщество",
  )) as Record<string, unknown>;
  const parsed = parseOwnedCommunity(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export type ProfilePostDto = {
  postUuid: string;
  content: string;
  createdAt: string;
  video?: PostVideoDto | null;
  commentsCount: number;
  likesCount: number;
  repostsCount: number;
  viewsCount: number;
  liked: boolean;
  reposted: boolean;
  imageUuids: string[];
};

function parseProfilePost(raw: unknown): ProfilePostDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const postUuid = readStr(o, ["postUuid", "PostUuid"]);
  if (!postUuid) return null;
  return {
    postUuid,
    content: readStr(o, ["content", "Content"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    commentsCount: readNum(o, ["commentsCount", "CommentsCount"]),
    likesCount: readNum(o, ["likesCount", "LikesCount"]),
    repostsCount: readNum(o, ["repostsCount", "RepostsCount"]),
    viewsCount: readNum(o, ["viewsCount", "ViewsCount"]),
    liked: readBool(o, ["liked", "Liked"]),
    reposted: readBool(o, ["reposted", "Reposted"]),
    imageUuids: parseImageUuidsField(o),
    video: parsePostVideoField(o),
  };
}

export async function apiGetProfilePosts(username: string, skip = 0, take = 20): Promise<ProfilePostDto[]> {
  if (isDevLocalOfflineSession()) {
    return devDemoGetProfilePosts(username, skip, take).filter((post) => !devDeletedPostUuids.has(post.postUuid));
  }
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const url = apiUrl(`/api/auth/profile/${enc}/posts?${q}`);
  let token = getAccessToken();
  const authHeaders = (t: string): HeadersInit => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, token ? { headers: authHeaders(token) } : {});
  if (r.status === 401 && token) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: authHeaders(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401 && token) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  const raw = await r.json().catch(() => []);
  if (!Array.isArray(raw)) return [];
  const out: ProfilePostDto[] = [];
  for (const x of raw) {
    const p = parseProfilePost(x);
    if (p) out.push(p);
  }
  return out;
}

export async function apiGetProfileLikes(username: string, skip = 0, take = 20): Promise<ProfilePostDto[]> {
  if (isDevLocalOfflineSession()) return [];
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const url = apiUrl(`/api/auth/profile/${enc}/likes?${q}`);
  let token = getAccessToken();
  const authHeaders = (t: string): HeadersInit => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, token ? { headers: authHeaders(token) } : {});
  if (r.status === 401 && token) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: authHeaders(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401 && token) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  const raw = await r.json().catch(() => []);
  if (!Array.isArray(raw)) return [];
  const out: ProfilePostDto[] = [];
  for (const x of raw) {
    const p = parseProfilePost(x);
    if (p) out.push(p);
  }
  return out;
}

export async function apiGetProfileReposts(username: string, skip = 0, take = 20): Promise<ProfilePostDto[]> {
  if (isDevLocalOfflineSession()) return [];
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const url = apiUrl(`/api/auth/profile/${enc}/reposts?${q}`);
  let token = getAccessToken();
  const authHeaders = (t: string): HeadersInit => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, token ? { headers: authHeaders(token) } : {});
  if (r.status === 401 && token) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: authHeaders(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401 && token) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  const raw = await r.json().catch(() => []);
  if (!Array.isArray(raw)) return [];
  const out: ProfilePostDto[] = [];
  for (const x of raw) {
    const p = parseProfilePost(x);
    if (p) out.push(p);
  }
  return out;
}

export type PublicProfileDto = {
  userUuid: string;
  username: string;
  displayName: string;
  status: string;
  avatarUuid?: string | null;
  followersCount: number;
  followingCount: number;
  isFollowingByMe: boolean;
};

export async function apiGetPublicProfile(username: string): Promise<PublicProfileDto> {
  if (isDevLocalOfflineSession()) {
    const profile = devDemoGetPublicProfile(username);
    if (!profile) throw new ApiRequestError(404, "Профиль не найден");
    return { ...profile, isFollowingByMe: false };
  }
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const url = apiUrl(`/api/auth/profile/${enc}`);
  const o = getAccessToken()
    ? ((await authGetJson(url)) as Record<string, unknown>)
    : ((await (async () => {
        const r = await fetch(url);
        if (!r.ok) throw new ApiRequestError(r.status, await parseErr(r));
        return r.json().catch(() => ({}));
      })()) as Record<string, unknown>);
  return {
    userUuid: readStr(o, ["userUuid", "UserUuid"]),
    username: readStr(o, ["username", "Username"]),
    displayName: readStr(o, ["displayName", "DisplayName"]),
    status: readStr(o, ["status", "Status"]),
    avatarUuid: readStr(o, ["avatarUuid", "AvatarUuid"]) || null,
    followersCount: readNum(o, ["followersCount", "FollowersCount"]),
    followingCount: readNum(o, ["followingCount", "FollowingCount"]),
    isFollowingByMe: getAccessToken() ? readBool(o, ["isFollowingByMe", "IsFollowingByMe"]) : false,
  };
}

/** Элемент списка диалогов (`GET /api/auth/conversations`). */
export type ConversationListItemDto = {
  otherUserUuid: string;
  otherUsername: string;
  otherDisplayName: string;
  lastMessageUuid: string;
  lastMessageContent: string | null;
  lastMessageEncryptedForMe: string | null;
  lastMessageIsFromMe: boolean;
  hasEncryptedPreview: boolean;
  lastMessageAt: string;
  unreadCount: number;
  /** Пока без отдельного presence-сервиса: с сервера может отсутствовать (тогда false). */
  otherUserIsOnline: boolean;
  /** ISO UTC последней активности собеседника (для «Был в сети …»); может отсутствовать. */
  otherUserLastSeenAt: string | null;
};

function parseConversationListItem(raw: unknown): ConversationListItemDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const otherUserUuid = readStr(o, ["otherUserUuid", "OtherUserUuid"]);
  if (!otherUserUuid) return null;
  const lastMessageContent = readStr(o, ["lastMessageContent", "LastMessageContent"]);
  const enc = readStr(o, ["lastMessageEncryptedForMe", "LastMessageEncryptedForMe"]);
  const hasEncryptedPreview = Boolean(enc.trim()) && !lastMessageContent.trim();
  const encTrim = enc.trim();
  return {
    otherUserUuid,
    otherUsername: readStr(o, ["otherUsername", "OtherUsername"]),
    otherDisplayName: readStr(o, ["otherDisplayName", "OtherDisplayName"]),
    lastMessageUuid: readStr(o, ["lastMessageUuid", "LastMessageUuid"]),
    lastMessageContent: lastMessageContent.length > 0 ? lastMessageContent : null,
    lastMessageEncryptedForMe: encTrim.length > 0 ? enc : null,
    lastMessageIsFromMe: readBool(o, ["lastMessageIsFromMe", "LastMessageIsFromMe"]),
    hasEncryptedPreview,
    lastMessageAt: readStr(o, ["lastMessageAt", "LastMessageAt"]),
    unreadCount: readNum(o, ["unreadCount", "UnreadCount"]),
    otherUserIsOnline: readBool(o, ["otherUserIsOnline", "OtherUserIsOnline"]),
    otherUserLastSeenAt: (() => {
      const s = readStr(o, ["otherUserLastSeenAt", "OtherUserLastSeenAt"]).trim();
      return s.length > 0 ? s : null;
    })(),
  };
}

export async function apiGetConversations(): Promise<ConversationListItemDto[]> {
  if (isDevLocalOfflineSession()) return devDemoGetConversations();
  const raw = await authGetJson(apiUrl("/api/auth/conversations"));
  if (!Array.isArray(raw)) return [];
  const out: ConversationListItemDto[] = [];
  for (const x of raw) {
    const p = parseConversationListItem(x);
    if (p) out.push(p);
  }
  return out;
}

export type MessageThreadItemDto = {
  messageUuid: string;
  content: string | null;
  encryptedForMe: string | null;
  createdAt: string;
  isFromMe: boolean;
  isRead?: boolean;
  sendStatus?: "sending";
};

function parseMessageThreadItem(raw: unknown): MessageThreadItemDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const messageUuid = readStr(o, ["messageUuid", "MessageUuid"]);
  if (!messageUuid) return null;
  const content = readStr(o, ["content", "Content"]);
  const enc = readStr(o, ["encryptedForMe", "EncryptedForMe"]);
  return {
    messageUuid,
    content: content.length > 0 ? content : null,
    encryptedForMe: enc.length > 0 ? enc : null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    isFromMe: readBool(o, ["isFromMe", "IsFromMe"]),
    isRead: readBool(o, ["isRead", "IsRead"]),
  };
}

export async function apiGetMessagesWithUser(otherUserUuid: string, skip = 0, take = 50): Promise<MessageThreadItemDto[]> {
  if (isDevLocalOfflineSession()) {
    const all = devDemoGetThread(otherUserUuid);
    const slice = all.slice(skip, skip + take);
    return slice.reverse();
  }
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/conversations/with/${encodeURIComponent(otherUserUuid)}?${q}`));
  if (!Array.isArray(raw)) return [];
  const out: MessageThreadItemDto[] = [];
  for (const x of raw) {
    const p = parseMessageThreadItem(x);
    if (p) out.push(p);
  }
  return out.reverse();
}

export async function apiSendMessagePlaintext(toUserUuid: string, content: string): Promise<{ messageUuid: string; createdAt: string }> {
  const raw = (await authPostJson(
    apiUrl("/api/auth/messages"),
    { toUserUuid, content: content.trim() },
    "Не удалось отправить сообщение"
  )) as Record<string, unknown>;
  return {
    messageUuid: readStr(raw, ["messageUuid", "MessageUuid"]),
    createdAt: readStr(raw, ["createdAt", "CreatedAt"]),
  };
}

export async function apiMarkConversationRead(otherUserUuid: string): Promise<void> {
  if (isDevLocalOfflineSession()) {
    devDemoMarkRead(otherUserUuid);
    return;
  }
  await authPatch(apiUrl(`/api/auth/conversations/with/${encodeURIComponent(otherUserUuid)}/read`));
}

export type UserE2eKeyBundle = {
  publicKeyBase64: string;
  deviceUuid: string | null;
};

/** 32 нулевых байта (X25519), base64 — для офлайн-демо, без реального peer. */
const DEV_DUMMY_E2E_PUB_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function apiGetUserE2ePublicKey(userUuid: string): Promise<UserE2eKeyBundle> {
  if (isDevLocalOfflineSession()) {
    const du = floraNewUuid();
    return {
      publicKeyBase64: DEV_DUMMY_E2E_PUB_B64,
      deviceUuid: du,
    };
  }
  const raw = (await authGetJson(apiUrl(`/api/auth/users/${encodeURIComponent(userUuid)}/e2e-public-key`))) as Record<string, unknown>;
  const du = readStr(raw, ["deviceUuid", "DeviceUuid"]);
  return {
    publicKeyBase64: readStr(raw, ["publicKeyBase64", "PublicKeyBase64"]),
    deviceUuid: du.length > 0 ? du : null,
  };
}

export async function apiPutMyE2ePublicKey(publicKeyBase64: string, deviceUuid?: string | null): Promise<{ deviceUuid: string }> {
  if (isDevLocalOfflineSession()) {
    const du =
      deviceUuid && deviceUuid.trim().length > 0 ? deviceUuid.trim() : floraNewUuid();
    return { deviceUuid: du };
  }
  const body: Record<string, unknown> = { publicKeyBase64 };
  if (deviceUuid && deviceUuid.length > 0) body.deviceUuid = deviceUuid;
  const raw = (await authPostJson(
    apiUrl("/api/auth/me/e2e-public-key"),
    body,
    "Ошибка сохранения E2E ключа.",
  )) as Record<string, unknown>;
  return { deviceUuid: readStr(raw, ["deviceUuid", "DeviceUuid"]) };
}

export type UploadedVoiceAssetDto = {
  voiceAssetUuid: string;
  contentType: string;
  durationMs: number;
};

export async function apiUploadMessageVoiceAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  durationMs: number;
}): Promise<UploadedVoiceAssetDto> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("durationMs", String(Math.max(1, Math.round(params.durationMs))));
  body.set("file", params.encryptedBlob, "voice-message.bin");
  const raw = (await authPostForm(apiUrl("/api/messaging/voice-assets"), body)) as Record<string, unknown>;
  const voiceAssetUuid = readStr(raw, ["voiceAssetUuid", "VoiceAssetUuid"]);
  if (!voiceAssetUuid) throw new ApiRequestError(500, "Некорректный ответ сервера при загрузке голосового.");
  return {
    voiceAssetUuid,
    contentType: readStr(raw, ["contentType", "ContentType"]) || "application/octet-stream",
    durationMs: readNum(raw, ["durationMs", "DurationMs"]),
  };
}

export async function apiDownloadMessageVoiceAsset(voiceAssetUuid: string): Promise<Blob> {
  return authGetBlob(apiUrl(`/api/messaging/voice-assets/${encodeURIComponent(voiceAssetUuid)}`));
}

export type UploadedImageAssetDto = {
  imageAssetUuid: string;
  contentType: string;
};

export async function apiUploadMessageImageAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  contentType: string;
}): Promise<UploadedImageAssetDto> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("contentType", params.contentType);
  body.set("file", params.encryptedBlob, "message-image.bin");
  const raw = (await authPostForm(apiUrl("/api/messaging/image-assets"), body)) as Record<string, unknown>;
  const imageAssetUuid = readStr(raw, ["imageAssetUuid", "ImageAssetUuid"]);
  if (!imageAssetUuid) throw new ApiRequestError(500, "Некорректный ответ сервера при загрузке фото.");
  return {
    imageAssetUuid,
    contentType: readStr(raw, ["contentType", "ContentType"]) || params.contentType,
  };
}

export async function apiDownloadMessageImageAsset(imageAssetUuid: string): Promise<Blob> {
  return authGetBlob(apiUrl(`/api/messaging/image-assets/${encodeURIComponent(imageAssetUuid)}`));
}

export type UploadedVideoAssetDto = {
  videoAssetUuid: string;
  contentType: string;
};

export async function apiUploadMessageVideoAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  contentType: string;
  durationMs: number;
}): Promise<UploadedVideoAssetDto> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("contentType", params.contentType);
  body.set("durationMs", String(Math.max(0, Math.round(params.durationMs))));
  body.set("file", params.encryptedBlob, "message-video.bin");
  const raw = (await authPostForm(apiUrl("/api/messaging/video-assets"), body)) as Record<string, unknown>;
  const videoAssetUuid = readStr(raw, ["videoAssetUuid", "VideoAssetUuid"]);
  if (!videoAssetUuid) throw new ApiRequestError(500, "Некорректный ответ сервера при загрузке видео.");
  return {
    videoAssetUuid,
    contentType: readStr(raw, ["contentType", "ContentType"]) || params.contentType,
  };
}

export async function apiDownloadMessageVideoAsset(videoAssetUuid: string): Promise<Blob> {
  return authGetBlob(apiUrl(`/api/messaging/video-assets/${encodeURIComponent(videoAssetUuid)}`));
}

export type PeopleSearchUserDto = {
  username: string;
  displayName: string;
  isFollowing: boolean;
  followerCount?: number;
};

export type RecommendedUserDto = PeopleSearchUserDto & {
  followerCount: number;
};

function parseRecommendedUser(raw: unknown): RecommendedUserDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const username = readStr(o, ["username", "Username"]);
  if (!username) return null;
  return {
    username,
    displayName: readStr(o, ["displayName", "DisplayName"]) || username,
    followerCount: readNum(o, ["followerCount", "FollowerCount", "followersCount", "FollowersCount"]),
    isFollowing: readBool(o, ["isFollowing", "IsFollowing"]),
  };
}

export type PeopleListEntryDto = {
  username: string;
  displayName: string;
  followerCount?: number;
};

function parsePeopleListEntry(raw: unknown): PeopleListEntryDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const username = readStr(o, ["username", "Username"]);
  if (!username) return null;
  const displayName = readStr(o, ["displayName", "DisplayName"]) || username;
  const followerCount = readNum(o, ["followerCount", "FollowerCount", "followersCount", "FollowersCount"]);
  return { username, displayName, followerCount };
}

export async function apiSearchUsers(q: string, skip = 0, take = 20): Promise<PeopleSearchUserDto[]> {
  if (isDevLocalOfflineSession()) {
    const { devDemoPeopleRows, DEV_DEMO_PEOPLE_BASE } = await import("@/lib/devLocalDemoData");
    const lower = q.trim().toLowerCase();
    const rows = [...DEV_DEMO_PEOPLE_BASE, ...devDemoPeopleRows()].filter(
      (u) => u.displayName.toLowerCase().includes(lower) || u.username.toLowerCase().includes(lower),
    );
    return rows.slice(skip, skip + take).map((u) => ({
      username: u.username.replace(/^@+/, ""),
      displayName: u.displayName,
      followerCount: u.followers,
      isFollowing: false,
    }));
  }
  const params = new URLSearchParams({ q: q.trim(), skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/users/search?${params}`));
  if (!Array.isArray(raw)) return [];
  const out: PeopleSearchUserDto[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const username = readStr(o, ["username", "Username"]);
    if (!username) continue;
    out.push({
      username,
      displayName: readStr(o, ["displayName", "DisplayName"]) || username,
      followerCount: readNum(o, ["followerCount", "FollowerCount", "followersCount", "FollowersCount"]),
      isFollowing: readBool(o, ["isFollowing", "IsFollowing"]),
    });
  }
  return out;
}

export async function apiGetRecommendedUsers(take = 40): Promise<RecommendedUserDto[]> {
  if (isDevLocalOfflineSession()) {
    const { devDemoPeopleRows, DEV_DEMO_PEOPLE_BASE } = await import("@/lib/devLocalDemoData");
    return [...DEV_DEMO_PEOPLE_BASE, ...devDemoPeopleRows()]
      .sort((a, b) => b.followers - a.followers)
      .slice(0, take)
      .map((u) => ({
        username: u.username.replace(/^@+/, ""),
        displayName: u.displayName,
        followerCount: u.followers,
        isFollowing: false,
      }));
  }
  const raw = await authGetJson(apiUrl(`/api/auth/users/recommended?take=${take}`));
  // Handle both old bare-array format and new {items, generatedAt, expiresAt} format
  const itemsRaw = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).items ?? (raw as Record<string, unknown>).Items)
      : null;
  if (!Array.isArray(itemsRaw)) return [];
  const out: RecommendedUserDto[] = [];
  for (const x of itemsRaw) {
    const parsed = parseRecommendedUser(x);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetProfileFollowers(username: string, skip = 0, take = 50): Promise<PeopleListEntryDto[]> {
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/profile/${enc}/followers?${q}`));
  if (!Array.isArray(raw)) return [];
  const out: PeopleListEntryDto[] = [];
  for (const x of raw) {
    const p = parsePeopleListEntry(x);
    if (p) out.push(p);
  }
  return out;
}

export async function apiGetProfileFollowing(username: string, skip = 0, take = 50): Promise<PeopleListEntryDto[]> {
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(apiUrl(`/api/auth/profile/${enc}/following?${q}`));
  if (!Array.isArray(raw)) return [];
  const out: PeopleListEntryDto[] = [];
  for (const x of raw) {
    const p = parsePeopleListEntry(x);
    if (p) out.push(p);
  }
  return out;
}

export async function apiFollowUser(username: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  await authPostJson(apiUrl(`/api/auth/profile/${enc}/follow`), {}, "Не удалось подписаться");
}

export async function apiUnfollowUser(username: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  const enc = encodeURIComponent(username.replace(/^@+/, "").toLowerCase());
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(apiUrl(`/api/auth/profile/${enc}/follow`), init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(apiUrl(`/api/auth/profile/${enc}/follow`), init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

export async function apiSendMessageFscpWire(
  toUserUuid: string,
  wire: string,
  voiceAssetUuids: string[] = []
): Promise<{ messageUuid: string; createdAt: string }> {
  const raw = (await authPostJson(
    apiUrl("/api/auth/messages"),
    { toUserUuid, encryptedForReceiver: wire, encryptedForSender: wire, voiceAssetUuids },
    ""
  )) as Record<string, unknown>;
  return {
    messageUuid: readStr(raw, ["messageUuid", "MessageUuid"]),
    createdAt: readStr(raw, ["createdAt", "CreatedAt"]),
  };
}
