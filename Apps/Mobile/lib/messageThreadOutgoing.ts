import type { MsgMessageDto, MsgSentMessageDto } from "@flora/client-core/contracts";
import type { FscpMessageBlock } from "@flora/client-core/fscp";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  messagePlaintextFromBlocks,
} from "@flora/client-core/fscp";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { messageDecryptCacheKey } from "@/lib/useThreadMessageDecrypt";
import { messageThreadCache, messageThreadDecryptCache } from "@/stores/messageThreadCache";

function rowFromBlocks(message: MsgMessageDto, blocks: FscpMessageBlock[]): ThreadBubbleItem {
  const plain = messagePlaintextFromBlocks(blocks, message.createdAt);
  return {
    messageUuid: message.messageUuid,
    text: extractTextFromPlaintext(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
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

  const cacheKey = messageDecryptCacheKey(dto);
  messageThreadDecryptCache.setMessage(cacheKey, rowFromBlocks(dto, params.blocks));

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
