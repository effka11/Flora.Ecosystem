import {
  ApiRequestError,
  clearSession,
  getAccessToken,
  isDevLocalOfflineSession,
  refreshSessionIfPossible,
  resolvePublicApiRoot,
} from "@/lib/auth";
import { floraNewUuid } from "@/lib/floraUuid";

function apiUrl(path: string): string {
  const root = resolvePublicApiRoot();
  return root ? `${root}${path}` : path;
}

export type NotificationDto = {
  notificationUuid: string;
  type: string;
  category: "social" | "developer";
  text: string;
  createdAt: string;
  isRead: boolean;
  postUuid?: string | null;
  commentUuid?: string | null;
};

const devNotifications: NotificationDto[] = [];

function parseNotification(raw: unknown): NotificationDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const notificationUuid = readStr(o, ["notificationUuid", "NotificationUuid"]);
  if (!notificationUuid) return null;
  const categoryRaw = readStr(o, ["category", "Category"]).toLowerCase();
  return {
    notificationUuid,
    type: readStr(o, ["type", "Type"]) || "default",
    category: categoryRaw === "developer" ? "developer" : "social",
    text: readStr(o, ["text", "Text"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    isRead: Boolean(o.isRead ?? o.IsRead),
    postUuid: readStr(o, ["postUuid", "PostUuid"]) || null,
    commentUuid: readStr(o, ["commentUuid", "CommentUuid"]) || null,
  };
}

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string") return v;
  }
  return "";
}

async function authJson(
  url: string,
  init: (token: string) => RequestInit,
): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    const detail = await r.text().catch(() => "");
    throw new ApiRequestError(r.status, detail || r.statusText);
  }
  if (r.status === 204) return null;
  return r.json().catch(() => ({}));
}

export async function apiListNotifications(input?: {
  category?: "all" | "social" | "developer";
  search?: string;
  skip?: number;
  take?: number;
}): Promise<NotificationDto[]> {
  if (isDevLocalOfflineSession()) {
    const category = input?.category ?? "all";
    const q = input?.search?.trim().toLowerCase() ?? "";
    return devNotifications.filter((n) => {
      if (category !== "all" && n.category !== category) return false;
      if (q && !n.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const params = new URLSearchParams();
  if (input?.category && input.category !== "all") params.set("category", input.category);
  if (input?.search?.trim()) params.set("search", input.search.trim());
  if (input?.skip) params.set("skip", String(input.skip));
  if (input?.take) params.set("take", String(input.take));
  const q = params.toString();
  const raw = await authJson(apiUrl(`/api/auth/notifications${q ? `?${q}` : ""}`), (token) => ({
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }));
  if (!Array.isArray(raw)) return [];
  const out: NotificationDto[] = [];
  for (const item of raw) {
    const parsed = parseNotification(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetNotificationsUnreadCount(): Promise<number> {
  if (isDevLocalOfflineSession()) {
    return devNotifications.filter((n) => !n.isRead).length;
  }
  const raw = (await authJson(apiUrl("/api/auth/notifications/unread-count"), (token) => ({
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }))) as Record<string, unknown>;
  const count = raw.unreadCount ?? raw.UnreadCount;
  return typeof count === "number" ? count : Number(count) || 0;
}

export async function apiMarkNotificationRead(notificationUuid: string): Promise<void> {
  if (isDevLocalOfflineSession()) {
    const row = devNotifications.find((n) => n.notificationUuid === notificationUuid);
    if (row) row.isRead = true;
    return;
  }
  await authJson(apiUrl(`/api/auth/notifications/${encodeURIComponent(notificationUuid)}/read`), (token) => ({
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  }));
}

/** Пометить все уведомления прочитанными (открытие вкладки «Уведомления»). */
export async function apiMarkAllNotificationsRead(): Promise<number> {
  if (isDevLocalOfflineSession()) {
    let marked = 0;
    for (const row of devNotifications) {
      if (!row.isRead) {
        row.isRead = true;
        marked += 1;
      }
    }
    return marked;
  }
  const raw = (await authJson(apiUrl("/api/auth/notifications/read"), (token) => ({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  }))) as Record<string, unknown>;
  const marked = raw.marked ?? raw.Marked;
  return typeof marked === "number" ? marked : Number(marked) || 0;
}

export async function apiDeleteAllNotifications(): Promise<number> {
  if (isDevLocalOfflineSession()) {
    const deleted = devNotifications.length;
    devNotifications.length = 0;
    return deleted;
  }
  const raw = (await authJson(apiUrl("/api/auth/notifications/all"), (token) => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }))) as Record<string, unknown>;
  const deleted = raw.deleted ?? raw.Deleted;
  return typeof deleted === "number" ? deleted : Number(deleted) || 0;
}

export async function apiDeleteNotifications(notificationUuids: string[]): Promise<number> {
  if (notificationUuids.length === 0) return 0;
  if (isDevLocalOfflineSession()) {
    const ids = new Set(notificationUuids);
    const before = devNotifications.length;
    for (let i = devNotifications.length - 1; i >= 0; i -= 1) {
      if (ids.has(devNotifications[i]!.notificationUuid)) devNotifications.splice(i, 1);
    }
    return before - devNotifications.length;
  }
  const raw = (await authJson(apiUrl("/api/auth/notifications"), (token) => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ notificationUuids }),
  }))) as Record<string, unknown>;
  const deleted = raw.deleted ?? raw.Deleted;
  return typeof deleted === "number" ? deleted : Number(deleted) || 0;
}

/** Dev-only: добавить демо-уведомление при офлайн-сессии. */
export function devPushNotification(input: Omit<NotificationDto, "notificationUuid" | "createdAt" | "isRead">): void {
  if (!isDevLocalOfflineSession()) return;
  devNotifications.unshift({
    ...input,
    notificationUuid: floraNewUuid(),
    createdAt: new Date().toISOString(),
    isRead: false,
  });
}
