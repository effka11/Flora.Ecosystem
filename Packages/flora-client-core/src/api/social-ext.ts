import { authFetch, authGetJson, authPostJson, authDelete } from "./client.js";
import { getApiClientConfig } from "./client.js";
import { parsePostComment, parsePostCommentsList } from "../contracts/comments.js";
import { parseRepostMutation } from "../contracts/engagement.js";
import { parsePeopleUsersList, type PeopleUserDto } from "../contracts/people.js";
import {
  parseCommunityList,
  parseCommunityListItem,
  parseProfileCommunitiesList,
  type CommunityListItemDto,
  type CommunitySearchDto,
  type ProfileCommunityDto,
} from "../contracts/communities.js";
import { parseProfilePostsList } from "../contracts/profile.js";
import { parsePublicProfile, type PublicProfileDto } from "../contracts/profile.js";
import { parseNotificationsList, parseUnreadCount } from "../contracts/notifications.js";
import { apiMarkAllNotificationsRead } from "./notifications.js";
import { ApiRequestError } from "./errors.js";
import type { PostCommentDto } from "../contracts/comments.js";
import type { ProfilePostDto } from "../contracts/profile.js";

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiGetProfile(username: string): Promise<PublicProfileDto> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  const raw = await authGetJson(`/api/auth/profile/${enc}`);
  const profile = parsePublicProfile(raw, ctx());
  if (!profile) throw new ApiRequestError(404, "Профиль не найден");
  return profile;
}

export async function apiGetProfilePosts(
  username: string,
  options?: { skip?: number; take?: number },
): Promise<ProfilePostDto[]> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 30;
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(`/api/auth/profile/${enc}/posts?${q}`);
  return parseProfilePostsList(raw, ctx());
}

export async function apiSearchUsers(query: string, take = 20, skip = 0): Promise<PeopleUserDto[]> {
  const params = new URLSearchParams({ q: query.trim(), skip: String(skip), take: String(take) });
  const raw = await authGetJson(`/api/auth/users/search?${params}`);
  return parsePeopleUsersList(raw, ctx());
}

export async function apiGetRecommendedUsers(take = 20): Promise<PeopleUserDto[]> {
  const raw = await authGetJson(`/api/auth/users/recommended?take=${take}`);
  return parsePeopleUsersList(raw, ctx());
}

export async function apiGetProfileFollowers(
  username: string,
  options?: { skip?: number; take?: number },
): Promise<PeopleUserDto[]> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 50;
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(`/api/auth/profile/${enc}/followers?${q}`);
  return parsePeopleUsersList(raw, ctx());
}

export async function apiGetProfileFollowing(
  username: string,
  options?: { skip?: number; take?: number },
): Promise<PeopleUserDto[]> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 50;
  const q = new URLSearchParams({ skip: String(skip), take: String(take) });
  const raw = await authGetJson(`/api/auth/profile/${enc}/following?${q}`);
  return parsePeopleUsersList(raw, ctx(), true);
}

export async function apiFollowUser(username: string): Promise<void> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  await authPostJson(`/api/auth/profile/${enc}/follow`, {});
}

export async function apiUnfollowUser(username: string): Promise<void> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  await authDelete(`/api/auth/profile/${enc}/follow`);
}

export async function apiGetNotifications(cursor?: string) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const raw = await authGetJson(`/api/auth/notifications${q}`);
  return parseNotificationsList(raw, ctx());
}

export async function apiGetNotificationsUnreadCount(): Promise<number> {
  const raw = await authGetJson("/api/auth/notifications/unread-count");
  return parseUnreadCount(raw, ctx());
}

export async function apiMarkNotificationsRead(): Promise<void> {
  await apiMarkAllNotificationsRead();
}

export async function apiGetCommunities(): Promise<CommunityListItemDto[]> {
  const raw = await authGetJson("/api/auth/communities");
  return parseCommunityList(raw, ctx());
}

export async function apiGetOwnedCommunities(): Promise<CommunityListItemDto[]> {
  const raw = await authGetJson("/api/auth/communities/owned");
  return parseCommunityList(raw, ctx());
}

export async function apiGetRecommendedCommunities(take = 30): Promise<CommunityListItemDto[]> {
  const raw = await authGetJson(`/api/auth/communities/recommended?take=${take}`);
  return parseCommunityList(raw, ctx());
}

