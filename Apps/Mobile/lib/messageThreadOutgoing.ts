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
import { messageDecryptCacheKey } from "@/lib/useThreadMessageDecrypt";
import { messagePreviewCache, messagePreviewKey } from "@/stores/messagePreviewCache";
import { messageThreadCache, messageThreadDecryptCache } from "@/stores/messageThreadCache";

export type OutgoingConversationPatch = {
  conversationUuid: string;
  /** Тот же шифротекст, что уходит в messagePreviewKey при засеве. */
  encryptedForMe: string;
  createdAt: string;
};

export function applyOutgoingToConversations(
  items: MsgConversationDto[],
  patch: OutgoingConversationPatch,
): MsgConversationDto[] {
  const index = items.findIndex((item) => item.conversationUuid === patch.conversationUuid);
  if (index === -1) return items;

  const updated = {
    ...items[index],
    lastMessageEncryptedForMe: patch.encryptedForMe,
    lastMessageContent: null,
    lastMessageAt: patch.createdAt,
    lastMessageIsFromMe: true,
  };
  return [updated, ...items.slice(0, index), ...items.slice(index + 1)];
}

function rowFromPlaintext(
  message: MsgMessageDto,
  plain: ReturnType<typeof messagePlaintextFromBlocks>,
  replyTo?: FscpMessageReplyRef,
): ThreadBubbleItem {
  return {
    messageUuid: message.messageUuid,
    text: extractTextFromPlaintext(plain),
    previewText: plaintextToPreview(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    replyTo,
    isFromMe: message.isFromMe,
    createdAt: message.createdAt,
    decryptState: "ok",
    isRead: message.isRead,
  };
}

/** Сразу показывает исходящее в конце ленты (до/вместо refetch). */
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

  const cacheKey = messageDecryptCacheKey(dto);
  messageThreadDecryptCache.setMessage(
    cacheKey,
    rowFromPlaintext(dto, plain, params.replyTo),
  );

  const patch: OutgoingConversationPatch = {
    conversationUuid: params.conversationUuid,
    encryptedForMe: dto.encryptedPayload,
    createdAt: dto.createdAt,
  };
  params.queryClient.setQueryData<MsgConversationsPage>(["conversations"], (old) =>
    old ? { ...old, items: applyOutgoingToConversations(old.items, patch) } : old,
  );
  messagePreviewCache.set(
    params.conversationUuid,
    messagePreviewKey(dto.encryptedPayload, dto.createdAt),
    plaintextToPreview(plain),
  );

  const queryKey = ["messages", params.conversationUuid, params.otherUserUuid?.trim() || ""] as const;
  type MessagesQuery = { items: MsgMessageDto[]; nextCursor: string | null };
  params.queryClient.setQueryData<MessagesQuery>(queryKey, (old) => {
    const prev = old?.items ?? messageThreadCache.get(params.conversationUuid) ?? [];
    if (prev.some((m) => m.messageUuid === dto.messageUuid)) {
      messageThreadCache.set(params.conversationUuid, prev);
      return old ?? { items: prev, nextCursor: null };
    }
    const next = [...prev, dto];
    messageThreadCache.set(params.conversationUuid, next);
    return { items: next, nextCursor: old?.nextCursor ?? null };
  });
}
