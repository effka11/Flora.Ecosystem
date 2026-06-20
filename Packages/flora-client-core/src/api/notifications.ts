import { authGetJson, authPostJson } from "./client.js";
import { getApiClientConfig } from "./client.js";
import { asRecord, readNum } from "../contracts/parse.js";
import { parseNotificationsList, parseUnreadCount } from "../contracts/notifications.js";

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiListNotifications(input?: {
  category?: "all" | "social" | "developer";
  search?: string;
  skip?: number;
  take?: number;
}) {
  const params = new URLSearchParams();
  if (input?.category && input.category !== "all") params.set("category", input.category);
  if (input?.search?.trim()) params.set("search", input.search.trim());
  if (input?.skip) params.set("skip", String(input.skip));
  if (input?.take) params.set("take", String(input.take));
  const q = params.toString();
  const raw = await authGetJson(`/api/auth/notifications${q ? `?${q}` : ""}`);
  return parseNotificationsList(raw, ctx());
}

export async function apiNotificationsUnreadCount(): Promise<number> {
  const raw = await authGetJson("/api/auth/notifications/unread-count");
  return parseUnreadCount(raw, ctx());
}

export async function apiMarkNotificationRead(notificationUuid: string): Promise<void> {
  const { authFetch } = await import("./client.js");
  const r = await authFetch(`/api/auth/notifications/${notificationUuid}/read`, {
    method: "PATCH",
  });
  if (!r.ok) {
    const { ApiRequestError } = await import("./errors.js");
    throw new ApiRequestError(r.status, await r.text());
  }
}

/** Пометить все уведомления прочитанными (открытие вкладки «Уведомления»). */
export async function apiMarkAllNotificationsRead(): Promise<number> {
  const raw = await authPostJson("/api/auth/notifications/read", {});
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  return readNum(o, ["marked", "Marked"], fb) ?? 0;
}

export async function apiDeleteAllNotifications(): Promise<number> {
  const { authFetch } = await import("./client.js");
  const r = await authFetch("/api/auth/notifications/all", { method: "DELETE" });
  if (!r.ok) {
    const { ApiRequestError } = await import("./errors.js");
    throw new ApiRequestError(r.status, await r.text());
  }
  const raw = await r.json().catch(() => ({}));
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const deleted = o.deleted ?? o.Deleted;
  return typeof deleted === "number" ? deleted : Number(deleted) || 0;
}
