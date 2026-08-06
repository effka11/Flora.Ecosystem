/**
 * Wire recognition for aggregated social FCM tray slots (group_key / inboxType / dismiss).
 * Not domain logic — Apps use this instead of hard-coding Notifications vocabulary.
 */

export const SOCIAL_FOLLOW_PUSH_TAG = "follow";
export const SOCIAL_LIKE_PUSH_TAG_PREFIX = "like:";

export function isSocialNotificationPushTag(tag: string | null | undefined): boolean {
  const t = (tag ?? "").trim().toLowerCase();
  return t === SOCIAL_FOLLOW_PUSH_TAG || t.startsWith(SOCIAL_LIKE_PUSH_TAG_PREFIX);
}

export function isSocialNotificationInboxType(inboxType: string | null | undefined): boolean {
  const t = (inboxType ?? "").trim().toLowerCase();
  return t === "like" || t === "follow";
}

/** True when FCM data belongs to a social like/follow tray slot. */
export function isSocialTrayPushData(data: Record<string, unknown> | undefined | null): boolean {
  if (!data) return false;
  const type = typeof data.type === "string" ? data.type.trim().toLowerCase() : "";
  if (type !== "notification" && type !== "notification_dismiss") return false;
  const tag = typeof data.tag === "string" ? data.tag : "";
  const inboxType = typeof data.inboxType === "string" ? data.inboxType : "";
  return isSocialNotificationPushTag(tag) || isSocialNotificationInboxType(inboxType);
}
