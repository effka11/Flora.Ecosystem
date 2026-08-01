import type {
  MsgConversationDto,
  MsgConversationsPage,
  MsgMessageDto,
  MsgSentMessageDto,
} from "@flora/client-core/contracts";
import type { FscpMessageBlock, FscpMessageReplyRef } from "@flora/client-core/fscp";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  messagePlaintextFromBlocks,
  plaintextToPreview,
} from "@flora/client-core/fscp";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  isOptimisticPayloadSentinel,
  markBirthPending,
  optimisticPayloadSentinel,
  rebindClientMessageKey,
  rememberClientMessageKey,
  takeClientMessageKey,
} from "@/lib/messageBirthRegistry";
import { messageDecryptCacheKey } from "@/lib/useThreadMessageDecrypt";
import { messagePreviewCache, messagePreviewKey } from "@/stores/messagePreviewCache";
import {
  messageThreadCache,
  messageThreadDecryptCache,
  onAfterClearDecryptCaches,
} from "@/stores/messageThreadCache";

export type OutgoingConversationPatch = {
  conversationUuid: string;
  /** Тот же шифротекст, что уходит в messagePreviewKey при засеве. */
  encryptedForMe: string;
  createdAt: string;
  /** Пока нет wire — сразу показать превью в списке чатов. */
  lastMessageContent?: string | null;
};

export type MessagesQueryData = { items: MsgMessageDto[]; nextCursor: string | null };

export type PendingOutgoingEntry = {
  clientMessageKey: string;
  dto: MsgMessageDto;
  /** Snapshot decrypt-row — переживает clearDecryptCaches. */
  row: ThreadBubbleItem;
};

/** In-flight optimistic DTOs с temp uuid — переживают unmount и refetch. */
const pendingByConversation = new Map<string, PendingOutgoingEntry[]>();

function normConv(conversationUuid: string): string {
  return conversationUuid.trim().toLowerCase();
}

function messagesQueryKey(conversationUuid: string, otherUserUuid?: string) {
  return ["messages", conversationUuid, otherUserUuid?.trim() || ""] as const;
}

function seedPendingDecryptRows(conversationUuid: string): void {
  for (const entry of getPendingOutgoing(conversationUuid)) {
    messageThreadDecryptCache.setMessage(messageDecryptCacheKey(entry.dto), entry.row);
  }
}

export function applyOutgoingToConversations(
  items: MsgConversationDto[],
  patch: OutgoingConversationPatch,
): MsgConversationDto[] {
  const index = items.findIndex((item) => item.conversationUuid === patch.conversationUuid);
  if (index === -1) return items;

  const updated = {
    ...items[index],
    lastMessageEncryptedForMe: patch.encryptedForMe,
    lastMessageContent:
      patch.lastMessageContent !== undefined ? patch.lastMessageContent : null,
    lastMessageAt: patch.createdAt,
    lastMessageIsFromMe: true,
  };
  return [updated, ...items.slice(0, index), ...items.slice(index + 1)];
}

