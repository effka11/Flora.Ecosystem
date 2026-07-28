export const NOTIFICATIONS_CHANGED_EVENT = "flora:notifications-changed";
export const TYPING_CHANGED_EVENT = "flora:typing-changed";

export type MessagesChangedDetail = {
  conversationUuid?: string;
  senderUserUuid?: string;
};

export type NotificationsChangedDetail = {
  notificationUuid?: string;
  type?: string;
  category?: string;
};

export type TypingChangedDetail = {
  conversationUuid: string;
  userUuid: string;
  isTyping: boolean;
};

export function notifyNotificationsChanged(detail?: NotificationsChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail }));
}

export function notifyTypingChanged(detail: TypingChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TYPING_CHANGED_EVENT, { detail }));
}
