"use client";

import { useEffect, useRef } from "react";
import type { FscpMessagePlaintext } from "@/lib/fscp";
import { preloadMessageMediaFromPlaintexts } from "@/lib/messageMediaCache";

/** Предзагрузка медиа из уже расшифрованных сообщений открытого треда. */
export function usePreloadThreadMessageMedia(decryptedById: Record<string, FscpMessagePlaintext>): void {
  const prevSignatureRef = useRef("");

  useEffect(() => {
    const keys = Object.keys(decryptedById).sort();
    if (keys.length === 0) return;
    const signature = keys.join("|");
    if (prevSignatureRef.current === signature) return;
    prevSignatureRef.current = signature;

    const run = () => preloadMessageMediaFromPlaintexts(Object.values(decryptedById));

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 2_000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 0);
    return () => clearTimeout(t);
  }, [decryptedById]);
}
