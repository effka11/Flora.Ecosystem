import type { FscpMessagePlaintext, FscpMessageReplyRef } from "@/lib/fscp";
import type { MessageThreadItemDto } from "@/lib/socialApi";
import { plaintextToPreview } from "./messageBlocks";

export type MessageReplyDraft = FscpMessageReplyRef;

export function replyDraftFromMessage(
  message: MessageThreadItemDto,
  content: FscpMessagePlaintext | "decrypting" | "failed",
  peerDisplayName: string,
): MessageReplyDraft | null {
  if (content === "decrypting" || content === "failed") return null;
  return {
    messageUuid: message.messageUuid,
    authorDisplayName: message.isFromMe ? "Вы" : peerDisplayName,
    preview: plaintextToPreview(content),
  };
}

export function attachReplyToPayload(
  payload: FscpMessagePlaintext,
  reply: MessageReplyDraft,
): FscpMessagePlaintext {
  return { ...payload, replyTo: reply };
}
