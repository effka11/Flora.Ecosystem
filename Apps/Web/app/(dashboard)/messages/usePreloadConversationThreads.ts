"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FscpLocalMaterial } from "@/lib/fscp";
import { preloadConversationThreads } from "@/lib/conversationThreadsCache";
import { preloadConversationThreadMedia } from "@/lib/preloadConversationThreadMedia";
import type { ConversationListItemDto } from "@/lib/socialApi";

const TOP_THREAD_PRELOAD_COUNT = 4;

export function usePreloadConversationThreads(
  viewerNorm: string,
  conversations: ConversationListItemDto[],
  options?: {
    viewerUuid?: string;
    fscpMaterial?: FscpLocalMaterial | null;
  },
) {
  const preloadedTopRef = useRef("");
  const viewerUuid = options?.viewerUuid?.trim() ?? "";
  const agreementPrivateKey = options?.fscpMaterial?.agreementPrivateKey;

  const topPeerUuids = useMemo(
    () => conversations.slice(0, TOP_THREAD_PRELOAD_COUNT).map((c) => c.otherUserUuid),
    [conversations],
  );

  const preloadPeerMedia = useCallback(
    (peerUuid: string) => {
      if (!viewerNorm || !peerUuid.trim() || !viewerUuid || !agreementPrivateKey) return;
      preloadConversationThreadMedia(viewerNorm, peerUuid, viewerUuid, agreementPrivateKey);
    },
    [viewerNorm, viewerUuid, agreementPrivateKey],
  );

  useEffect(() => {
    if (!viewerNorm || topPeerUuids.length === 0) return;
    const signature = topPeerUuids.join("|");
    if (preloadedTopRef.current === signature) return;
    preloadedTopRef.current = signature;

    const run = () => {
      preloadConversationThreads(viewerNorm, topPeerUuids);
      for (const peerUuid of topPeerUuids) preloadPeerMedia(peerUuid);
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 3_000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 100);
    return () => clearTimeout(t);
  }, [viewerNorm, topPeerUuids, preloadPeerMedia]);

  const prefetchPeerThread = useCallback(
    (peerUuid: string) => {
      if (!viewerNorm || !peerUuid.trim()) return;
      preloadConversationThreads(viewerNorm, [peerUuid]);
      preloadPeerMedia(peerUuid);
    },
    [viewerNorm, preloadPeerMedia],
  );

  return { prefetchPeerThread };
}
