import type { MsgConversationsPage } from "@flora/client-core/contracts";
import { scheduleConversationsPushRefresh } from "@/lib/conversationsPushCoalesce";
import { applyIncomingToConversations } from "@/lib/messageThreadOutgoing";
import { getQueryClientRef } from "@/lib/queryClientRef";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useSessionStore } from "@/stores/sessionStore";

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

export function handleMessageRealtime(
  conversationUuid?: string | null,
  kind?: "dm" | "groupChat" | null,
  incoming?: { senderUserUuid?: string | null; sentAt?: string | null },
): void {
  requestTabBadgesRefresh();
  const qc = getQueryClientRef();
  if (qc) {
    const conv = conversationUuid?.trim() ?? "";
    const viewerUserUuid = useSessionStore.getState().me?.userUuid?.trim() ?? "";
    const senderUserUuid = incoming?.senderUserUuid?.trim() ?? "";
    const sentAt = incoming?.sentAt?.trim() ?? "";
    if (conv && viewerUserUuid && senderUserUuid && sentAt) {
      qc.setQueryData<MsgConversationsPage>(["conversations"], (old) => {
        if (!old) return old;
        const items = applyIncomingToConversations(old.items, {
          conversationUuid: conv,
          senderUserUuid,
          sentAt,
          viewerUserUuid,
        });
        return items === old.items ? old : { ...old, items };
      });
    }
    scheduleConversationsPushRefresh(qc);
  }
  if (conversationUuid) {
    // Открытый тред сам делает refetch через subscribeMessageRealtime —
    // лишний invalidate даёт двойную работу. Без слушателей — пометить stale.
    if (messageListeners.size === 0) {
      const client = getQueryClientRef();
      if (client) {
        if (kind === "groupChat") {
          void client.invalidateQueries({ queryKey: ["group-messages", conversationUuid] });
        } else if (kind === "dm") {
          void client.invalidateQueries({ queryKey: ["messages", conversationUuid] });
        } else {
          void client.invalidateQueries({ queryKey: ["messages", conversationUuid] });
          void client.invalidateQueries({ queryKey: ["group-messages", conversationUuid] });
        }
      }
    }
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
  if (type === "notification" || type === "app_update") {
    handleNotificationRealtime();
    return;
  }

  const conversationUuid =
    typeof record.conversationUuid === "string" ? record.conversationUuid.trim() : "";
  const senderUserUuid =
    typeof record.senderUserUuid === "string" ? record.senderUserUuid.trim() : "";
  const sentAt = typeof record.sentAt === "string" ? record.sentAt.trim() : "";
  handleMessageRealtime(conversationUuid || null, null, {
    senderUserUuid: senderUserUuid || null,
    sentAt: sentAt || null,
  });
}
