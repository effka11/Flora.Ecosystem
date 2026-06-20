import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { getQueryClientRef } from "@/lib/queryClientRef";

const messageListeners = new Set<(conversationUuid: string) => void>();
const notificationListeners = new Set<() => void>();

export function subscribeMessageRealtime(listener: (conversationUuid: string) => void): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export function subscribeNotificationRealtime(listener: () => void): () => void {
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

function asRecord(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}

export function handleMessageRealtime(conversationUuid?: string | null): void {
  requestTabBadgesRefresh();
  const qc = getQueryClientRef();
  if (qc) {
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    if (conversationUuid) {
      void qc.invalidateQueries({ queryKey: ["messages", conversationUuid] });
    }
  }
  if (conversationUuid) {
    messageListeners.forEach((listener) => listener(conversationUuid));
  }
}

export function handleNotificationRealtime(): void {
  requestTabBadgesRefresh();
  const qc = getQueryClientRef();
  if (qc) {
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  }
  notificationListeners.forEach((listener) => listener());
}

export function handlePushNotificationData(data: unknown): void {
  const record = asRecord(data);
  if (!record) {
    requestTabBadgesRefresh();
    return;
  }

  const type = typeof record.type === "string" ? record.type : "message";
  if (type === "notification") {
    handleNotificationRealtime();
    return;
  }

  const conversationUuid =
    typeof record.conversationUuid === "string" ? record.conversationUuid.trim() : "";
  handleMessageRealtime(conversationUuid || null);
}