function rowFromPlaintext(
  message: MsgMessageDto,
  plain: ReturnType<typeof messagePlaintextFromBlocks>,
  replyTo: FscpMessageReplyRef | undefined,
  extras?: { sendStatus?: "sending"; clientMessageKey?: string },
): ThreadBubbleItem {
  return {
    messageUuid: message.messageUuid,
    clientMessageKey: extras?.clientMessageKey ?? message.messageUuid,
    text: extractTextFromPlaintext(plain),
    previewText: plaintextToPreview(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    replyTo,
    isFromMe: message.isFromMe,
    createdAt: message.createdAt,
    decryptState: "ok",
    isRead: message.isRead,
    sendStatus: extras?.sendStatus,
  };
}

function patchConversationsPreview(
  queryClient: QueryClient,
  conversationUuid: string,
  encryptedForMe: string,
  createdAt: string,
  preview: string,
): void {
  const patch: OutgoingConversationPatch = {
    conversationUuid,
    encryptedForMe,
    createdAt,
    lastMessageContent: preview,
  };
  queryClient.setQueryData<MsgConversationsPage>(["conversations"], (old) =>
    old ? { ...old, items: applyOutgoingToConversations(old.items, patch) } : old,
  );
  messagePreviewCache.set(
    conversationUuid,
    messagePreviewKey(encryptedForMe, createdAt),
    preview,
  );
}

function invalidateConversationDecryptArray(conversationUuid: string): void {
  messageThreadDecryptCache.clearConversation(conversationUuid);
}

export function getPendingOutgoing(conversationUuid: string): PendingOutgoingEntry[] {
  return pendingByConversation.get(normConv(conversationUuid)) ?? [];
}

export function clearPendingOutgoing(conversationUuid: string): void {
  pendingByConversation.delete(normConv(conversationUuid));
}

export function clearAllPendingOutgoing(): void {
  pendingByConversation.clear();
}

/**
 * После clearConversation / clearDecryptCaches — вернуть decrypt seeds и
 * подмешать pending в module + RQ cache.
 */
export function rehydratePendingOutgoing(params: {
  conversationUuid: string;
  otherUserUuid?: string;
  queryClient?: QueryClient;
}): void {
  const pending = getPendingOutgoing(params.conversationUuid);
  if (pending.length === 0) return;

  seedPendingDecryptRows(params.conversationUuid);
  invalidateConversationDecryptArray(params.conversationUuid);

  const base = messageThreadCache.get(params.conversationUuid) ?? [];
  const merged = mergePendingOutgoingIntoMessages(params.conversationUuid, base);
  messageThreadCache.set(params.conversationUuid, merged);

  const qc = params.queryClient;
  if (!qc) return;
  const queryKey = messagesQueryKey(params.conversationUuid, params.otherUserUuid);
  qc.setQueryData<MessagesQueryData>(queryKey, (old) => {
    const prev = old?.items ?? merged;
    const items = mergePendingOutgoingIntoMessages(params.conversationUuid, prev);
    messageThreadCache.set(params.conversationUuid, items);
    return { items, nextCursor: old?.nextCursor ?? null };
  });
}

/** После глобального clearDecryptCaches — перепосеять все in-flight optimistic rows. */
export function rehydrateAllPendingOutgoingDecryptSeeds(): void {
  for (const conversationUuid of pendingByConversation.keys()) {
    seedPendingDecryptRows(conversationUuid);
  }
}

/** Подмешать in-flight optimistic в серверную страницу (refetch-safe). */
export function mergePendingOutgoingIntoMessages(
  conversationUuid: string,
  items: MsgMessageDto[],
): MsgMessageDto[] {
  const pending = getPendingOutgoing(conversationUuid);
  if (pending.length === 0) return items;

  let next = items;
  let mutated = false;
  for (const entry of pending) {
    if (next.some((m) => m.messageUuid === entry.dto.messageUuid)) continue;
    if (!mutated) {
      next = [...next];
      mutated = true;
    }
    next.push(entry.dto);
  }
  return next;
}

/** Применить серверную страницу + pending в RQ и module cache. */
export function applyMessagesPageToCaches(params: {
  conversationUuid: string;
  otherUserUuid?: string;
  queryClient?: QueryClient;
  page: MessagesQueryData;
}): MessagesQueryData {
  const mergedItems = mergePendingOutgoingIntoMessages(
    params.conversationUuid,
    params.page.items,
  );
  const next: MessagesQueryData = {
    items: mergedItems,
    nextCursor: params.page.nextCursor,
  };
  messageThreadCache.set(params.conversationUuid, next.items);
  if (params.queryClient) {
    params.queryClient.setQueryData(
      messagesQueryKey(params.conversationUuid, params.otherUserUuid),
      next,
    );
  }
  return next;
}

function setMessagesItems(
  queryClient: QueryClient,
  conversationUuid: string,
  otherUserUuid: string | undefined,
  updater: (prev: MsgMessageDto[]) => MsgMessageDto[],
): void {
  const queryKey = messagesQueryKey(conversationUuid, otherUserUuid);
  queryClient.setQueryData<MessagesQueryData>(queryKey, (old) => {
    const prev = old?.items ?? messageThreadCache.get(conversationUuid) ?? [];
    const items = updater(prev);
    messageThreadCache.set(conversationUuid, items);
    return { items, nextCursor: old?.nextCursor ?? null };
  });
}

/** True while the outgoing row is still in-flight (parity Web `sendStatus === "sending"`). */
function isOutgoingSending(m: MsgMessageDto): boolean {
  if (isOptimisticPayloadSentinel(m.encryptedPayload)) return true;
  const row = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
  return row?.sendStatus === "sending";
}

/** Live read receipt: mark outgoing (non-sending) rows as read. */
export function markOutgoingMessagesReadInCache(params: {
  queryClient: QueryClient;
  conversationUuid: string;
  otherUserUuid?: string;
}): void {
  setMessagesItems(
    params.queryClient,
    params.conversationUuid,
    params.otherUserUuid,
    (prev) =>
      prev.map((m) =>
        m.isFromMe && !isOutgoingSending(m) ? { ...m, isRead: true } : m,
      ),
  );

  const decryptRows = messageThreadDecryptCache.get(params.conversationUuid);
  if (decryptRows) {
    messageThreadDecryptCache.set(
      params.conversationUuid,
      decryptRows.map((row) =>
        row.isFromMe && row.sendStatus !== "sending" ? { ...row, isRead: true } : row,
      ),
    );
  }
}

export function insertOptimisticOutgoingThreadMessage(params: {
  queryClient: QueryClient;
  conversationUuid: string;
  otherUserUuid?: string;
  senderUserUuid: string;
  clientMessageKey: string;
  blocks: FscpMessageBlock[];
  replyTo?: FscpMessageReplyRef;
  createdAt?: string;
}): MsgMessageDto {
  const createdAt = params.createdAt ?? new Date().toISOString();
  const sentinel = optimisticPayloadSentinel(params.clientMessageKey);
  const dto: MsgMessageDto = {
    messageUuid: params.clientMessageKey,
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.senderUserUuid,
    encryptedPayload: sentinel,
    createdAt,
    isFromMe: true,
    isRead: false,
  };
  const plain = messagePlaintextFromBlocks(params.blocks, createdAt);
  const preview = plaintextToPreview(plain);
  const row = rowFromPlaintext(dto, plain, params.replyTo, {
    sendStatus: "sending",
    clientMessageKey: params.clientMessageKey,
  });

  rememberClientMessageKey(dto.messageUuid, params.clientMessageKey);
  markBirthPending(params.clientMessageKey);

  messageThreadDecryptCache.setMessage(messageDecryptCacheKey(dto), row);
  invalidateConversationDecryptArray(params.conversationUuid);

  const convKey = normConv(params.conversationUuid);
  const list = pendingByConversation.get(convKey) ?? [];
  pendingByConversation.set(convKey, [
    ...list.filter((e) => e.clientMessageKey !== params.clientMessageKey),
    { clientMessageKey: params.clientMessageKey, dto, row },
  ]);

  patchConversationsPreview(
    params.queryClient,
    params.conversationUuid,
    sentinel,
    createdAt,
    preview,
  );

  setMessagesItems(params.queryClient, params.conversationUuid, params.otherUserUuid, (prev) => {
    if (prev.some((m) => m.messageUuid === dto.messageUuid)) return prev;
    return [...prev, dto];
  });

  return dto;
}

export function replaceOptimisticOutgoingThreadMessage(params: {
  queryClient: QueryClient;
  conversationUuid: string;
  otherUserUuid?: string;
  senderUserUuid: string;
  clientMessageKey: string;
  sent: MsgSentMessageDto;
  wire: string;
  blocks: FscpMessageBlock[];
  replyTo?: FscpMessageReplyRef;
}): void {
  const realDto: MsgMessageDto = {
    messageUuid: params.sent.messageUuid,
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.senderUserUuid,
    encryptedPayload: params.sent.encryptedForMe || params.wire,
    createdAt: params.sent.createdAt,
    isFromMe: true,
    isRead: false,
  };
  const plain = messagePlaintextFromBlocks(params.blocks, realDto.createdAt);
  const preview = plaintextToPreview(plain);
  const row = rowFromPlaintext(realDto, plain, params.replyTo, {
    clientMessageKey: params.clientMessageKey,
  });

  const tempDto: MsgMessageDto = {
    messageUuid: params.clientMessageKey,
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.senderUserUuid,
    encryptedPayload: optimisticPayloadSentinel(params.clientMessageKey),
    createdAt: realDto.createdAt,
    isFromMe: true,
    isRead: false,
  };
  messageThreadDecryptCache.deleteMessage(messageDecryptCacheKey(tempDto));
  messageThreadDecryptCache.setMessage(messageDecryptCacheKey(realDto), row);
  invalidateConversationDecryptArray(params.conversationUuid);

  rebindClientMessageKey(params.clientMessageKey, realDto.messageUuid);

  const convKey = normConv(params.conversationUuid);
  const pending = pendingByConversation.get(convKey) ?? [];
  pendingByConversation.set(
    convKey,
    pending.filter((e) => e.clientMessageKey !== params.clientMessageKey),
  );

  patchConversationsPreview(
    params.queryClient,
    params.conversationUuid,
    realDto.encryptedPayload,
    realDto.createdAt,
    preview,
  );

  setMessagesItems(params.queryClient, params.conversationUuid, params.otherUserUuid, (prev) => {
    const withoutTemp = prev.filter((m) => m.messageUuid !== params.clientMessageKey);
    if (withoutTemp.some((m) => m.messageUuid === realDto.messageUuid)) {
      return withoutTemp;
    }
    return [...withoutTemp, realDto];
  });
}

export function removeOptimisticOutgoingThreadMessage(params: {
  queryClient: QueryClient;
  conversationUuid: string;
  otherUserUuid?: string;
  clientMessageKey: string;
}): void {
  const tempDto: MsgMessageDto = {
    messageUuid: params.clientMessageKey,
    conversationUuid: params.conversationUuid,
    senderUserUuid: "",
    encryptedPayload: optimisticPayloadSentinel(params.clientMessageKey),
    createdAt: "",
    isFromMe: true,
    isRead: false,
  };
  messageThreadDecryptCache.deleteMessage(messageDecryptCacheKey(tempDto));
  invalidateConversationDecryptArray(params.conversationUuid);

  const convKey = normConv(params.conversationUuid);
  const pending = pendingByConversation.get(convKey) ?? [];
  pendingByConversation.set(
    convKey,
    pending.filter((e) => e.clientMessageKey !== params.clientMessageKey),
  );

  setMessagesItems(params.queryClient, params.conversationUuid, params.otherUserUuid, (prev) =>
    prev.filter((m) => m.messageUuid !== params.clientMessageKey),
  );
}

onAfterClearDecryptCaches(() => {
  rehydrateAllPendingOutgoingDecryptSeeds();
});

/** Сразу показывает исходящее в конце ленты (до/вместо refetch). Legacy post-ACK path. */
export function appendOutgoingThreadMessage(params: {
  queryClient: QueryClient;
  conversationUuid: string;
  otherUserUuid?: string;
  senderUserUuid: string;
  sent: MsgSentMessageDto;
  wire: string;
  blocks: FscpMessageBlock[];
  replyTo?: FscpMessageReplyRef;
}): void {
  const dto: MsgMessageDto = {
    messageUuid: params.sent.messageUuid,
    conversationUuid: params.conversationUuid,
    senderUserUuid: params.senderUserUuid,
    encryptedPayload: params.sent.encryptedForMe || params.wire,
    createdAt: params.sent.createdAt,
    isFromMe: true,
    isRead: false,
  };
  const plain = messagePlaintextFromBlocks(params.blocks, dto.createdAt);
  const clientKey = takeClientMessageKey(dto.messageUuid) ?? dto.messageUuid;
  rememberClientMessageKey(dto.messageUuid, clientKey);

  const cacheKey = messageDecryptCacheKey(dto);
  messageThreadDecryptCache.setMessage(
    cacheKey,
    rowFromPlaintext(dto, plain, params.replyTo, { clientMessageKey: clientKey }),
  );
  invalidateConversationDecryptArray(params.conversationUuid);

  patchConversationsPreview(
    params.queryClient,
    params.conversationUuid,
    dto.encryptedPayload,
    dto.createdAt,
    plaintextToPreview(plain),
  );

  setMessagesItems(params.queryClient, params.conversationUuid, params.otherUserUuid, (prev) => {
    if (prev.some((m) => m.messageUuid === dto.messageUuid)) return prev;
    return [...prev, dto];
  });
}
