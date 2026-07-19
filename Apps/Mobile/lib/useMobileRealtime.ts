"use client";

import { connectSignalsStream } from "@flora/client-core/signals";
import { useEffect } from "react";
import { runAutoUpdateFromRealtime } from "@/lib/apkUpdate/autoUpdate";
import { handleMessageRealtime, handleNotificationRealtime } from "@/lib/realtimeSync";

export function useMobileRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const stream = connectSignalsStream({
      enabled: () => enabled,
      onMessage: (signal) => {
        handleMessageRealtime(signal.conversationUuid);
      },
      onNotification: (signal) => {
        handleNotificationRealtime();
        if (signal.type === "app_update" && signal.update) {
          void runAutoUpdateFromRealtime({
            version: signal.update.version,
            versionCode: signal.update.versionCode,
            apkUrl: signal.update.apkUrl,
            sha256: signal.update.sha256,
            sizeBytes: signal.update.sizeBytes,
            notificationUuid: signal.notificationUuid,
            text: signal.text,
          }).catch(() => undefined);
        }
      },
    });

    return () => {
      stream.close();
    };
  }, [enabled]);
}
