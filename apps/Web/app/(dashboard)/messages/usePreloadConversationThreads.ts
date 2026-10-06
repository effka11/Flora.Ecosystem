"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { FscpLocalMaterial } from "@/lib/fscp";
import { preloadConversationThreads } from "@/lib/conversationThreadsCache";
import { refreshIdleCiphertext } from "@/lib/dashboardPreload";
import {
  isPlaintextSessionCacheEnabled,
  pinIdlePlaintextThreads,
  plaintextThreadKey,
} from "@/lib/messagePlaintextSessionCache";
import { isThreadWarmBlocked, scheduleHoverThreadWarm, cancelHoverThreadWarm } from "@/lib/threadWarmIntent";
import {
  THREAD_DECRYPT_SLICE,
  THREAD_OPEN_PLAINTEXT_TAIL,
  warmCachedDmPlaintextTail,
  warmCachedGroupPlaintextTail,
  warmIdlePlaintextThreads,
} from "@/lib/threadPlaintextWarm";
import type { ConversationListItemDto } from "@/lib/socialApi";

/** Top of the list, then unread rows, capped so the plaintext LRU can hold the whole set. */
export const IDLE_DM_WARM_LIMIT = 8;
export const IDLE_GROUP_WARM_LIMIT = 2;
export const IDLE_TOP_DM_COUNT = 4;

export type IdleWarmGroup = {
  conversationUuid: string;
  lastMessageAt?: string | null;
};

export function selectIdlePlaintextWarmSet(
  conversations: readonly Pick<ConversationListItemDto, "otherUserUuid" | "unreadCount">[],
  groups: readonly IdleWarmGroup[],
): { dmPeerUuids: string[]; groupUuids: string[] } {
  const dmPeerUuids: string[] = [];
  const pushDm = (peerUuid: string) => {
    const peer = peerUuid.trim().toLowerCase();
    if (!peer || dmPeerUuids.includes(peer) || dmPeerUuids.length >= IDLE_DM_WARM_LIMIT) return;
    dmPeerUuids.push(peer);
  };
  for (const conversation of conversations.slice(0, IDLE_TOP_DM_COUNT)) pushDm(conversation.otherUserUuid);
  for (const conversation of conversations) {
    if (conversation.unreadCount > 0) pushDm(conversation.otherUserUuid);
  }
  const groupUuids = [...groups]
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
    .map((group) => group.conversationUuid.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, IDLE_GROUP_WARM_LIMIT);
  return { dmPeerUuids, groupUuids };
}

export function usePreloadConversationThreads(
  viewerNorm: string,
  conversations: ConversationListItemDto[],
  options?: {
    viewerUuid?: string;
    fscpMaterial?: FscpLocalMaterial | null;
    groups?: readonly IdleWarmGroup[];
  },
) {
  const viewerUuid = options?.viewerUuid?.trim() ?? "";
  const agreementPrivateKey = options?.fscpMaterial?.agreementPrivateKey;
  const groups = options?.groups;

  const warmSet = useMemo(
    () => selectIdlePlaintextWarmSet(conversations, groups ?? []),
    [conversations, groups],
  );

  const canDecrypt = Boolean(viewerNorm && viewerUuid && agreementPrivateKey);

  const prefetchPeerThread = useCallback(
    (peerUuid: string) => {
      if (!viewerNorm || !peerUuid.trim()) return;
      const peer = peerUuid.trim().toLowerCase();
      preloadConversationThreads(viewerNorm, [peer]);
      if (!canDecrypt || !agreementPrivateKey || !isPlaintextSessionCacheEnabled()) return;
      scheduleHoverThreadWarm(`dm:${viewerNorm}:${peer}`, (isAborted) => {
        void warmCachedDmPlaintextTail({
          viewerNorm,
          peerUuid: peer,
          viewerUserUuid: viewerUuid,
          agreementPrivateKey,
          shouldContinue: () => !isAborted(),
          sliceSize: THREAD_OPEN_PLAINTEXT_TAIL,
        });
      });
    },
    [agreementPrivateKey, canDecrypt, viewerNorm, viewerUuid],
  );

  const prefetchGroupThread = useCallback(
    (conversationUuid: string) => {
      if (!viewerNorm || !conversationUuid.trim()) return;
      const conversation = conversationUuid.trim().toLowerCase();
      refreshIdleCiphertext(viewerNorm, [], [conversation]);
      if (!canDecrypt || !agreementPrivateKey || !isPlaintextSessionCacheEnabled()) return;
      scheduleHoverThreadWarm(`group:${viewerNorm}:${conversation}`, (isAborted) => {
        void warmCachedGroupPlaintextTail({
          viewerNorm,
          conversationUuid: conversation,
          viewerUserUuid: viewerUuid,
          agreementPrivateKey,
          shouldContinue: () => !isAborted(),
          sliceSize: THREAD_OPEN_PLAINTEXT_TAIL,
        });
      });
    },
    [agreementPrivateKey, canDecrypt, viewerNorm, viewerUuid],
  );

  const cancelPeerThreadWarm = useCallback(
    (peerUuid: string) => {
      cancelHoverThreadWarm(`dm:${viewerNorm}:${peerUuid.trim().toLowerCase()}`);
    },
    [viewerNorm],
  );

  const cancelGroupThreadWarm = useCallback(
    (conversationUuid: string) => {
      cancelHoverThreadWarm(`group:${viewerNorm}:${conversationUuid.trim().toLowerCase()}`);
    },
    [viewerNorm],
  );

  useEffect(() => {
    if (!viewerNorm || (warmSet.dmPeerUuids.length === 0 && warmSet.groupUuids.length === 0)) return;

    const threadKeys = [
      ...warmSet.dmPeerUuids.map((peer) => plaintextThreadKey(viewerNorm, "dm", peer)),
      ...warmSet.groupUuids.map((conversation) => plaintextThreadKey(viewerNorm, "group", conversation)),
    ];
    pinIdlePlaintextThreads(threadKeys);

    let stopped = false;
    const shouldContinue = () =>
      !stopped && !isThreadWarmBlocked() && isPlaintextSessionCacheEnabled();

    const run = () => {
      if (stopped || isThreadWarmBlocked()) return;
      refreshIdleCiphertext(viewerNorm, warmSet.dmPeerUuids, warmSet.groupUuids);
      if (!shouldContinue() || !agreementPrivateKey || !viewerUuid) return;
      void warmIdlePlaintextThreads({
        viewerNorm,
        viewerUserUuid: viewerUuid,
        agreementPrivateKey,
        dmPeerUuids: warmSet.dmPeerUuids,
        groupUuids: warmSet.groupUuids,
        shouldContinue,
      });
    };

    const onVisibility = () => {
      if (document.hidden) {
        stopped = true;
        return;
      }
      stopped = false;
      run();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let idleId: number | null = null;
    let timeoutId: number | null = null;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(run, { timeout: 3_000 });
    } else {
      timeoutId = window.setTimeout(run, 100);
    }

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (idleId !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [agreementPrivateKey, viewerNorm, viewerUuid, warmSet]);

  return { prefetchPeerThread, prefetchGroupThread, cancelPeerThreadWarm, cancelGroupThreadWarm };
}

export { THREAD_DECRYPT_SLICE };
