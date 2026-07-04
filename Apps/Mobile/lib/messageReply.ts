import type { FscpMessageReplyRef } from "@flora/client-core/fscp";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";

export type MessageReplyDraft = FscpMessageReplyRef;

export function replyDraftFromMessage(
  message: Pick<ThreadBubbleItem, "messageUuid" | "isFromMe">,
  previewText: string,
  peerDisplayName: string,
): MessageReplyDraft | null {
  const trimmed = previewText.trim();
  if (!trimmed) return null;
  return {
    messageUuid: message.messageUuid,
    authorDisplayName: message.isFromMe ? "Вы" : peerDisplayName,
    preview: trimmed,
  };
}
