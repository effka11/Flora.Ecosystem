import type { MsgConversationsPage } from "@flora/client-core/contracts";
import type { NotificationRealtimeSignal } from "@flora/client-core/signals";
import { scheduleConversationsPushRefresh } from "@/lib/conversationsPushCoalesce";
import { applyIncomingToConversations } from "@/lib/messageThreadOutgoing";
import {
  insertNotificationIntoLists,
  removeNotificationFromLists,
} from "@/lib/notificationsListPatch";
import { scheduleNotificationsPushRefresh } from "@/lib/notificationsPushCoalesce";
import { getQueryClientRef } from "@/lib/queryClientRef";
import { invalidateThreadForRealtime } from "@/lib/threadRealtimeInvalidate";
import { requestTabBadgesRefresh } from "@/lib/useTabBadges";
import { useSessionStore } from "@/stores/sessionStore";

export type NotificationRealtimeEvent =
  | { action: "upsert"; signal: NotificationRealtimeSignal }
  | { action: "remove"; notificationUuid: string };

const messageListeners = new Set<(conversationUuid: string) => void>();

export function subscribeMessageRealtime(listener: (conversationUuid: string) => void): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
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
    // Всегда пометить страницу устаревшей, без refetch неактивного query.
    // Открытый тред обновляется сам через subscribeMessageRealtime.
    const client = getQueryClientRef();
    if (client) invalidateThreadForRealtime(client, conversationUuid, kind);
    messageListeners.forEach((listener) => listener(conversationUuid));
  }
}

/**
 * Без события (FCM, onOpen) — только coalesce: строки у пуша нет, а немедленный
 * invalidate дал бы GET на каждый сигнал.
 */
export function handleNotificationRealtime(event?: NotificationRealtimeEvent): void {
  requestTabBadgesRefresh();
  const qc = getQueryClientRef();
  if (!qc) return;
  if (event?.action === "upsert") {
    insertNotificationIntoLists(qc, event.signal);
  } else if (event?.action === "remove") {
    removeNotificationFromLists(qc, event.notificationUuid);
  }
  scheduleNotificationsPushRefresh(qc);
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
