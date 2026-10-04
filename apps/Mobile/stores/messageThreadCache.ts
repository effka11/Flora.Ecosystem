import type { MsgMessageDto } from "@flora/client-core/contracts";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";

const cache = new Map<string, MsgMessageDto[]>();
const wireDecryptCache = new Map<string, ThreadBubbleItem>();
const conversationDecryptCache = new Map<string, ThreadBubbleItem[]>();

/** Late-bound: outgoing module restores optimistic decrypt seeds after wipe. */
let afterClearDecryptCaches: (() => void) | null = null;

export function onAfterClearDecryptCaches(fn: () => void): void {
  afterClearDecryptCaches = fn;
}

export const messageThreadCache = {
  get(conversationUuid: string): MsgMessageDto[] | undefined {
    return cache.get(conversationUuid);
  },
  set(conversationUuid: string, messages: MsgMessageDto[]): void {
    cache.set(conversationUuid, messages);
  },
  append(conversationUuid: string, message: MsgMessageDto): void {
    const prev = cache.get(conversationUuid) ?? [];
    cache.set(conversationUuid, [...prev, message]);
  },
  clear(): void {
    cache.clear();
    wireDecryptCache.clear();
    conversationDecryptCache.clear();
  },
  clearConversation(conversationUuid: string): void {
    cache.delete(conversationUuid);
    conversationDecryptCache.delete(conversationUuid);
  },
  clearDecryptCaches(): void {
    wireDecryptCache.clear();
    conversationDecryptCache.clear();
    afterClearDecryptCaches?.();
  },
};

export const messageThreadDecryptCache = {
  get(conversationUuid: string): ThreadBubbleItem[] | undefined {
    return conversationDecryptCache.get(conversationUuid);
  },
  set(conversationUuid: string, rows: ThreadBubbleItem[]): void {
    conversationDecryptCache.set(conversationUuid, rows);
  },
  clearConversation(conversationUuid: string): void {
    conversationDecryptCache.delete(conversationUuid);
  },
  getMessage(cacheKey: string): ThreadBubbleItem | undefined {
    return wireDecryptCache.get(cacheKey);
  },
  setMessage(cacheKey: string, row: ThreadBubbleItem): void {
    wireDecryptCache.set(cacheKey, row);
  },
  deleteMessage(cacheKey: string): void {
    wireDecryptCache.delete(cacheKey);
  },
};
