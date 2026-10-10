"use client";

import { connectSignalsStream } from "@flora/client-core/signals";
import {
  sharedPresenceStore,
  startPresenceHeartbeat,
} from "@flora/client-core/presence";
import { useEffect } from "react";
import { AppState } from "react-native";
import { notifyReadChanged } from "@/lib/readEvents";
import { dismissSocialPushNotifications } from "@/lib/pushNotifications";
import { handleMessageRealtime, handleNotificationRealtime } from "@/lib/realtimeSync";
import { notifyTypingChanged } from "@/lib/typingEvents";

export function useMobileRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const heartbeat = startPresenceHeartbeat({
      enabled: () => enabled && !cancelled,
      isVisible: () => AppState.currentState === "active",
    });

    const appSub = AppState.addEventListener("change", () => {
      heartbeat.onVisibilityChange();
    });

    const stream = connectSignalsStream({
      enabled: () => enabled && !cancelled,
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
      onRead: (signal) => {
        notifyReadChanged(signal);
      },
      onOpen: () => {
        handleMessageRealtime(null);
        handleNotificationRealtime();
        void sharedPresenceStore.resyncSnapshots().catch(() => {});
      },
      onMessage: (signal) => {
        handleMessageRealtime(signal.conversationUuid, signal.kind, {
          senderUserUuid: signal.senderUserUuid,
          sentAt: signal.sentAt,
        });
      },
      onNotification: (signal) => {
        handleNotificationRealtime({ action: "upsert", signal });
        // app_update: inbox + «Обновить» only. Do not start a download from SSE.
      },
      onNotificationRemoved: (signal) => {
        handleNotificationRealtime({ action: "remove", notificationUuid: signal.notificationUuid });
        const key = signal.groupKey ?? signal.notificationUuid;
        if (key) void dismissSocialPushNotifications(key);
      },
    });

    return () => {
      cancelled = true;
      appSub.remove();
      heartbeat.stop();
      sharedPresenceStore.setConnectionId(null);
      stream.close();
    };
  }, [enabled]);
}
