import type { MsgConversationDto } from "@flora/client-core/contracts";
import { isFscpWirePayload } from "@flora/client-core/fscp";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFscpStore } from "@/stores/fscpStore";

function msgKeyFor(c: MsgConversationDto): string {
  const enc = c.lastMessageEncryptedForMe ?? "";
  return `${c.conversationUuid}|${c.lastMessageAt.trim()}|${enc.slice(0, 48)}`;
}

export function useMessagesListPreviewDecrypt(
  conversations: MsgConversationDto[],
  viewerUserUuid: string | undefined,
) {
  const fscpReady = useFscpStore((s) => s.status === "ready");
  const material = useFscpStore((s) => s.material);
  const decryptPreview = useFscpStore((s) => s.decryptPreview);

  const [previews, setPreviews] = useState<Record<string, string>>({});
  const cacheRef = useRef<Record<string, string>>({});
  const previewTextRef = useRef<Record<string, string>>({});
  const prevViewerRef = useRef(viewerUserUuid);
  const prevFscpReadyRef = useRef(fscpReady);

  useEffect(() => {
    if (prevViewerRef.current !== viewerUserUuid) {
      prevViewerRef.current = viewerUserUuid;
      cacheRef.current = {};
      previewTextRef.current = {};
      setPreviews({});
    }
  }, [viewerUserUuid]);

  useEffect(() => {
    if (prevFscpReadyRef.current !== fscpReady) {
      prevFscpReadyRef.current = fscpReady;
      if (fscpReady) {
        cacheRef.current = {};
        previewTextRef.current = {};
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
    let cancelled = false;

    (async () => {
      const next: Record<string, string> = {};
      for (const item of conversations) {
        const mk = msgKeyFor(item);
        const cachedKey = cacheRef.current[item.conversationUuid];
        const cachedPreview = previewTextRef.current[item.conversationUuid];
        if (cachedKey === mk && cachedPreview !== undefined) {
          next[item.conversationUuid] = cachedPreview;
          continue;
        }
        const text = await decryptOne(item);
        next[item.conversationUuid] = text;
        cacheRef.current[item.conversationUuid] = mk;
        previewTextRef.current[item.conversationUuid] = text;
      }
      if (!cancelled) {
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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversations, decryptOne, fscpReady, viewerUserUuid]);

  return previews;
}
