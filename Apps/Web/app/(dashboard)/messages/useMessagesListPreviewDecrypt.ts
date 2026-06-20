"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationListItemDto } from "@/lib/socialApi";
import { isFscpWirePayload, type FscpLocalMaterial, type FscpMessagePlaintext } from "@/lib/fscp";
import { scheduleMessagesListPreviewBatch } from "@/lib/messagesListPreviewQueue";

function msgKeyFor(c: ConversationListItemDto): string {
  return `${c.lastMessageUuid.trim()}|${c.lastMessageAt.trim()}|${(c.lastMessageEncryptedForMe ?? "").slice(0, 48)}`;
}

export function useMessagesListPreviewDecrypt(
  conversations: ConversationListItemDto[],
  fscpMaterial: FscpLocalMaterial | null | undefined,
  viewerNorm: string,
) {
  const [listPreviewDecryptedByPeer, setListPreviewDecryptedByPeer] = useState<
    Record<string, FscpMessagePlaintext>
  >({});
  const [listPreviewDecryptFailByPeer, setListPreviewDecryptFailByPeer] = useState<Record<string, boolean>>(
    {},
  );
  const listPreviewDecryptedForMsgRef = useRef<Record<string, string>>({});
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const cancelRef = useRef<(() => void) | null>(null);
  const prevViewerNormRef = useRef(viewerNorm);

  useEffect(() => {
    if (prevViewerNormRef.current !== viewerNorm) {
      prevViewerNormRef.current = viewerNorm;
      listPreviewDecryptedForMsgRef.current = {};
      setListPreviewDecryptedByPeer({});
      setListPreviewDecryptFailByPeer({});
    }
  }, [viewerNorm]);

  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;

    if (!viewerNorm || !fscpMaterial) return;

    const removePeers = new Set<string>();
    const staleMismatch = new Set<string>();

    for (const c of conversations) {
      if (c.lastMessageContent?.trim()) {
        removePeers.add(c.otherUserUuid);
        continue;
      }
      const enc = c.lastMessageEncryptedForMe?.trim();
      if (!enc || !isFscpWirePayload(enc)) continue;
      const mk = msgKeyFor(c);
      const prevMk = listPreviewDecryptedForMsgRef.current[c.otherUserUuid];
      if (prevMk && prevMk !== mk) staleMismatch.add(c.otherUserUuid);
    }

    const allRemove = [...removePeers, ...staleMismatch];
    if (allRemove.length > 0) {
      for (const p of allRemove) {
        delete listPreviewDecryptedForMsgRef.current[p];
      }
      setListPreviewDecryptedByPeer((prev) => {
        const next = { ...prev };
        for (const p of allRemove) delete next[p];
        return next;
      });
      setListPreviewDecryptFailByPeer((prev) => {
        const next = { ...prev };
        for (const p of allRemove) delete next[p];
        return next;
      });
    }

    const jobs = conversations
      .filter((c) => {
        if (c.lastMessageContent?.trim()) return false;
        const enc = c.lastMessageEncryptedForMe?.trim();
        if (!enc || !isFscpWirePayload(enc)) return false;
        const msgKey = msgKeyFor(c);
        return listPreviewDecryptedForMsgRef.current[c.otherUserUuid] !== msgKey;
      })
      .map((c) => ({
        peerUuid: c.otherUserUuid,
        enc: c.lastMessageEncryptedForMe!.trim(),
        msgKey: msgKeyFor(c),
      }));

    if (jobs.length === 0) return;

    cancelRef.current = scheduleMessagesListPreviewBatch({
      jobs,
      viewerNorm,
      agreementPrivateKey: fscpMaterial.agreementPrivateKey,
      getLatestMsgKey: (peerUuid) => {
        const latest = conversationsRef.current.find((x) => x.otherUserUuid === peerUuid);
        return latest ? msgKeyFor(latest) : null;
      },
      onSuccess: (peerUuid, msgKey, plain) => {
        listPreviewDecryptedForMsgRef.current[peerUuid] = msgKey;
        setListPreviewDecryptedByPeer((prev) => ({ ...prev, [peerUuid]: plain }));
        setListPreviewDecryptFailByPeer((prev) => {
          if (!(peerUuid in prev)) return prev;
          const next = { ...prev };
          delete next[peerUuid];
          return next;
        });
      },
      onFail: (peerUuid, msgKey) => {
        listPreviewDecryptedForMsgRef.current[peerUuid] = msgKey;
        setListPreviewDecryptFailByPeer((prev) => ({ ...prev, [peerUuid]: true }));
      },
    });

    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [conversations, viewerNorm, fscpMaterial]);

  return { listPreviewDecryptedByPeer, listPreviewDecryptFailByPeer };
}
