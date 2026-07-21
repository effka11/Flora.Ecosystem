import {
  authDelete,
  authFetch,
  authGetJson,
  authPatchJson,
  authPostForm,
  authPostJson,
} from "./client.js";
import { getApiClientConfig } from "./client.js";
import { asRecord, readStr } from "../contracts/parse.js";
import { parseLikeMutation, parseViewMutation } from "../contracts/engagement.js";
import {
  parseDismissedCommunities,
  parseFeedPage,
  parseFeedSettings,
  parseHasNewFeed,
  parseHiddenFeedAuthors,
  type DismissedCommunityDto,
  type FeedSettingsDto,
  type HiddenFeedAuthorDto,
} from "../contracts/feed.js";
import { ApiRequestError } from "./errors.js";

declare const __DEV__: boolean | undefined;

/** Синхронно с ImportedSocialController / Web postContentLimits. */
export const MAX_POST_CONTENT_LENGTH = 2000;
export const MAX_POST_IMAGES = 10;
export const MAX_POST_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_POST_VIDEO_BYTES = 200 * 1024 * 1024;

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export function clampPostContent(text: string): string {
  if (text.length <= MAX_POST_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_POST_CONTENT_LENGTH);
}

export async function apiGetFeed(input?: {
  kind?: "recommendations" | "subscriptions";
  cursor?: string;
  refresh?: boolean;
  take?: number;
}) {
  const kind = input?.kind ?? "recommendations";
  const take = Math.min(Math.max(input?.take ?? 30, 1), 50);
  const params = new URLSearchParams({ take: String(take) });
  if (input?.cursor) params.set("cursor", input.cursor);
  if (kind === "subscriptions") params.set("kind", "subscriptions");
  if (input?.refresh === true && kind === "recommendations" && !input.cursor) {
    params.set("refresh", "true");
  }
  const raw = await authGetJson(`/api/auth/feed?${params}`);
  return parseFeedPage(raw, ctx());
}

export async function apiFeedHasNew(since?: string): Promise<boolean> {
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  const raw = await authGetJson(`/api/auth/feed/has-new${q}`);
  return parseHasNewFeed(raw, ctx());
}

// ---------------------------------------------------------------------------
// §User Controls (FIRA-F v1.1): настройки ленты + негативный фидбек
// ---------------------------------------------------------------------------

export async function apiGetFeedSettings(): Promise<FeedSettingsDto> {
  const raw = await authGetJson("/api/auth/me/feed-settings");
  return parseFeedSettings(raw, ctx());
}

/** PATCH-семантика: передавайте только изменённые поля. */
export async function apiUpdateFeedSettings(
  patch: Partial<Omit<FeedSettingsDto, "updatedAt">>,
): Promise<FeedSettingsDto> {
  const raw = await authPatchJson("/api/auth/me/feed-settings", patch);
  return parseFeedSettings(raw, ctx());
}

/** «Не интересно»: пост навсегда исключается из рекомендаций, автор получает мягкий штраф. */
export async function apiMarkPostNotInterested(postUuid: string): Promise<void> {
  const id = encodeURIComponent(postUuid.trim());
  await authPostJson(`/api/auth/posts/${id}/not-interested`, {});
}

/** Отмена «не интересно» (undo в UI). */
export async function apiUnmarkPostNotInterested(postUuid: string): Promise<void> {
  const id = encodeURIComponent(postUuid.trim());
  await authDelete(`/api/auth/posts/${id}/not-interested`);
}

/** Сброс всех отметок «не интересно» (страница настроек). */
export async function apiClearNotInterested(): Promise<void> {
  await authDelete("/api/auth/me/feed/not-interested");
}

/** «Скрыть автора»: его посты пропадают из рекомендаций (подписки не затрагиваются). */
export async function apiHideFeedAuthor(authorUuid: string): Promise<void> {
  const id = encodeURIComponent(authorUuid.trim());
  await authPostJson(`/api/auth/feed/authors/${id}/hide`, {});
}

export async function apiUnhideFeedAuthor(authorUuid: string): Promise<void> {
  const id = encodeURIComponent(authorUuid.trim());
  await authDelete(`/api/auth/feed/authors/${id}/hide`);
}

export async function apiGetHiddenFeedAuthors(): Promise<HiddenFeedAuthorDto[]> {
  const raw = await authGetJson("/api/auth/me/feed/hidden-authors");
  return parseHiddenFeedAuthors(raw, ctx());
}

/** «Не интересно» для сообщества: исключение из рекомендаций FIRA-C. */
export async function apiDismissCommunity(communityId: string): Promise<void> {
  const id = encodeURIComponent(communityId.trim());
  await authPostJson(`/api/auth/communities/${id}/dismiss`, {});
}