export async function apiListProfileCommunities(username: string): Promise<ProfileCommunityDto[]> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, "").toLowerCase());
  if (!enc) return [];
  const raw = await authGetJson(`/api/auth/profile/${enc}/communities`);
  return parseProfileCommunitiesList(raw, ctx());
}

export async function apiSearchCommunities(
  query: string,
  options?: { skip?: number; take?: number },
): Promise<CommunitySearchDto[]> {
  const q = query.trim();
  if (!q) return [];
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 40;
  const params = new URLSearchParams({ q, skip: String(skip), take: String(take) });
  const raw = await authGetJson(`/api/auth/communities/search?${params}`);
  if (!Array.isArray(raw)) return [];
  const out: CommunitySearchDto[] = [];
  for (const item of raw) {
    const parsed = parseCommunityListItem(item, ctx());
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetCommunityBySlug(slug: string) {
  const enc = encodeURIComponent(slug.trim().toLowerCase());
  return authGetJson(`/api/auth/communities/slug/${enc}`);
}

export async function apiCreateCommunity(body: Record<string, unknown>) {
  return authPostJson("/api/auth/communities", body);
}

export async function apiJoinCommunity(id: string): Promise<void> {
  await authPostJson(`/api/auth/communities/${encodeURIComponent(id)}/join`, {});
}

export async function apiLeaveCommunity(id: string): Promise<void> {
  const r = await authFetch(`/api/auth/communities/${encodeURIComponent(id)}/join`, { method: "DELETE" });
  if (!r.ok) throw new ApiRequestError(r.status, await r.text());
}

export async function apiRepostPost(
  postUuid: string,
): Promise<{ reposted: boolean; repostsCount: number }> {
  const id = encodeURIComponent(postUuid.trim());
  const raw = await authPostJson(`/api/auth/posts/${id}/repost`, {});
  return parseRepostMutation(raw);
}

export async function apiUnrepostPost(
  postUuid: string,
): Promise<{ reposted: boolean; repostsCount: number }> {
  const id = encodeURIComponent(postUuid.trim());
  const r = await authFetch(`/api/auth/posts/${id}/repost`, { method: "DELETE" });
  if (!r.ok) throw new ApiRequestError(r.status, await r.text());
  const raw = await r.json().catch(() => ({}));
  return parseRepostMutation(raw);
}

export async function apiGetPostComments(
  postUuid: string,
  options?: { skip?: number; take?: number; includeReplies?: boolean },
): Promise<PostCommentDto[]> {
  const skip = options?.skip ?? 0;
  const take = options?.take ?? 50;
  const includeReplies = options?.includeReplies ?? true;
  const q = new URLSearchParams({
    skip: String(skip),
    take: String(take),
    includeReplies: includeReplies ? "true" : "false",
  });
  const raw = await authGetJson(
    `/api/auth/posts/${encodeURIComponent(postUuid.trim())}/comments?${q}`,
  );
  return parsePostCommentsList(raw, ctx());
}

export async function apiAddPostComment(
  postUuid: string,
  content: string,
  parentCommentUuid?: string | null,
): Promise<PostCommentDto> {
  const trimmed = content.trim();
  const body: Record<string, unknown> = { content: trimmed };
  const parentId = parentCommentUuid?.trim();
  if (parentId) body.parentCommentUuid = parentId;
  const raw = await authPostJson(
    `/api/auth/posts/${encodeURIComponent(postUuid.trim())}/comments`,
    body,
  );
  const parsed = parsePostComment(raw, ctx());
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiGetPostDrafts() {
  return authGetJson("/api/auth/post-drafts");
}

export async function apiSavePostDraft(body: Record<string, unknown>) {
  return authPostJson("/api/auth/post-drafts", body);
}

export async function apiGetBlocklist() {
  return authGetJson("/api/auth/me/blocks");
}

export async function apiBlockUser(username: string): Promise<void> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, ""));
  if (!enc) throw new ApiRequestError(400, "Укажите юзернейм.");
  await authPostJson(`/api/auth/me/blocks/${enc}`, {});
}

export async function apiUnblockUser(username: string): Promise<void> {
  const enc = encodeURIComponent(username.trim().replace(/^@+/, ""));
  if (!enc) throw new ApiRequestError(400, "Укажите юзернейм.");
  const r = await authFetch(`/api/auth/me/blocks/${enc}`, { method: "DELETE" });
  if (!r.ok) throw new ApiRequestError(r.status, await r.text());
}
