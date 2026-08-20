import type { MsgConversationDto } from "@flora/client-core/contracts";
import { isFscpWirePayload } from "@flora/client-core/fscp";
import { useCallback, useEffect, useRef, useState } from "react";
import { mapIdleSliced, type IdleSlicedDeps } from "@/lib/idleScrollGate";
import { useFscpStore } from "@/stores/fscpStore";
import { messagePreviewCache, messagePreviewKey } from "@/stores/messagePreviewCache";

export type MessagesListPreviewDecryptOne = (item: MsgConversationDto) => Promise<string>;

export type WarmMessagesListPreviewsDeps = IdleSlicedDeps & {
  decryptOne: MessagesListPreviewDecryptOne;
};

export type WarmMessagesListPreviewsHandle = {
  cancel: () => void;
  done: Promise<Record<string, string> | null>;
};

let warmEpoch = 0;
let abortActiveWarm: (() => void) | null = null;

/**
 * Idle-sliced list-preview warm: one conversation, then a macrotask yield so
 * feed frames can run. Decrypt waits while the feed is unsettled — including
 * after an in-flight sodium call returns. A new run (or `cancel`) aborts the
 * previous one.
 */
export function warmMessagesListPreviews(
  conversations: readonly MsgConversationDto[],
  deps: WarmMessagesListPreviewsDeps,
): WarmMessagesListPreviewsHandle {
  abortActiveWarm?.();
  const epoch = ++warmEpoch;

  const sliced = mapIdleSliced(
    conversations,
    async (item) => {
      const mk = messagePreviewKey(item.lastMessageEncryptedForMe, item.lastMessageAt);
      const cached = messagePreviewCache.get(item.conversationUuid);
      if (cached && cached.msgKey === mk) {
        return cached.text;
      }
      const text = await deps.decryptOne(item);
      messagePreviewCache.set(item.conversationUuid, mk, text);
      return text;
    },
    {
      isScrollSettled: deps.isScrollSettled,
      subscribeScrollSettled: deps.subscribeScrollSettled,
      yieldBetweenSteps: deps.yieldBetweenSteps,
    },
  );

  const cancel = () => {
    sliced.cancel();
    if (epoch === warmEpoch) abortActiveWarm = null;
  };
  abortActiveWarm = cancel;

  const done = sliced.done.then((rows) => {
    if (!rows) return null;
    const next: Record<string, string> = {};
    for (let i = 0; i < conversations.length; i++) {
      const item = conversations[i];
      const text = rows[i];
      if (item == null || text == null) continue;
      next[item.conversationUuid] = text;
    }
    return next;
  });

  return { cancel, done };
}

export function useMessagesListPreviewDecrypt(
  conversations: MsgConversationDto[],
  viewerUserUuid: string | undefined,
) {
  const fscpReady = useFscpStore((s) => s.status === "ready");
  const material = useFscpStore((s) => s.material);
  const decryptPreview = useFscpStore((s) => s.decryptPreview);

  const [previews, setPreviews] = useState<Record<string, string>>({});
  const prevViewerRef = useRef(viewerUserUuid);
  const prevFscpReadyRef = useRef(fscpReady);

  useEffect(() => {
    if (prevViewerRef.current !== viewerUserUuid) {
      prevViewerRef.current = viewerUserUuid;
      messagePreviewCache.clear();
      setPreviews({});
    }
  }, [viewerUserUuid]);

  useEffect(() => {
    if (prevFscpReadyRef.current !== fscpReady) {
      prevFscpReadyRef.current = fscpReady;
      if (fscpReady) {
        messagePreviewCache.clear();
      }
    }
  }, [fscpReady]);

  const decryptOne = useCallback(
    async (item: MsgConversationDto): Promise<string> => {
      if (item.lastMessageContent?.trim()) {
        return item.lastMessageContent;
      }
      const enc = item.lastMessageEncryptedForMe?.trim();
      if (!enc) return "Нет сообщений";
      if (!isFscpWirePayload(enc)) return enc;
      if (!viewerUserUuid || !fscpReady || !material) {
        return "Расшифровка…";
      }
      const preview = await decryptPreview(enc, viewerUserUuid);
      return preview ?? "…";
    },
    [decryptPreview, fscpReady, material, viewerUserUuid],
  );

  useEffect(() => {
    if (!viewerUserUuid || conversations.length === 0) return;
    const handle = warmMessagesListPreviews(conversations, { decryptOne });
    void handle.done.then((next) => {
      if (!next) return;
      setPreviews((prev) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k])
        ) {
          return prev;
        }
        return next;
      });
    });
    return () => {
      handle.cancel();
    };
  }, [conversations, decryptOne, fscpReady, viewerUserUuid]);

  return previews;
}
