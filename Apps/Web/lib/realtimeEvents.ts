export const NOTIFICATIONS_CHANGED_EVENT = "flora:notifications-changed";

export type MessagesChangedDetail = {
  conversationUuid?: string;
  senderUserUuid?: string;
};

export type NotificationsChangedDetail = {
  notificationUuid?: string;
  type?: string;
  category?: string;
};

export function notifyNotificationsChanged(detail?: NotificationsChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail }));
}
