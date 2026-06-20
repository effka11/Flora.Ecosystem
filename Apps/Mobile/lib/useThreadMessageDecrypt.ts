import type { MsgMessageDto } from "@flora/client-core/contracts";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  isFscpWirePayload,
  plaintextToPreview,
  type FscpMessagePlaintext,
} from "@flora/client-core/fscp";
import { useEffect, useRef, useState } from "react";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";

const DECRYPT_BATCH = 4;

export function messageDecryptCacheKey(m: MsgMessageDto): string {
  return `${m.messageUuid}|${(m.encryptedPayload ?? "").slice(0, 96)}`;
}

function normalizeRow(row: ThreadBubbleItem): ThreadBubbleItem {
  return {
    ...row,
    imageBlocks: row.imageBlocks ?? [],
    voiceBlock: row.voiceBlock,
  };
}

function buildDecryptingRow(m: MsgMessageDto): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    text: "",
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "decrypting",
    isRead: m.isRead,
  };
}

function rowFromPlaintext(m: MsgMessageDto, plain: FscpMessagePlaintext): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    text: extractTextFromPlaintext(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
  };
}

function rowFromPreviewText(m: MsgMessageDto, preview: string): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    text: preview,
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
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
  if (enc && isFscpWirePayload(enc)) return true;
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
    if (enc && isFscpWirePayload(enc)) return isRowTerminal(row);
    return row.decryptState === "ok";
  });
}

function rowsFromWireCache(
  conversationUuid: string,
  messages: MsgMessageDto[],
): ThreadBubbleItem[] | null {
  const cached = messageThreadDecryptCache.get(conversationUuid);
  if (!cached || !isConversationFullyResolved(messages, cached)) return null;
  const sameOrder = messages.every((m, i) => cached[i]?.messageUuid === m.messageUuid);
  return sameOrder ? messages.map((m, i) => withMessageMeta(cached[i]!, m)) : null;
}

function rowsFromMessageCache(messages: MsgMessageDto[]): ThreadBubbleItem[] {
  return messages.map((m) => {
    const wireCached = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
    if (wireCached && isRowTerminal(wireCached)) {
      return withMessageMeta(wireCached, m);
    }
    return buildDecryptingRow(m);
  });
}

function withMessageMeta(row: ThreadBubbleItem, m: MsgMessageDto): ThreadBubbleItem {
  return normalizeRow({
    ...row,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    isRead: m.isRead,
  });
}

function mergeRowsWithCurrent(
  messages: MsgMessageDto[],
  current: ThreadBubbleItem[],
): ThreadBubbleItem[] {
  return messages.map((m, index) => {
    const cacheKey = messageDecryptCacheKey(m);
    const wireCached = messageThreadDecryptCache.getMessage(cacheKey);
    if (wireCached && isRowTerminal(wireCached)) {
      return withMessageMeta(wireCached, m);
    }
    const row = current[index];
    if (row?.messageUuid === m.messageUuid && isRowTerminal(row)) {
      return withMessageMeta(row, m);
    }
    return buildDecryptingRow(m);
  });
}

type Args = {
  conversationUuid: string;
  messages: MsgMessageDto[];
  messagesKey: string;
  viewerUserUuid: string | undefined;
  fscpReady: boolean;
  /** Меняется при смене ключей — перезапуск расшифровки без нестабильных колбэков. */
  fscpDecryptKey?: string | null;
  decryptWirePlaintext: (wire: string, viewerUserUuid: string) => Promise<FscpMessagePlaintext>;
};

export function useThreadMessageDecrypt({
  conversationUuid,
  messages,
  messagesKey,
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
    return rowsFromWireCache(conversationUuid, messages) ?? rowsFromMessageCache(messages);
  });

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const currentMessages = messagesRef.current;
    if (!messagesKey) {
      setRows([]);
      return;
    }

    const conversationCached = rowsFromWireCache(conversationUuid, currentMessages);
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
      const seeded = rowsFromMessageCache(currentMessages);
      setRows(seeded);
      rowsRef.current = seeded;
    } else {
      const merged = mergeRowsWithCurrent(currentMessages, rowsRef.current);
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
            if (enc && isFscpWirePayload(enc)) {
              try {
                const plain = await decryptWirePlaintextRef.current(enc, viewerUserUuid);
                row = rowFromPlaintext(m, plain);
              } catch {
                row = {
                  messageUuid: m.messageUuid,
                  text: "",
                  imageBlocks: [],
                  voiceBlock: undefined,
                  isFromMe: m.isFromMe,
                  createdAt: m.createdAt,
                  decryptState: "failed",
                };
              }
            } else {
              row = rowFromPreviewText(m, plaintextToPreview({
                type: "blocks",
                version: 1,
                blocks: [{ kind: "text", body: m.encryptedPayload ?? "" }],
                clientCreatedAt: m.createdAt,
              }));
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
  }, [conversationUuid, fscpDecryptKey, fscpReady, messagesKey, viewerUserUuid]);

  return rows;
}
