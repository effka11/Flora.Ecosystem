"use client";

import { connectSignalsStream } from "@flora/client-core/signals";
import { useEffect } from "react";
import { invalidateNotificationsCache } from "@/lib/dashboardPreload";
import { initWebClientCore } from "@/lib/fscp/clientCore";
import { notifyMessagesUnreadChanged } from "@/lib/messagingApi";
import { notifyNotificationsChanged } from "@/lib/realtimeEvents";
import { resolveRealtimeStreamApiRoot } from "@/lib/realtimeApi";

export function useDashboardRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let stream: ReturnType<typeof connectSignalsStream> | null = null;
    let cancelled = false;

    (async () => {
      await initWebClientCore();
      if (cancelled) return;

      stream = connectSignalsStream({
        enabled: () => enabled && !cancelled,
        streamBaseUrl: resolveRealtimeStreamApiRoot() || undefined,
        onMessage: (signal) => {
          notifyMessagesUnreadChanged({
            conversationUuid: signal.conversationUuid,
            senderUserUuid: signal.senderUserUuid,
          });
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
      stream?.close();
    };
  }, [enabled]);
}
