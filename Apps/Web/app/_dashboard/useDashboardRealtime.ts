"use client";

import { connectSignalsStream } from "@flora/client-core/signals";
import {
  sharedPresenceStore,
  startPresenceHeartbeat,
} from "@flora/client-core/presence";
import { useEffect } from "react";
import {
  conversationsCache,
  invalidateNotificationsCache,
} from "@/lib/dashboardPreload";
import { initWebClientCore } from "@/lib/fscp/clientCore";
import { notifyMessagesUnreadChanged } from "@/lib/messagingApi";
import { notifyNotificationsChanged, notifyTypingChanged } from "@/lib/realtimeEvents";
import { resolveRealtimeStreamApiRoot } from "@/lib/realtimeApi";

export function useDashboardRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let stream: ReturnType<typeof connectSignalsStream> | null = null;
    let cancelled = false;
    const heartbeat = startPresenceHeartbeat({
      enabled: () => enabled && !cancelled,
      isVisible: () =>
        typeof document === "undefined" ? true : document.visibilityState === "visible",
    });

    const onVis = () => heartbeat.onVisibilityChange();
    document.addEventListener("visibilitychange", onVis);

    (async () => {
      await initWebClientCore();
      if (cancelled) return;

      stream = connectSignalsStream({
        enabled: () => enabled && !cancelled,
        streamBaseUrl: resolveRealtimeStreamApiRoot() || undefined,
        onConnected: (signal) => {
          sharedPresenceStore.setConnectionId(signal.connectionId);
          void sharedPresenceStore.resyncSnapshots().catch(() => {});
        },
        onPresence: (signal) => {
          sharedPresenceStore.applySnapshot({
            userUuid: signal.userUuid,
            isOnline: signal.isOnline,
            lastSeenAt: signal.lastSeenAt,
          });
        },
        onTyping: (signal) => {
          notifyTypingChanged(signal);
        },
        onMessage: (signal) => {
          conversationsCache.invalidate();
          notifyMessagesUnreadChanged({
            conversationUuid: signal.conversationUuid,
            senderUserUuid: signal.senderUserUuid,
          });
        },
        onOpen: () => {
          conversationsCache.invalidate();
          notifyMessagesUnreadChanged();
          void sharedPresenceStore.resyncSnapshots().catch(() => {});
        },
        onNotification: (signal) => {
          invalidateNotificationsCache();
          notifyNotificationsChanged({
            notificationUuid: signal.notificationUuid,
            type: signal.type,
            category: signal.category,
          });
        },
      });
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      heartbeat.stop();
      sharedPresenceStore.setConnectionId(null);
      stream?.close();
    };
  }, [enabled]);
}
