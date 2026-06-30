import { authDelete, authFetch, authGetJson, authPostJson } from "./client.js";
import { getApiClientConfig } from "./client.js";
import { parseLikeMutation, parseViewMutation } from "../contracts/engagement.js";
import { parseFeedPage, parseHasNewFeed } from "../contracts/feed.js";
import { ApiRequestError } from "./errors.js";

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
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

export async function apiCreatePost(body: {
  text: string;
  communityUuid?: string | null;
}) {
  return authPostJson("/api/auth/posts", body);
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
