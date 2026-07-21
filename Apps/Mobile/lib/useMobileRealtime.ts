"use client";

import { connectSignalsStream } from "@flora/client-core/signals";
import { useEffect } from "react";
import { handleMessageRealtime, handleNotificationRealtime } from "@/lib/realtimeSync";

export function useMobileRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const stream = connectSignalsStream({
      enabled: () => enabled,
      onMessage: (signal) => {
        handleMessageRealtime(signal.conversationUuid);
      },
      onNotification: () => {
        // app_update: inbox + «Обновить» only — no background download.
        handleNotificationRealtime();
      },
    });

    return () => {
      stream.close();
    };
  }, [enabled]);
}