export async function apiUndismissCommunity(communityId: string): Promise<void> {
  const id = encodeURIComponent(communityId.trim());
  await authDelete(`/api/auth/communities/${id}/dismiss`);
}

export async function apiGetDismissedCommunities(): Promise<DismissedCommunityDto[]> {
  const raw = await authGetJson("/api/auth/me/feed/dismissed-communities");
  return parseDismissedCommunities(raw, ctx());
}

/** «Не интересно» для рекомендованного пользователя (FIRA-P). */
export async function apiDismissRecommendedUser(userUuid: string): Promise<void> {
  const id = encodeURIComponent(userUuid.trim());
  await authPostJson(`/api/auth/users/${id}/dismiss`, {});
}

export async function apiUndismissRecommendedUser(userUuid: string): Promise<void> {
  const id = encodeURIComponent(userUuid.trim());
  await authDelete(`/api/auth/users/${id}/dismiss`);
}

export async function apiCreatePost(input: {
  content?: string | null;
  communityId?: string | null;
}): Promise<{ postUuid: string }> {
  const content = clampPostContent((input.content ?? "").trim());
  const body: Record<string, unknown> = { content };
  const communityId = input.communityId?.trim();
  if (communityId) body.communityId = communityId;
  const raw = await authPostJson("/api/auth/posts", body);
  const o = asRecord(raw) ?? {};
  const postUuid = readStr(o, ["postUuid", "PostUuid"], ctx().onPascalFallback);
  if (!postUuid) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return { postUuid };
}

/** Multipart: поле `files` (JPEG/PNG/WebP). На RN предпочтительнее upload через expo-file-system. */
export async function apiUploadPostImages(
  postUuid: string,
  files: Array<{ blob: Blob; fileName: string }>,
): Promise<string[]> {
  const id = postUuid.trim();
  if (!id || files.length === 0) return [];
  const form = new FormData();
  for (const file of files) {
    form.append("files", file.blob, file.fileName);
  }
  const raw = await authPostForm(`/api/auth/posts/${encodeURIComponent(id)}/images`, form);
  const o = asRecord(raw) ?? {};
  const uuidsRaw = o.imageUuids ?? o.ImageUuids;
  if (!Array.isArray(uuidsRaw)) return [];
  const out: string[] = [];
  for (const item of uuidsRaw) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

/** Multipart: поле `file` (MP4/MOV/WebM/MKV, до 200 МБ). */
export async function apiUploadPostVideo(
  postUuid: string,
  file: { blob: Blob; fileName: string },
): Promise<{ videoUuid: string; status: string }> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  const form = new FormData();
  form.append("file", file.blob, file.fileName);
  const raw = await authPostForm(`/api/auth/posts/${encodeURIComponent(id)}/video`, form);
  const o = asRecord(raw) ?? {};
  const videoUuid = readStr(o, ["videoUuid", "VideoUuid"], ctx().onPascalFallback);
  if (!videoUuid) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return {
    videoUuid,
    status: readStr(o, ["status", "Status"], ctx().onPascalFallback) || "processing",
  };
}

export async function apiDeletePost(postUuid: string): Promise<void> {
  const id = postUuid.trim();
  if (!id) throw new ApiRequestError(400, "Не указан пост.");
  await authDelete(`/api/auth/posts/${encodeURIComponent(id)}`);
}

export async function apiLikePost(
  postUuid: string,
): Promise<{ liked: boolean; likesCount: number }> {
  const id = encodeURIComponent(postUuid.trim());
  const raw = await authPostJson(`/api/auth/posts/${id}/like`, {});
  return parseLikeMutation(raw);
}

export async function apiUnlikePost(
  postUuid: string,
): Promise<{ liked: boolean; likesCount: number }> {
  const id = encodeURIComponent(postUuid.trim());
  const r = await authFetch(`/api/auth/posts/${id}/like`, { method: "DELETE" });
  if (!r.ok) throw new ApiRequestError(r.status, await r.text());
  const raw = await r.json().catch(() => ({}));
  return parseLikeMutation(raw);
}

export async function apiRecordPostView(postUuid: string): Promise<{ viewsCount: number } | null> {
  const id = postUuid.trim();
  if (!id) return null;
  const enc = encodeURIComponent(id);
  const r = await authFetch(`/api/auth/posts/${enc}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  // Старые сборки API могут не иметь POST /view — не бросаем, чтобы не засорять RN LogBox.
  if (r.status === 405 || r.status === 404) return null;
  if (!r.ok) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[api] POST view failed", r.status, id);
    }
    return null;
  }
  const raw = await r.json().catch(() => ({}));
  return parseViewMutation(raw);
}
