import type { MsgMessageDto } from "@flora/client-core/contracts";
import { frankingMissingReceiptWarning } from "@flora/client-core/display";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  isFscpGroupWirePayload,
  isFscpWirePayload,
  plaintextToPreview,
  type FscpMessagePlaintext,
} from "@flora/client-core/fscp";
import { useEffect, useRef, useState } from "react";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  isOptimisticPayloadSentinel,
  takeClientMessageKey,
} from "@/lib/messageBirthRegistry";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";

const DECRYPT_BATCH = 4;

function isDecryptableFscpWire(enc: string | null | undefined): boolean {
  const t = enc?.trim();
  if (!t) return false;
  return isFscpWirePayload(t) || isFscpGroupWirePayload(t);
}

function missingFrankReceiptFromDto(m: MsgMessageDto, isGroupChat: boolean): boolean {
  return frankingMissingReceiptWarning({
    isGroupChat,
    frankTagBase64Url: m.frankTagBase64Url,
    wire: m.encryptedPayload,
    hasServerFrankReceipt: Boolean(m.serverFrankReceipt),
  });
}

export function messageDecryptCacheKey(m: MsgMessageDto): string {
  return `${m.messageUuid}|${(m.encryptedPayload ?? "").slice(0, 96)}`;
}

function normalizeRow(row: ThreadBubbleItem): ThreadBubbleItem {
  return {
    ...row,
    previewText: row.previewText ?? row.text ?? "",
    imageBlocks: row.imageBlocks ?? [],
    voiceBlock: row.voiceBlock,
    clientMessageKey:
      row.clientMessageKey ?? takeClientMessageKey(row.messageUuid) ?? row.messageUuid,
    senderUserUuid: row.senderUserUuid,
  };
}

