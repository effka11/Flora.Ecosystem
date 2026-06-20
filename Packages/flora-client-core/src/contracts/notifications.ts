import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

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

export function parseNotification(raw: unknown, ctx?: ParseContext): NotificationDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const notificationUuid = readStr(o, ["notificationUuid", "NotificationUuid"], fb);
  if (!notificationUuid) return null;
  const categoryRaw = readStr(o, ["category", "Category"], fb).toLowerCase();
  return {
    notificationUuid,
    type: readStr(o, ["type", "Type"], fb) || "default",
    category: categoryRaw === "developer" ? "developer" : "social",
    text: readStr(o, ["text", "Text"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    isRead: readBool(o, ["isRead", "IsRead"], fb),
    postUuid: readStr(o, ["postUuid", "PostUuid"], fb) || null,
    commentUuid: readStr(o, ["commentUuid", "CommentUuid"], fb) || null,
  };
}

export function parseNotificationsList(raw: unknown, ctx?: ParseContext): NotificationDto[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => parseNotification(x, ctx)).filter((x): x is NotificationDto => x !== null);
  }
  const o = asRecord(raw);
  if (!o) return [];
  const itemsRaw = o.items ?? o.Items;
  if (!Array.isArray(itemsRaw)) return [];
  return itemsRaw.map((x) => parseNotification(x, ctx)).filter((x): x is NotificationDto => x !== null);
}

export function parseUnreadCount(raw: unknown, ctx?: ParseContext): number {
  const o = asRecord(raw);
  if (!o) return 0;
  const fb = ctx?.onPascalFallback;
  return readNum(o, ["count", "Count", "unreadCount", "UnreadCount"], fb) ?? 0;
}