function buildDecryptingRow(m: MsgMessageDto, isGroupChat: boolean): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: "",
    previewText: "",
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "decrypting",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function rowFromPlaintext(
  m: MsgMessageDto,
  plain: FscpMessagePlaintext,
  isGroupChat: boolean,
): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: extractTextFromPlaintext(plain),
    previewText: plaintextToPreview(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    replyTo: plain.replyTo,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function rowFromPreviewText(
  m: MsgMessageDto,
  preview: string,
  isGroupChat: boolean,
): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: preview,
    previewText: preview,
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function isRowTerminal(row: ThreadBubbleItem | undefined): boolean {
  return row?.decryptState === "ok" || row?.decryptState === "failed";
}

export function isRowDecryptComplete(
  m: MsgMessageDto,
  row: ThreadBubbleItem | undefined,
): boolean {
  if (!row || row.decryptState !== "ok") return false;
  const enc = m.encryptedPayload?.trim();
  if (enc && isDecryptableFscpWire(enc)) return true;
  return true;
}

function isConversationFullyResolved(
  messages: MsgMessageDto[],
  rows: ThreadBubbleItem[],
): boolean {
  if (rows.length !== messages.length) return false;
  return messages.every((m, i) => {
    const row = rows[i];
    if (row?.messageUuid !== m.messageUuid) return false;
    const enc = m.encryptedPayload?.trim();
    if (enc && isDecryptableFscpWire(enc)) return isRowTerminal(row);
    return row.decryptState === "ok";
  });
}

function withMessageMeta(
  row: ThreadBubbleItem,
  m: MsgMessageDto,
  isGroupChat: boolean,
): ThreadBubbleItem {
  const optimistic = isOptimisticPayloadSentinel(m.encryptedPayload);
  return normalizeRow({
    ...row,
    messageUuid: m.messageUuid,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid ?? row.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
    clientMessageKey:
      row.clientMessageKey ?? takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    sendStatus: optimistic ? "sending" : undefined,
  });
}

function resolveRowForMessage(
  m: MsgMessageDto,
  currentByUuid: Map<string, ThreadBubbleItem>,
  isGroupChat: boolean,
): ThreadBubbleItem {
  const cacheKey = messageDecryptCacheKey(m);
  const wireCached = messageThreadDecryptCache.getMessage(cacheKey);
  if (wireCached && isRowTerminal(wireCached)) {
    return withMessageMeta(wireCached, m, isGroupChat);
  }
  const prev = currentByUuid.get(m.messageUuid);
  if (prev && isRowTerminal(prev)) {
    return withMessageMeta(prev, m, isGroupChat);
  }
  return buildDecryptingRow(m, isGroupChat);
}

function rowsFromWireCache(
  conversationUuid: string,
  messages: MsgMessageDto[],
  isGroupChat: boolean,
): ThreadBubbleItem[] | null {
  const cached = messageThreadDecryptCache.get(conversationUuid);
  if (!cached || !isConversationFullyResolved(messages, cached)) return null;
  const sameOrder = messages.every((m, i) => cached[i]?.messageUuid === m.messageUuid);
  return sameOrder
    ? messages.map((m, i) => withMessageMeta(cached[i]!, m, isGroupChat))
    : null;
}

function rowsMergingCurrent(
  messages: MsgMessageDto[],
  current: ThreadBubbleItem[],
  isGroupChat: boolean,
): ThreadBubbleItem[] {
  const byUuid = new Map(current.map((row) => [row.messageUuid, row]));
  return messages.map((m) => resolveRowForMessage(m, byUuid, isGroupChat));
}

type Args = {
  conversationUuid: string;
  messages: MsgMessageDto[];
  messagesKey: string;
  isGroupChat: boolean;
  viewerUserUuid: string | undefined;
  fscpReady: boolean;
  fscpDecryptKey?: string | null;
  decryptWirePlaintext: (wire: string, viewerUserUuid: string) => Promise<FscpMessagePlaintext>;
};

export function useThreadMessageDecrypt({
  conversationUuid,
  messages,
  messagesKey,
  isGroupChat,
  viewerUserUuid,
  fscpReady,
  fscpDecryptKey,
  decryptWirePlaintext,
}: Args): ThreadBubbleItem[] {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const decryptWirePlaintextRef = useRef(decryptWirePlaintext);
  decryptWirePlaintextRef.current = decryptWirePlaintext;

  const prevMessagesKeyRef = useRef<string | null>(null);
  const prevFscpDecryptKeyRef = useRef<string | null | undefined>(undefined);

  const [rows, setRows] = useState<ThreadBubbleItem[]>(() => {
    if (!conversationUuid || messages.length === 0) return [];
    return (
      rowsFromWireCache(conversationUuid, messages, isGroupChat) ??
      rowsMergingCurrent(messages, [], isGroupChat)
    );
  });

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const currentMessages = messagesRef.current;
    if (!messagesKey) {
      setRows([]);
      return;
    }

    const conversationCached = rowsFromWireCache(
      conversationUuid,
      currentMessages,
      isGroupChat,
    );
    if (conversationCached) {
      setRows(conversationCached);
      rowsRef.current = conversationCached;
      return;
    }

    const messagesKeyChanged = prevMessagesKeyRef.current !== messagesKey;
    const fscpKeyChanged = prevFscpDecryptKeyRef.current !== fscpDecryptKey;
    prevMessagesKeyRef.current = messagesKey;
    prevFscpDecryptKeyRef.current = fscpDecryptKey;

    if (messagesKeyChanged || fscpKeyChanged) {
      const seeded = rowsMergingCurrent(currentMessages, rowsRef.current, isGroupChat);
      setRows(seeded);
      rowsRef.current = seeded;
    } else {
      const merged = rowsMergingCurrent(currentMessages, rowsRef.current, isGroupChat);
      const changed = merged.some((row, i) => row !== rowsRef.current[i]);
      if (changed) {
        setRows(merged);
        rowsRef.current = merged;
      }
    }

    if (!viewerUserUuid || !fscpReady) return;

    let cancelled = false;
    const pending = currentMessages
      .map((m, index) => ({ m, index }))
      .filter(({ m, index }) => {
        if (isOptimisticPayloadSentinel(m.encryptedPayload)) return false;
        const cacheKey = messageDecryptCacheKey(m);
        const cached = messageThreadDecryptCache.getMessage(cacheKey);
        if (cached && isRowTerminal(cached)) return false;
        const row = rowsRef.current[index];
        if (row?.messageUuid === m.messageUuid && isRowTerminal(row)) return false;
        return true;
      })
      .reverse();

    if (pending.length === 0) {
      if (isConversationFullyResolved(currentMessages, rowsRef.current)) {
        messageThreadDecryptCache.set(conversationUuid, rowsRef.current);
      }
      return;
    }

    void (async () => {
      const next = rowsRef.current.slice();

      for (let offset = 0; offset < pending.length; offset += DECRYPT_BATCH) {
        if (cancelled) return;
        const chunk = pending.slice(offset, offset + DECRYPT_BATCH);
        await Promise.all(
          chunk.map(async ({ m, index }) => {
            const cacheKey = messageDecryptCacheKey(m);
            const enc = m.encryptedPayload?.trim();
            let row: ThreadBubbleItem;
            if (enc && isDecryptableFscpWire(enc)) {
              try {
                const plain = await decryptWirePlaintextRef.current(enc, viewerUserUuid);
                row = rowFromPlaintext(m, plain, isGroupChat);
              } catch {
                row = {
                  messageUuid: m.messageUuid,
                  clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
                  text: "",
                  previewText: "",
                  imageBlocks: [],
                  voiceBlock: undefined,
                  isFromMe: m.isFromMe,
                  createdAt: m.createdAt,
                  decryptState: "failed",
                  isRead: m.isRead,
                  senderUserUuid: m.senderUserUuid,
                  missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
                };
              }
            } else if (isOptimisticPayloadSentinel(enc)) {
              const cached = messageThreadDecryptCache.getMessage(cacheKey);
              row =
                cached && isRowTerminal(cached)
                  ? withMessageMeta(cached, m, isGroupChat)
                  : buildDecryptingRow(m, isGroupChat);
            } else {
              row = rowFromPreviewText(
                m,
                plaintextToPreview({
                  type: "blocks",
                  version: 1,
                  blocks: [{ kind: "text", body: m.encryptedPayload ?? "" }],
                  clientCreatedAt: m.createdAt,
                }),
                isGroupChat,
              );
            }
            messageThreadDecryptCache.setMessage(cacheKey, row);
            next[index] = row;
          }),
        );
        if (cancelled) return;
        rowsRef.current = next;
        setRows(next.slice());
      }

      if (!cancelled && isConversationFullyResolved(currentMessages, rowsRef.current)) {
        messageThreadDecryptCache.set(conversationUuid, rowsRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationUuid, fscpDecryptKey, fscpReady, isGroupChat, messagesKey, viewerUserUuid]);

  return rows;
}
